import { join } from "node:path";
import type { ServerWebSocket } from "bun";
import { serve, spawnSync } from "bun";
import {
  acknowledgeBridgeDelivery,
  readNextPendingBridgeMessageForTarget,
} from "./bridge-dispatch";
import { formatCodexBridgeMessage } from "./bridge-message-format";
import { clearStaleTmuxBridgeState } from "./bridge-runtime";
import type { BridgeMessage } from "./bridge-store";
import { LOOP_VERSION } from "./constants";
import { findFreePort } from "./ports";
import {
  isActiveRunState,
  readRunManifest,
  touchRunManifest,
  updateRunManifest,
} from "./run-state";
import { connectWs, type WsClient } from "./ws-client";

const CODEX_PROXY_BASE_PORT = 4600;
const CODEX_PROXY_PORT_RANGE = 100;
const DRAIN_DELAY_MS = 250;
const HEALTH_POLL_DELAY_MS = 150;
const HEALTH_POLL_RETRIES = 40;
const PROXY_STARTUP_GRACE_MS = 10_000;
const PROXY_UPSTREAM_INIT_TIMEOUT_MS = 5000;
const PROXY_UPSTREAM_RECONNECT_BASE_DELAY_MS = 250;
const PROXY_UPSTREAM_RECONNECT_MAX_ATTEMPTS = 40;
const PROXY_UPSTREAM_RECONNECT_MAX_DELAY_MS = 2000;
const BRIDGE_REQUEST_ID_PREFIX = "proxy-bridge-";
const INITIALIZE_METHOD = "initialize";
const INITIALIZED_METHOD = "initialized";
const THREAD_READ_METHOD = "thread/read";
const THREAD_RESUME_METHOD = "thread/resume";
const THREAD_START_METHOD = "thread/start";
const TURN_COMPLETED_METHOD = "turn/completed";
const TURN_STARTED_METHOD = "turn/started";
const TURN_START_METHOD = "turn/start";
const TURN_STEER_METHOD = "turn/steer";
const USER_INPUT_TEXT_ELEMENTS = "text_elements";
const DEBUG_PROXY = process.env.LOOP_DEBUG_PROXY === "1";

export const CODEX_TMUX_PROXY_SUBCOMMAND = "__codex-tmux-proxy";

interface ProxySocketData {
  connId: number;
}

interface JsonFrame {
  error?: unknown;
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
}

interface ProxyRoute {
  clientId: number | string;
  connId: number;
  method?: string;
  threadId?: string;
}

interface BridgeRequest {
  message: BridgeMessage;
  method: string;
}

interface PendingUpstreamRequest {
  reject: (error: Error) => void;
  resolve: (frame: JsonFrame) => void;
  timeout: ReturnType<typeof setTimeout>;
}

type StopReason = "dead-tmux" | "inactive-run";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const asRecord = (value: unknown): Record<string, unknown> =>
  (isRecord(value) ? value : {}) as Record<string, unknown>;

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const asNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isInteger(value) ? value : undefined;

const asJsonFrame = (value: string): JsonFrame | undefined => {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{")) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!isRecord(parsed)) {
      return undefined;
    }
    return parsed as JsonFrame;
  } catch {
    return undefined;
  }
};

const buildInput = (prompt: string): Record<string, unknown>[] => [
  {
    type: "text",
    text: prompt,
    [USER_INPUT_TEXT_ELEMENTS]: [],
  },
];

const bridgeMessageId = (
  value: number | string | undefined
): string | undefined => {
  const text = asString(value);
  return text?.startsWith(BRIDGE_REQUEST_ID_PREFIX) ? text : undefined;
};

const buildProxyUrl = (port: number): string => `ws://127.0.0.1:${port}/`;

const wait = async (ms: number): Promise<void> => {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
};

const debugProxy = (message: string): void => {
  if (DEBUG_PROXY) {
    console.error(`[loop-proxy] ${message}`);
  }
};

const extractTurnId = (value: unknown): string | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }
  const turn = isRecord(value.turn) ? value.turn : undefined;
  return asString(value.turnId) ?? asString(turn?.id);
};

const extractThreadId = (value: unknown): string | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }
  const thread = isRecord(value.thread) ? value.thread : undefined;
  return asString(thread?.id) ?? asString(value.threadId);
};

const extractActiveTurnId = (value: unknown): string | undefined => {
  const thread = isRecord(asRecord(value).thread) ? asRecord(value).thread : {};
  if (!Array.isArray(thread.turns)) {
    return undefined;
  }
  for (let index = thread.turns.length - 1; index >= 0; index -= 1) {
    const turn = isRecord(thread.turns[index])
      ? thread.turns[index]
      : undefined;
    if (turn && asString(turn.status) === "inProgress") {
      return asString(turn.id);
    }
  }
  return undefined;
};

const parseErrorText = (value: unknown): string | undefined => {
  const record = isRecord(value) ? value : {};
  const error = isRecord(record.error) ? record.error : {};
  return (
    asString(error.message) ||
    asString(record.message) ||
    asString(record.reason)
  );
};

const isBusyTurnError = (value: unknown): boolean => {
  const message = parseErrorText(value)?.toLowerCase() ?? "";
  return (
    message.includes("active turn") ||
    message.includes("already active") ||
    message.includes("busy") ||
    message.includes("in progress") ||
    message.includes("turn still active")
  );
};

const latestActiveTurnId = (turnIds: Set<string>): string | undefined => {
  let latest: string | undefined;
  for (const turnId of turnIds) {
    latest = turnId;
  }
  return latest;
};

const shouldPauseBridgeDrain = (
  turnInProgress: boolean,
  activeTurnId: string | undefined,
  pendingBridgeRequests: number
): boolean => {
  if (pendingBridgeRequests > 0) {
    return true;
  }
  return turnInProgress && !activeTurnId;
};

const persistCodexThreadId = (runDir: string, threadId: string): void => {
  if (!threadId) {
    return;
  }
  updateRunManifest(join(runDir, "manifest.json"), (manifest) => {
    if (!manifest || manifest.codexThreadId === threadId) {
      return manifest;
    }
    return touchRunManifest(
      {
        ...manifest,
        codexThreadId: threadId,
      },
      new Date().toISOString()
    );
  });
};

const buildBridgeInjectionFrame = (
  requestId: string,
  threadId: string,
  message: BridgeMessage,
  activeTurnId?: string
): JsonFrame => {
  if (activeTurnId) {
    return {
      id: requestId,
      method: TURN_STEER_METHOD,
      params: {
        expectedTurnId: activeTurnId,
        input: buildInput(
          formatCodexBridgeMessage(message.source, message.message, message.id)
        ),
        threadId,
      },
    };
  }
  return {
    id: requestId,
    method: TURN_START_METHOD,
    params: {
      input: buildInput(
        formatCodexBridgeMessage(message.source, message.message, message.id)
      ),
      threadId,
    },
  };
};

const noteStartedTurn = (turnIds: Set<string>, value: unknown): void => {
  const turnId = extractTurnId(value);
  if (turnId) {
    turnIds.add(turnId);
  }
};

const isTmuxSessionAlive = (session: string): boolean => {
  if (!session) {
    return false;
  }
  const result = spawnSync(["tmux", "has-session", "-t", session], {
    stderr: "ignore",
    stdout: "ignore",
  });
  return result.exitCode === 0;
};

const shouldStopForTmuxSession = (
  sessionAlive: boolean,
  sawTmuxSession: boolean,
  startupDeadlineMs: number,
  nowMs: number
): boolean => {
  if (sessionAlive) {
    return false;
  }
  if (!sawTmuxSession && nowMs < startupDeadlineMs) {
    return false;
  }
  return true;
};

const proxyInitializeResponse = (
  id: number | string | undefined
): JsonFrame => {
  return {
    id,
    result: {
      platformFamily: "unix",
      platformOs: process.platform === "darwin" ? "macos" : process.platform,
      userAgent: "loop-tmux-proxy/1.0.0",
    },
  };
};

const proxyErrorFrame = (
  id: number | string,
  message: string
): Record<string, unknown> => ({
  error: { message },
  id,
});

const proxyHealth = (
  upstreamConnected: boolean,
  reconnecting: boolean
): { body: string; status?: number } => {
  if (upstreamConnected) {
    return { body: "ok" };
  }
  return reconnecting
    ? { body: "reconnecting", status: 503 }
    : { body: "not ready", status: 503 };
};

const reconnectDelayMs = (attempt: number): number =>
  Math.min(
    PROXY_UPSTREAM_RECONNECT_BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1),
    PROXY_UPSTREAM_RECONNECT_MAX_DELAY_MS
  );

class CodexTmuxProxy {
  private readonly activeTurnIds = new Set<string>();
  private readonly bridgeRequests = new Map<string, BridgeRequest>();
  private readonly port: number;
  private remoteUrl: string;
  private readonly routes = new Map<number, ProxyRoute>();
  private readonly runDir: string;
  private readonly upstreamRequests = new Map<string, PendingUpstreamRequest>();
  private currentConnId = 0;
  private drainTimer: ReturnType<typeof setInterval> | undefined;
  private initialized = false;
  private nextBridgeRequestId = 1;
  private nextProxyId = 100_000;
  private proxyServer: ReturnType<typeof serve> | undefined;
  private reconnectAttemptCount = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private reconnecting = false;
  private resolveStopped = () => undefined;
  private sawTmuxSession = false;
  private stopped = false;
  private readonly startupDeadlineMs = Date.now() + PROXY_STARTUP_GRACE_MS;
  private threadId: string;
  private turnInProgress = false;
  private tuiSocket: ServerWebSocket<ProxySocketData> | undefined;
  private upstream: WsClient | undefined;
  private readonly stoppedPromise: Promise<void>;

  constructor(
    runDir: string,
    remoteUrl: string,
    threadId: string,
    port: number
  ) {
    this.port = port;
    this.remoteUrl = remoteUrl;
    this.runDir = runDir;
    this.threadId = threadId;
    this.stoppedPromise = new Promise((resolve) => {
      this.resolveStopped = resolve;
    });
  }

  async start(): Promise<void> {
    await this.connectUpstream();
    this.proxyServer = serve({
      fetch: (request, server) => {
        const path = new URL(request.url).pathname;
        if (path === "/healthz" || path === "/readyz") {
          const health = proxyHealth(Boolean(this.upstream), this.reconnecting);
          return new Response(
            health.body,
            health.status ? { status: health.status } : undefined
          );
        }
        if (server.upgrade(request, { data: { connId: 0 } })) {
          return undefined;
        }
        return new Response("loop Codex tmux proxy");
      },
      hostname: "127.0.0.1",
      port: this.port,
      websocket: {
        close: (ws) => {
          if (this.tuiSocket === ws) {
            this.tuiSocket = undefined;
          }
        },
        message: (ws, message) => {
          const payload =
            typeof message === "string" ? message : message.toString();
          if (ws.data.connId !== this.currentConnId) {
            return;
          }
          for (const raw of payload.split("\n")) {
            if (raw.trim()) {
              this.handleTuiFrame(raw);
            }
          }
        },
        open: (ws) => {
          this.currentConnId += 1;
          this.initialized = false;
          ws.data.connId = this.currentConnId;
          this.tuiSocket = ws;
        },
      },
    });
    this.drainTimer = setInterval(() => {
      this.drainBridgeMessages();
    }, DRAIN_DELAY_MS);
    this.drainTimer.unref?.();
  }

  async wait(): Promise<void> {
    await this.stoppedPromise;
  }

  stop(): void {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    if (this.drainTimer) {
      clearInterval(this.drainTimer);
      this.drainTimer = undefined;
    }
    this.proxyServer?.stop(true);
    this.proxyServer = undefined;
    this.tuiSocket = undefined;
    this.upstream?.close();
    this.upstream = undefined;
    this.resolveStopped();
  }

  private forwardToTui(raw: string): void {
    this.tuiSocket?.send(raw);
  }

  private forwardToUpstream(frame: JsonFrame): void {
    this.upstream?.send(`${JSON.stringify(frame)}\n`);
  }

  private resolveRemoteUrl(): string {
    const manifest = readRunManifest(join(this.runDir, "manifest.json"));
    const nextUrl = manifest?.codexRemoteUrl || this.remoteUrl;
    if (nextUrl) {
      this.remoteUrl = nextUrl;
    }
    return this.remoteUrl;
  }

  private resolveThreadId(): string {
    const manifest = readRunManifest(join(this.runDir, "manifest.json"));
    const nextThreadId = manifest?.codexThreadId || this.threadId;
    if (nextThreadId) {
      this.threadId = nextThreadId;
    }
    return this.threadId;
  }

  private attachUpstream(ws: WsClient): void {
    this.upstream = ws;
    this.reconnecting = false;
    this.reconnectAttemptCount = 0;
    ws.onmessage = (data) => {
      for (const raw of data.split("\n")) {
        if (raw.trim()) {
          this.handleUpstreamFrame(raw);
        }
      }
    };
    ws.onclose = () => {
      if (this.upstream !== ws) {
        return;
      }
      this.handleUpstreamDisconnect();
    };
  }

  private async initializeUpstream(ws: WsClient): Promise<void> {
    const requestId = `proxy-initialize-${Date.now()}-${this.nextProxyId++}`;
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("codex tmux proxy upstream initialize timed out"));
      }, PROXY_UPSTREAM_INIT_TIMEOUT_MS);
      const finish = (error?: Error): void => {
        clearTimeout(timeout);
        ws.onclose = undefined;
        ws.onmessage = undefined;
        if (error) {
          reject(error);
          return;
        }
        resolve();
      };
      ws.onclose = () => {
        finish(new Error("codex tmux proxy upstream closed during initialize"));
      };
      ws.onmessage = (data) => {
        for (const raw of data.split("\n")) {
          if (!raw.trim()) {
            continue;
          }
          const frame = asJsonFrame(raw);
          if (!frame || String(frame.id) !== requestId) {
            continue;
          }
          if (frame.error) {
            finish(new Error("codex tmux proxy upstream initialize failed"));
            return;
          }
          ws.send(
            `${JSON.stringify({
              jsonrpc: "2.0",
              method: INITIALIZED_METHOD,
            })}\n`
          );
          finish();
          return;
        }
      };
      ws.send(
        `${JSON.stringify({
          id: requestId,
          method: INITIALIZE_METHOD,
          params: {
            capabilities: { experimentalApi: true },
            clientInfo: {
              name: "loop-tmux-proxy",
              title: "loop-tmux-proxy",
              version: LOOP_VERSION,
            },
          },
        })}\n`
      );
    });
  }

  private async connectUpstream(): Promise<void> {
    const ws = await connectWs(this.resolveRemoteUrl());
    try {
      await this.initializeUpstream(ws);
    } catch (error) {
      try {
        ws.close();
      } catch {
        // ignore close errors
      }
      throw error;
    }
    this.attachUpstream(ws);
    await this.refreshActiveTurnState().catch(() => undefined);
  }

  private sendUpstreamRequest(
    method: string,
    params: Record<string, unknown>
  ): Promise<JsonFrame> {
    if (!this.upstream) {
      throw new Error("codex app-server upstream is not connected");
    }
    const requestId = `proxy-${method}-${Date.now()}-${this.nextProxyId++}`;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.upstreamRequests.delete(requestId);
        reject(new Error(`codex tmux proxy upstream ${method} timed out`));
      }, PROXY_UPSTREAM_INIT_TIMEOUT_MS);
      this.upstreamRequests.set(requestId, { reject, resolve, timeout });
      this.upstream?.send(
        `${JSON.stringify({
          id: requestId,
          method,
          params,
        })}\n`
      );
    });
  }

  private async refreshActiveTurnState(): Promise<void> {
    if (!(this.threadId && this.upstream)) {
      this.activeTurnIds.clear();
      this.turnInProgress = false;
      return;
    }
    const frame = await this.sendUpstreamRequest(THREAD_READ_METHOD, {
      includeTurns: true,
      threadId: this.threadId,
    });
    this.activeTurnIds.clear();
    const activeTurnId = extractActiveTurnId(frame.result);
    debugProxy(
      `thread/read thread=${this.threadId} activeTurn=${activeTurnId ?? "none"}`
    );
    if (activeTurnId) {
      this.activeTurnIds.add(activeTurnId);
      this.turnInProgress = true;
      return;
    }
    this.turnInProgress = false;
  }

  private async refreshActiveTurnStateAfterBusyError(): Promise<void> {
    try {
      await this.refreshActiveTurnState();
    } catch {
      this.turnInProgress = false;
    }
  }

  private failPendingRoutes(message: string): void {
    for (const route of this.routes.values()) {
      if (route.connId !== this.currentConnId) {
        continue;
      }
      this.forwardToTui(
        JSON.stringify(proxyErrorFrame(route.clientId, message))
      );
    }
    this.routes.clear();
  }

  private clearUpstreamState(): void {
    this.failPendingRoutes("codex app-server upstream disconnected");
    this.bridgeRequests.clear();
    for (const request of this.upstreamRequests.values()) {
      clearTimeout(request.timeout);
      request.reject(new Error("codex app-server upstream disconnected"));
    }
    this.upstreamRequests.clear();
    this.activeTurnIds.clear();
    this.turnInProgress = false;
  }

  private scheduleReconnect(): void {
    if (
      this.stopped ||
      this.upstream ||
      this.reconnectTimer ||
      this.reconnectAttemptCount >= PROXY_UPSTREAM_RECONNECT_MAX_ATTEMPTS
    ) {
      if (
        !(this.stopped || this.upstream) &&
        this.reconnectAttemptCount >= PROXY_UPSTREAM_RECONNECT_MAX_ATTEMPTS
      ) {
        this.stop();
      }
      return;
    }
    this.reconnecting = true;
    this.reconnectAttemptCount += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.tryReconnect().catch(() => undefined);
    }, reconnectDelayMs(this.reconnectAttemptCount));
    this.reconnectTimer.unref?.();
  }

  private async tryReconnect(): Promise<void> {
    if (this.stopped || this.upstream) {
      return;
    }
    const stopReason = this.stopReason();
    if (stopReason) {
      if (stopReason === "dead-tmux") {
        clearStaleTmuxBridgeState(this.runDir);
      }
      this.stop();
      return;
    }
    try {
      await this.connectUpstream();
    } catch {
      this.scheduleReconnect();
    }
  }

  private handleUpstreamDisconnect(): void {
    if (this.stopped) {
      return;
    }
    this.upstream = undefined;
    this.clearUpstreamState();
    const stopReason = this.stopReason();
    if (stopReason) {
      if (stopReason === "dead-tmux") {
        clearStaleTmuxBridgeState(this.runDir);
      }
      this.stop();
      return;
    }
    this.scheduleReconnect();
  }

  private rememberThreadId(threadId: string | undefined): void {
    if (!threadId || threadId === this.threadId) {
      return;
    }
    this.threadId = threadId;
    persistCodexThreadId(this.runDir, threadId);
  }

  private handleTuiFrame(raw: string): void {
    const frame = asJsonFrame(raw);
    if (!(frame?.method && frame.id !== undefined)) {
      this.upstream?.send(raw);
      return;
    }
    if (frame.method === INITIALIZE_METHOD) {
      this.initialized = true;
      this.forwardToTui(JSON.stringify(proxyInitializeResponse(frame.id)));
      return;
    }
    if (!this.upstream) {
      this.forwardToTui(
        JSON.stringify(
          proxyErrorFrame(frame.id, "codex app-server is reconnecting")
        )
      );
      return;
    }

    const proxyId = this.nextProxyId++;
    this.routes.set(proxyId, {
      clientId: frame.id,
      connId: this.currentConnId,
      method: frame.method,
      threadId: this.resolveThreadForMethod(frame.method, frame.params),
    });
    if (frame.method === TURN_START_METHOD) {
      this.turnInProgress = true;
    }
    frame.id = proxyId;
    this.upstream?.send(`${JSON.stringify(frame)}\n`);
  }

  private resolveThreadForMethod(
    method: string,
    params: unknown
  ): string | undefined {
    if (!isRecord(params)) {
      return undefined;
    }
    if (method === TURN_START_METHOD) {
      return asString(params.threadId);
    }
    if (method === THREAD_RESUME_METHOD) {
      return asString(params.threadId);
    }
    return undefined;
  }

  private handleUpstreamFrame(raw: string): void {
    const frame = asJsonFrame(raw);
    if (!frame) {
      this.forwardToTui(raw);
      return;
    }

    if (typeof frame.method === "string") {
      this.handleNotification(frame);
      this.forwardToTui(raw);
      return;
    }

    const upstreamRequestId = asString(frame.id);
    if (upstreamRequestId) {
      const request = this.upstreamRequests.get(upstreamRequestId);
      if (request) {
        this.upstreamRequests.delete(upstreamRequestId);
        clearTimeout(request.timeout);
        if (frame.error) {
          request.reject(
            new Error(
              parseErrorText(frame.error) ??
                `codex tmux proxy upstream ${upstreamRequestId} failed`
            )
          );
        } else {
          request.resolve(frame);
        }
        return;
      }
    }

    const bridgeId = bridgeMessageId(frame.id);
    if (bridgeId !== undefined) {
      debugProxy(
        `bridge response id=${bridgeId} error=${parseErrorText(frame.error) ?? "none"}`
      );
      this.handleBridgeResponse(bridgeId, frame);
      return;
    }

    const proxyId = asNumber(frame.id);
    if (proxyId === undefined) {
      this.forwardToTui(raw);
      return;
    }

    const route = this.routes.get(proxyId);
    if (!route) {
      return;
    }
    this.routes.delete(proxyId);

    if (route.connId !== this.currentConnId) {
      return;
    }

    this.handleTrackedResponse(route, frame);
    frame.id = route.clientId;
    this.forwardToTui(JSON.stringify(frame));
  }

  private handleTrackedResponse(route: ProxyRoute, frame: JsonFrame): void {
    if (frame.error && route.method === TURN_START_METHOD) {
      this.turnInProgress = false;
      return;
    }

    if (
      !frame.error &&
      (route.method === THREAD_START_METHOD ||
        route.method === THREAD_RESUME_METHOD)
    ) {
      this.rememberThreadId(
        extractThreadId(frame.result) ?? route.threadId ?? this.threadId
      );
      return;
    }

    if (!frame.error && route.method === TURN_START_METHOD) {
      this.rememberThreadId(route.threadId ?? this.threadId);
      noteStartedTurn(this.activeTurnIds, frame.result);
      this.turnInProgress = true;
    }
  }

  private handleBridgeResponse(id: string, frame: JsonFrame): void {
    const request = this.bridgeRequests.get(id);
    if (!request) {
      return;
    }
    this.bridgeRequests.delete(id);
    if (frame.error) {
      if (request.method === TURN_STEER_METHOD) {
        this.activeTurnIds.clear();
        this.turnInProgress = false;
        return;
      }
      if (
        request.method === TURN_START_METHOD &&
        isBusyTurnError(frame.error)
      ) {
        this.turnInProgress = true;
        this.refreshActiveTurnStateAfterBusyError();
        return;
      }
      this.turnInProgress = this.activeTurnIds.size > 0;
      return;
    }
    if (request.method === TURN_START_METHOD) {
      noteStartedTurn(this.activeTurnIds, frame.result);
      this.turnInProgress = true;
    }
    acknowledgeBridgeDelivery(
      this.runDir,
      request.message,
      "sent to codex tmux proxy"
    );
  }

  private handleNotification(frame: JsonFrame): void {
    if (frame.method === TURN_STARTED_METHOD) {
      const turnId = extractTurnId(frame.params);
      if (turnId) {
        this.activeTurnIds.add(turnId);
      }
      this.turnInProgress = true;
      return;
    }

    if (frame.method === TURN_COMPLETED_METHOD) {
      const turnId = extractTurnId(frame.params);
      if (turnId) {
        this.activeTurnIds.delete(turnId);
      } else {
        this.activeTurnIds.clear();
      }
      this.turnInProgress = this.activeTurnIds.size > 0;
    }
  }

  private stopReason(): StopReason | undefined {
    const manifest = readRunManifest(join(this.runDir, "manifest.json"));
    if (!(manifest && isActiveRunState(manifest.state))) {
      return "inactive-run";
    }
    const sessionAlive = manifest.tmuxSession
      ? isTmuxSessionAlive(manifest.tmuxSession)
      : false;
    if (sessionAlive) {
      this.sawTmuxSession = true;
      return undefined;
    }
    return shouldStopForTmuxSession(
      sessionAlive,
      this.sawTmuxSession,
      this.startupDeadlineMs,
      Date.now()
    )
      ? "dead-tmux"
      : undefined;
  }

  private drainBridgeMessages(): void {
    if (this.stopped) {
      return;
    }
    const stopReason = this.stopReason();
    if (stopReason) {
      if (stopReason === "dead-tmux") {
        clearStaleTmuxBridgeState(this.runDir);
      }
      this.stop();
      return;
    }
    const threadId = this.resolveThreadId();
    if (!(this.initialized && threadId && this.tuiSocket && this.upstream)) {
      return;
    }
    const activeTurnId = latestActiveTurnId(this.activeTurnIds);
    if (
      shouldPauseBridgeDrain(
        this.turnInProgress,
        activeTurnId,
        this.bridgeRequests.size
      )
    ) {
      return;
    }
    const message = readNextPendingBridgeMessageForTarget(this.runDir, "codex");
    if (!message) {
      return;
    }

    const requestId = `${BRIDGE_REQUEST_ID_PREFIX}${this.nextBridgeRequestId++}`;
    const frame = buildBridgeInjectionFrame(
      requestId,
      threadId,
      message,
      activeTurnId
    );
    this.bridgeRequests.set(requestId, {
      message,
      method: frame.method ?? TURN_START_METHOD,
    });
    this.turnInProgress = true;
    debugProxy(
      `bridge send id=${requestId} method=${frame.method ?? TURN_START_METHOD} thread=${this.threadId}`
    );
    this.forwardToUpstream(frame);
  }
}

export const findCodexTmuxProxyPort = (): Promise<number> =>
  findFreePort(CODEX_PROXY_BASE_PORT, CODEX_PROXY_PORT_RANGE);

export const waitForCodexTmuxProxy = async (port: number): Promise<string> => {
  const url = `http://127.0.0.1:${port}/readyz`;
  for (let attempt = 0; attempt < HEALTH_POLL_RETRIES; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return buildProxyUrl(port);
      }
    } catch {
      // keep polling
    }
    await wait(HEALTH_POLL_DELAY_MS);
  }
  throw new Error("[loop] Codex tmux proxy failed to start");
};

export const runCodexTmuxProxy = async (
  runDir: string,
  remoteUrl: string,
  threadId: string,
  port: number
): Promise<void> => {
  const proxy = new CodexTmuxProxy(runDir, remoteUrl, threadId, port);
  const shutdown = (): void => {
    proxy.stop();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  await proxy.start();
  await proxy.wait();
};

export const codexTmuxProxyInternals = {
  buildBridgeInjectionFrame,
  reconnectDelayMs,
  proxyHealth,
  latestActiveTurnId,
  buildProxyUrl,
  noteStartedTurn,
  proxyInitializeResponse,
  persistCodexThreadId,
  shouldPauseBridgeDrain,
  shouldStopForTmuxSession,
};
