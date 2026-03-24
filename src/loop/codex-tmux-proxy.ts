import { join } from "node:path";
import type { ServerWebSocket } from "bun";
import { serve, spawnSync } from "bun";
import {
  type BridgeMessage,
  markBridgeMessage,
  readPendingBridgeMessages,
} from "./bridge";
import { findFreePort } from "./ports";
import { isActiveRunState, readRunManifest } from "./run-state";
import { connectWs, type WsClient } from "./ws-client";

const CODEX_PROXY_BASE_PORT = 4600;
const CODEX_PROXY_PORT_RANGE = 100;
const DRAIN_DELAY_MS = 250;
const HEALTH_POLL_DELAY_MS = 150;
const HEALTH_POLL_RETRIES = 40;
const PROXY_STARTUP_GRACE_MS = 10_000;
const INITIALIZE_METHOD = "initialize";
const THREAD_RESUME_METHOD = "thread/resume";
const THREAD_START_METHOD = "thread/start";
const TURN_COMPLETED_METHOD = "turn/completed";
const TURN_STARTED_METHOD = "turn/started";
const TURN_START_METHOD = "turn/start";
const USER_INPUT_TEXT_ELEMENTS = "text_elements";

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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

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
): number | undefined => {
  const numeric = asNumber(value);
  return numeric !== undefined && numeric < 0 ? numeric : undefined;
};

const buildProxyUrl = (port: number): string => `ws://127.0.0.1:${port}/`;

const wait = async (ms: number): Promise<void> => {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
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

const patchInitializeError = (frame: JsonFrame): JsonFrame => {
  const error = isRecord(frame.error) ? frame.error : undefined;
  const message = asString(error?.message)?.toLowerCase() ?? "";
  if (!message.includes("already initialized")) {
    return frame;
  }
  return {
    id: frame.id,
    result: {
      platformFamily: "unix",
      platformOs: process.platform === "darwin" ? "macos" : process.platform,
      userAgent: "loop-tmux-proxy/1.0.0",
    },
  };
};

class CodexTmuxProxy {
  private readonly activeTurnIds = new Set<string>();
  private readonly bridgeRequests = new Map<number, BridgeMessage>();
  private readonly port: number;
  private readonly remoteUrl: string;
  private readonly routes = new Map<number, ProxyRoute>();
  private readonly runDir: string;
  private currentConnId = 0;
  private drainTimer: ReturnType<typeof setInterval> | undefined;
  private initialized = false;
  private nextBridgeRequestId = -1;
  private nextProxyId = 100_000;
  private proxyServer: ReturnType<typeof serve> | undefined;
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
    this.upstream = await connectWs(this.remoteUrl);
    this.upstream.onmessage = (data) => {
      for (const raw of data.split("\n")) {
        if (raw.trim()) {
          this.handleUpstreamFrame(raw);
        }
      }
    };
    this.upstream.onclose = () => {
      this.stop();
    };
    this.proxyServer = serve({
      fetch: (request, server) => {
        const path = new URL(request.url).pathname;
        if (path === "/healthz" || path === "/readyz") {
          return new Response(
            this.upstream ? "ok" : "not ready",
            this.upstream ? undefined : { status: 503 }
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

  private handleTuiFrame(raw: string): void {
    const frame = asJsonFrame(raw);
    if (!(frame?.method && frame.id !== undefined)) {
      this.upstream?.send(raw);
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

    const bridgeId = bridgeMessageId(frame.id);
    if (bridgeId !== undefined) {
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
    const response =
      route.method === INITIALIZE_METHOD ? patchInitializeError(frame) : frame;
    this.forwardToTui(JSON.stringify(response));
  }

  private handleTrackedResponse(route: ProxyRoute, frame: JsonFrame): void {
    if (frame.error && route.method === TURN_START_METHOD) {
      this.turnInProgress = false;
      return;
    }

    if (route.method === INITIALIZE_METHOD && !frame.error) {
      this.initialized = true;
      return;
    }

    if (
      !frame.error &&
      (route.method === THREAD_START_METHOD ||
        route.method === THREAD_RESUME_METHOD)
    ) {
      this.threadId =
        extractThreadId(frame.result) ?? route.threadId ?? this.threadId;
      return;
    }

    if (!frame.error && route.method === TURN_START_METHOD) {
      this.threadId = route.threadId ?? this.threadId;
    }
  }

  private handleBridgeResponse(id: number, frame: JsonFrame): void {
    const message = this.bridgeRequests.get(id);
    if (!message) {
      return;
    }
    this.bridgeRequests.delete(id);
    if (frame.error) {
      this.turnInProgress = false;
      return;
    }
    markBridgeMessage(
      this.runDir,
      message,
      "delivered",
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

  private shouldStop(): boolean {
    const manifest = readRunManifest(join(this.runDir, "manifest.json"));
    if (!(manifest && isActiveRunState(manifest.state))) {
      return true;
    }
    const sessionAlive = manifest.tmuxSession
      ? isTmuxSessionAlive(manifest.tmuxSession)
      : false;
    if (sessionAlive) {
      this.sawTmuxSession = true;
    }
    return shouldStopForTmuxSession(
      sessionAlive,
      this.sawTmuxSession,
      this.startupDeadlineMs,
      Date.now()
    );
  }

  private drainBridgeMessages(): void {
    if (this.stopped) {
      return;
    }
    if (this.shouldStop()) {
      this.stop();
      return;
    }
    if (
      !(this.initialized && this.threadId && this.tuiSocket && this.upstream)
    ) {
      return;
    }
    if (this.turnInProgress || this.bridgeRequests.size > 0) {
      return;
    }
    const message = readPendingBridgeMessages(this.runDir).find(
      (entry) => entry.target === "codex"
    );
    if (!message) {
      return;
    }

    const requestId = this.nextBridgeRequestId--;
    this.bridgeRequests.set(requestId, message);
    this.turnInProgress = true;
    this.forwardToUpstream({
      id: requestId,
      method: TURN_START_METHOD,
      params: {
        input: buildInput(message.message),
        threadId: this.threadId,
      },
    });
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
  buildProxyUrl,
  patchInitializeError,
  shouldStopForTmuxSession,
};
