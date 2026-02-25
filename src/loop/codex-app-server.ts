import { spawn } from "bun";
import { findFreePort } from "./ports";
import { DETACH_CHILD_PROCESS, killChildProcess } from "./process";
import type { Options, RunResult } from "./types";

type ExitSignal = "SIGINT" | "SIGTERM";
type TransportMode = "app-server" | "exec";
type Callback = (text: string) => void;
interface RunCodexTurnCallbacks {
  onParsed?: Callback;
  onRaw: Callback;
}

interface JsonFrame {
  error?: unknown;
  id?: unknown;
  method?: string;
  params?: unknown;
  result?: unknown;
}

interface PendingRequest {
  method: string;
  reject: (error: Error) => void;
  resolve: (value: unknown) => void;
  timeout: ReturnType<typeof setTimeout>;
}

interface TurnState {
  combined: string;
  lastChunk: string;
  onParsed: Callback;
  onRaw: Callback;
  parsed: string;
  reject: (error: Error) => void;
  resolve: (result: RunResult) => void;
}

const APP_SERVER_CMD = "codex";
const APP_SERVER_BASE_PORT = 4500;
const APP_SERVER_PORT_RANGE = 100;
const WS_CONNECT_ATTEMPTS = 40;
const WS_CONNECT_DELAY_MS = 150;
const USER_INPUT_TEXT_ELEMENTS = "text_elements";
const WAIT_TIMEOUT_MS = 600_000;
const NOOP_CALLBACK: Callback = () => undefined;

export const CODEX_TRANSPORT_APP_SERVER: TransportMode = "app-server";
export const CODEX_TRANSPORT_EXEC: TransportMode = "exec";
export const CODEX_TRANSPORT_ENV = "CODEX_TRANSPORT";
export const DEFAULT_CODEX_TRANSPORT: TransportMode =
  CODEX_TRANSPORT_APP_SERVER;

const METHOD_INITIALIZE = "initialize";
const METHOD_THREAD_START = "thread/start";
const METHOD_TURN_START = "turn/start";
const METHOD_TURN_COMPLETED = "turn/completed";
const METHOD_ERROR = "error";
const METHOD_ITEM_COMPLETED = "item/completed";
const METHOD_ITEM_DELTA = "item/agentMessage/delta";
const METHOD_COMMAND_APPROVAL = "item/commandExecution/requestApproval";
const METHOD_FILE_CHANGE_APPROVAL = "item/fileChange/requestApproval";
const METHOD_TOOL_USER_INPUT = "item/tool/requestUserInput";
const METHOD_TOOL_CALL = "item/tool/call";
const METHOD_APPLY_PATCH_APPROVAL = "applyPatchApproval";
const METHOD_EXEC_COMMAND_APPROVAL = "execCommandApproval";
const METHOD_AUTH_REFRESH = "account/chatgptAuthTokens/refresh";
const METHODS_TRIGGERING_FALLBACK = new Set([
  METHOD_INITIALIZE,
  METHOD_THREAD_START,
  METHOD_TURN_START,
]);

type SpawnFn = (...args: Parameters<typeof spawn>) => ReturnType<typeof spawn>;
type ConnectWsFn = (url: string) => Promise<import("./ws-client").WsClient>;

let spawnFn: SpawnFn = spawn;
const defaultConnectWs: ConnectWsFn = async (url) => {
  const { connectWs } = await import("./ws-client");
  return connectWs(url);
};
let connectWsFn: ConnectWsFn = defaultConnectWs;

const isString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;
const asString = (value: unknown): string | undefined =>
  isString(value) ? value : undefined;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;
const asRecord = (value: unknown): Record<string, unknown> =>
  isRecord(value) ? value : {};
const asRequestId = (value: unknown): string | undefined => {
  if (typeof value === "number" && Number.isInteger(value)) {
    return String(value);
  }
  return isString(value) ? value : undefined;
};

const parseLine = (line: string): JsonFrame | undefined => {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(trimmed);
    return isRecord(parsed) ? (parsed as JsonFrame) : undefined;
  } catch {
    return undefined;
  }
};

const collectText = (value: unknown, out: string[]): void => {
  if (isString(value)) {
    out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectText(item, out);
    }
    return;
  }
  if (!isRecord(value)) {
    return;
  }
  const record = asRecord(value);
  const direct = asString(record.text) || asString(record.delta);
  if (direct) {
    out.push(direct);
  }
  collectText(record.content, out);
  collectText(record.item, out);
  collectText(record.payload, out);
};

const parseText = (value: unknown): string | undefined => {
  const parts: string[] = [];
  collectText(value, parts);
  return parts.length > 0
    ? parts
        .map((part) => part.trim())
        .filter(Boolean)
        .join("\n")
    : undefined;
};

const isUnsupportedTransportError = (error: unknown): boolean => {
  const message = parseErrorText(error)?.toLowerCase();
  return (
    !!message &&
    (message.includes("unsupported") ||
      message.includes("method not found") ||
      message.includes("unknown method") ||
      message.includes("unsupported transport"))
  );
};

const parseErrorText = (value: unknown): string | undefined => {
  const record = asRecord(value);
  const errorRecord = asRecord(record.error);
  const turn = asRecord(record.turn);
  const turnError = asRecord(turn.error);
  return (
    asString(errorRecord.message) ||
    asString(record.message) ||
    asString(record.reason) ||
    asString(turnError.message)
  );
};

const extractTurnId = (value: unknown): string | undefined => {
  const record = asRecord(value);
  const fromValue = asString(record.turnId) ?? asString(record.turn_id);
  if (fromValue) {
    return fromValue;
  }
  const turn = asRecord(record.turn);
  return asString(turn.id);
};

const extractThreadId = (value: unknown): string | undefined => {
  const record = asRecord(value);
  return asString(record.threadId) ?? asString(record.thread_id);
};

const extractThreadFromTurnStart = (value: unknown): { id?: string } => {
  const record = asRecord(value);
  const thread = asRecord(record.thread);
  return { id: asString(thread.id) };
};

const extractTurnFromStart = (value: unknown): { id?: string } => {
  const record = asRecord(value);
  const turn = asRecord(record.turn);
  return { id: asString(turn.id) || asString(record.id) };
};

const buildInput = (prompt: string): Record<string, unknown>[] => [
  {
    type: "text",
    text: prompt,
    [USER_INPUT_TEXT_ELEMENTS]: [],
  },
];

const toError = (value: Error | unknown): Error =>
  value instanceof Error ? value : new Error(String(value));

export class CodexAppServerFallbackError extends Error {}

export const codexAppServerInternals = {
  parseLine,
  parseText,
  extractTurnId,
  extractThreadId,
  parseErrorText,
  setSpawnFn: (next: SpawnFn): void => {
    spawnFn = next;
  },
  restoreSpawnFn: (): void => {
    spawnFn = spawn;
  },
  setConnectWsFn: (next: ConnectWsFn): void => {
    connectWsFn = next;
  },
  restoreConnectWsFn: (): void => {
    connectWsFn = defaultConnectWs;
  },
};

class AppServerClient {
  private child: ReturnType<typeof spawn> | undefined;
  private ws: import("./ws-client").WsClient | undefined;
  private closed = false;
  private started = false;
  private ready = false;
  private requestId = 1;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly turns = new Map<string, TurnState>();
  private lock: Promise<void> = Promise.resolve();

  get process(): ReturnType<typeof spawn> | undefined {
    return this.child;
  }

  hasProcess(): boolean {
    return this.child !== undefined;
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }
    this.started = true;
    try {
      const port = await this.findPort();
      const listenUrl = `ws://0.0.0.0:${port}`;
      const connectUrl = `ws://127.0.0.1:${port}`;
      const child = spawnFn(
        [APP_SERVER_CMD, "app-server", "--listen", listenUrl],
        {
          detached: DETACH_CHILD_PROCESS,
          env: process.env,
          stderr: "pipe",
          stdin: "pipe",
          stdout: "pipe",
        }
      );
      this.child = child;
      this.consumeFrames(child).finally(() => {
        if (!this.closed) {
          this.handleUnexpectedExit();
        }
      });
      const ws = await this.connectWebSocket(connectUrl);
      this.ws = ws;
      ws.onmessage = (data) => {
        for (const line of data.split("\n")) {
          if (line.trim()) {
            this.handleStdoutLine(line);
          }
        }
      };
      ws.onclose = () => {
        if (!this.closed) {
          this.handleUnexpectedExit();
        }
      };
      await this.sendRequest(METHOD_INITIALIZE, {
        clientInfo: {
          name: "loop",
          title: "loop",
          version: "1.0.3",
        },
        capabilities: { experimentalApi: true },
      });
      this.ready = true;
    } catch (error) {
      const ws = this.ws;
      this.ws = undefined;
      if (ws) {
        try {
          ws.close();
        } catch {
          // ignore close errors
        }
      }
      if (this.child) {
        killChildProcess(this.child, "SIGTERM");
        this.child = undefined;
      }
      this.ready = false;
      this.started = false;
      throw new CodexAppServerFallbackError(
        toError(error).message || "failed to start codex app-server"
      );
    }
  }

  private findPort(): Promise<number> {
    return findFreePort(APP_SERVER_BASE_PORT, APP_SERVER_PORT_RANGE);
  }

  private async connectWebSocket(
    url: string
  ): Promise<import("./ws-client").WsClient> {
    for (let i = 0; i < WS_CONNECT_ATTEMPTS; i++) {
      try {
        return await connectWsFn(url);
      } catch {
        if (i === WS_CONNECT_ATTEMPTS - 1) {
          throw new CodexAppServerFallbackError(
            "failed to connect to codex app-server WebSocket"
          );
        }
        await new Promise((resolve) =>
          setTimeout(resolve, WS_CONNECT_DELAY_MS)
        );
      }
    }
    throw new CodexAppServerFallbackError("unreachable");
  }

  runTurn(
    prompt: string,
    opts: Options,
    onParsed: Callback,
    onRaw: Callback
  ): Promise<RunResult> {
    const task = this.lock.then(() =>
      this.runTurnExclusive(prompt, opts, onParsed, onRaw)
    );
    this.lock = task.then(
      () => undefined,
      () => undefined
    );
    return task;
  }

  interrupt(signal: ExitSignal): void {
    killChildProcess(this.child, signal);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.failAll(new Error("codex app-server closed"));
    const ws = this.ws;
    this.ws = undefined;
    if (ws) {
      try {
        ws.close();
      } catch {
        // ignore close errors
      }
    }
    if (!this.child) {
      this.started = false;
      this.ready = false;
      return;
    }
    killChildProcess(this.child, "SIGTERM");
    await this.child.exited;
    this.child = undefined;
    this.ready = false;
    this.started = false;
  }

  private async ensureThread(model: string): Promise<string> {
    const response = await this.sendRequest(METHOD_THREAD_START, {
      model,
      approvalPolicy: "never",
      experimentalRawEvents: true,
      persistExtendedHistory: true,
    });
    const thread = extractThreadFromTurnStart(response);
    if (!thread.id) {
      throw new CodexAppServerFallbackError(
        "codex app-server returned thread/start without thread id"
      );
    }
    return thread.id;
  }

  private async runTurnExclusive(
    prompt: string,
    opts: Options,
    onParsed: Callback,
    onRaw: Callback
  ): Promise<RunResult> {
    if (!(this.child && this.ready)) {
      await this.start();
    }
    if (!this.child) {
      throw new CodexAppServerFallbackError("codex app-server not running");
    }

    const threadId = await this.ensureThread(opts.model);
    const response = await this.sendRequest(METHOD_TURN_START, {
      threadId,
      input: buildInput(prompt),
      model: opts.model,
      effort: null,
      cwd: null,
    });
    const turn = extractTurnFromStart(response);
    if (!turn.id) {
      throw new CodexAppServerFallbackError(
        "codex app-server returned turn/start without turn id"
      );
    }

    const turnId = turn.id;
    return new Promise<RunResult>((resolve, reject) => {
      const state: TurnState = {
        combined: "",
        lastChunk: "",
        onParsed,
        onRaw,
        parsed: "",
        reject,
        resolve,
      };
      this.turns.set(turnId, state);
      const timeout = setTimeout(() => {
        if (this.turns.delete(turnId)) {
          state.reject(new Error(`codex app-server turn ${turnId} timed out`));
        }
      }, WAIT_TIMEOUT_MS);
      const clear = () => clearTimeout(timeout);
      state.resolve = (result) => {
        clear();
        resolve(result);
      };
      state.reject = (error) => {
        clear();
        reject(error);
      };
    });
  }

  private async consumeFrames(proc: ReturnType<typeof spawn>): Promise<void> {
    await Promise.all([
      this.drainStream(proc.stdout),
      this.consumeStream(proc.stderr, this.handleStdErrLine),
    ]);
  }

  private async drainStream(stream: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stream.getReader();
    try {
      while (!(await reader.read()).done) {
        // drain only — all JSON-RPC goes through WebSocket
      }
    } finally {
      reader.releaseLock();
    }
  }

  private async consumeStream(
    stream: ReadableStream<Uint8Array>,
    handler: (line: string) => void
  ): Promise<void> {
    const decoder = new TextDecoder();
    let buffer = "";
    const reader = stream.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        if (!value) {
          continue;
        }
        buffer += decoder.decode(value, { stream: true });
        let index = buffer.indexOf("\n");
        while (index !== -1) {
          const line = buffer.slice(0, index);
          handler(line);
          buffer = buffer.slice(index + 1);
          index = buffer.indexOf("\n");
        }
      }
      if (buffer.trim()) {
        handler(buffer.trim());
      }
    } finally {
      reader.releaseLock();
    }
  }

  private readonly handleStdoutLine = (line: string): void => {
    for (const turn of this.turns.values()) {
      turn.combined += `${line}\n`;
      turn.onRaw(line);
    }
    const frame = parseLine(line);
    if (!frame) {
      return;
    }
    this.handleFrame(frame);
  };

  private readonly handleStdErrLine = (line: string): void => {
    for (const turn of this.turns.values()) {
      turn.combined += `${line}\n`;
      turn.onRaw(line);
    }
  };

  private selectTurnState(
    payload: Record<string, unknown>
  ): TurnState | undefined {
    const turnId = extractTurnId(payload) || extractThreadId(payload);
    if (turnId) {
      const byTurn = this.turns.get(turnId);
      if (byTurn) {
        return byTurn;
      }
    }
    return this.turns.size === 1 ? [...this.turns.values()][0] : undefined;
  }

  private handleFrame(frame: JsonFrame): void {
    const method = asString(frame.method);
    const requestId = asRequestId(frame.id);

    if (requestId && method) {
      this.handleServerRequest(requestId, method);
      return;
    }
    if (requestId) {
      this.handleResponse(requestId, frame.result, frame.error);
      return;
    }
    if (method) {
      this.handleNotification(method, asRecord(frame.params));
    }
  }

  private handleResponse(
    requestId: string,
    result: unknown,
    err: unknown
  ): void {
    const request = this.pending.get(requestId);
    if (!request) {
      return;
    }
    clearTimeout(request.timeout);
    this.pending.delete(requestId);
    if (err !== undefined) {
      const message =
        parseErrorText(err) ||
        parseErrorText({ error: err }) ||
        `codex app-server request "${request.method}" failed`;
      const shouldFallback =
        isUnsupportedTransportError(err) &&
        METHODS_TRIGGERING_FALLBACK.has(request.method);
      if (shouldFallback) {
        request.reject(new CodexAppServerFallbackError(message));
      } else {
        request.reject(new Error(message));
      }
      return;
    }
    request.resolve(result);
  }

  private handleServerRequest(requestId: string, method: string): void {
    if (
      method === METHOD_COMMAND_APPROVAL ||
      method === METHOD_FILE_CHANGE_APPROVAL
    ) {
      this.sendResponse(requestId, { decision: "accept" }, undefined);
      return;
    }
    if (method === METHOD_TOOL_USER_INPUT) {
      this.sendResponse(requestId, { answers: {} }, undefined);
      return;
    }
    if (
      method === METHOD_TOOL_CALL ||
      method === METHOD_APPLY_PATCH_APPROVAL ||
      method === METHOD_EXEC_COMMAND_APPROVAL ||
      method === METHOD_AUTH_REFRESH
    ) {
      this.sendResponse(requestId, undefined, {
        code: -32_601,
        message: "request unsupported by loop runner",
      });
      return;
    }

    this.sendResponse(requestId, undefined, {
      code: -32_601,
      message: `unsupported request method ${method}`,
    });
  }

  private handleNotification(
    method: string,
    params: Record<string, unknown>
  ): void {
    const state = this.selectTurnState(params);
    switch (method) {
      case METHOD_ITEM_DELTA:
        this.handleItemDeltaNotification(state, params);
        return;
      case METHOD_ITEM_COMPLETED:
        this.handleItemCompletedNotification(state, params);
        return;
      case METHOD_ERROR:
        this.handleErrorNotification(state, params);
        return;
      case METHOD_TURN_COMPLETED:
        this.handleTurnCompletedNotification(state, params);
        return;
      default:
        return;
    }
  }

  private handleItemDeltaNotification(
    state: TurnState | undefined,
    params: Record<string, unknown>
  ): void {
    if (!state) {
      return;
    }
    const chunk = parseText(params.delta || params);
    if (!chunk) {
      return;
    }
    const text = chunk.trim();
    if (!text || text === state.lastChunk) {
      return;
    }
    state.lastChunk = text;
    state.parsed = `${state.parsed ? `${state.parsed}\n` : ""}${text}`;
    state.onParsed(text);
  }

  private handleItemCompletedNotification(
    state: TurnState | undefined,
    params: Record<string, unknown>
  ): void {
    if (!state) {
      return;
    }
    const item = asRecord(params.item);
    const itemType = asString(item.type);
    if (itemType !== "agentMessage" && itemType !== "agent_message") {
      return;
    }
    const text = parseText(item);
    if (!text) {
      return;
    }
    const candidate = text.trim();
    if (!candidate || candidate === state.lastChunk) {
      return;
    }
    state.lastChunk = candidate;
    state.parsed = `${state.parsed ? `${state.parsed}\n` : ""}${candidate}`;
    state.onParsed(candidate);
  }

  private handleErrorNotification(
    state: TurnState | undefined,
    params: Record<string, unknown>
  ): void {
    const turnId = extractTurnId(params) || extractThreadId(params);
    if (state) {
      for (const [turnId, current] of this.turns.entries()) {
        if (current === state) {
          this.turns.delete(turnId);
          break;
        }
      }
      state.reject(new Error(parseErrorText(params) || "codex turn failed"));
      return;
    }
    if (turnId && this.turns.has(turnId)) {
      const activeState = this.turns.get(turnId);
      if (activeState) {
        this.turns.delete(turnId);
        activeState.reject(
          new Error(parseErrorText(params) || `turn ${turnId} failed`)
        );
      }
      return;
    }
    if (this.turns.size !== 1) {
      return;
    }
    const [first] = this.turns.values();
    this.turns.clear();
    first?.reject(new Error(parseErrorText(params) || "codex turn failed"));
  }

  private handleTurnCompletedNotification(
    state: TurnState | undefined,
    params: Record<string, unknown>
  ): void {
    if (!state && this.turns.size === 1) {
      const first = [...this.turns.values()][0];
      if (!first) {
        return;
      }
      this.resolveTurnState(first, params);
      return;
    }
    if (!state) {
      return;
    }
    this.resolveTurnState(state, params);
  }

  private resolveTurnState(
    state: TurnState,
    params: Record<string, unknown>
  ): void {
    const turn = asRecord(params.turn);
    const status = asString(params.status) ?? asString(turn.status);
    const exitCode = status === "failed" ? 1 : 0;
    const turnId = extractTurnId(params) || asString(turn.id);

    if (turnId && this.turns.has(turnId)) {
      this.turns.delete(turnId);
    } else {
      for (const [key, value] of this.turns.entries()) {
        if (value === state) {
          this.turns.delete(key);
          break;
        }
      }
    }

    if (exitCode === 1) {
      const message =
        parseErrorText(params) || parseErrorText(turn) || "codex turn failed";
      const nextParsed = message
        ? `${state.parsed ? `${state.parsed}\n` : ""}${message}`
        : state.parsed;
      state.resolve({
        combined: state.combined,
        exitCode,
        parsed: nextParsed,
      });
      return;
    }

    state.resolve({
      combined: state.combined,
      exitCode: 0,
      parsed: state.parsed,
    });
  }

  private sendRequest(method: string, params: unknown): Promise<unknown> {
    if (!(this.ws || this.child) || this.closed) {
      return Promise.reject(
        new CodexAppServerFallbackError("codex app-server not initialized")
      );
    }
    const requestId = String(this.requestId++);
    const payload: Record<string, unknown> = {
      id: requestId,
      method,
      params,
    };
    try {
      this.sendFrame(payload);
    } catch (error) {
      throw new CodexAppServerFallbackError(
        `codex app-server request "${method}" failed to write: ${
          toError(error).message
        }`
      );
    }

    return new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`codex app-server request "${method}" timed out`));
      }, WAIT_TIMEOUT_MS);
      this.pending.set(requestId, { method, resolve, reject, timeout });
    });
  }

  private sendFrame(payload: Record<string, unknown>): void {
    const data = `${JSON.stringify(payload)}\n`;
    if (this.ws) {
      this.ws.send(data);
    } else if (this.child) {
      this.child.stdin.write(data);
    }
  }

  private sendResponse(
    requestId: string,
    result: unknown,
    error: unknown
  ): void {
    if (!(this.ws || this.child)) {
      return;
    }
    const payload =
      error === undefined
        ? { id: requestId, result, jsonrpc: "2.0" }
        : { id: requestId, error, jsonrpc: "2.0" };
    this.sendFrame(payload);
  }

  private failAll(error: Error): void {
    for (const state of this.turns.values()) {
      state.reject(error);
    }
    this.turns.clear();
    for (const request of this.pending.values()) {
      clearTimeout(request.timeout);
      request.reject(error);
    }
    this.pending.clear();
  }

  private handleUnexpectedExit(): void {
    this.child = undefined;
    const ws = this.ws;
    this.ws = undefined;
    if (ws) {
      try {
        ws.close();
      } catch {
        // ignore close errors
      }
    }
    this.started = false;
    this.ready = false;
    this.failAll(
      new CodexAppServerFallbackError("codex app-server exited unexpectedly")
    );
  }
}

let singleton: AppServerClient | undefined;

process.on("exit", () => {
  killChildProcess(singleton?.process, "SIGKILL");
});

const getClient = (): AppServerClient => {
  if (!singleton) {
    singleton = new AppServerClient();
  }
  return singleton;
};

export const useAppServer = (): boolean =>
  process.env[CODEX_TRANSPORT_ENV] !== CODEX_TRANSPORT_EXEC;

export const startAppServer = async (): Promise<void> => {
  await getClient().start();
};

export const runCodexTurn = (
  prompt: string,
  opts: Options,
  // Some callers render directly from raw events and intentionally skip parsed callbacks.
  callbacks: RunCodexTurnCallbacks
): Promise<RunResult> => {
  return getClient().runTurn(
    prompt,
    opts,
    callbacks.onParsed ?? NOOP_CALLBACK,
    callbacks.onRaw
  );
};

export const interruptAppServer = (signal: ExitSignal): void => {
  getClient().interrupt(signal);
};

export const hasAppServerProcess = (): boolean => getClient().hasProcess();

export const closeAppServer = async (): Promise<void> => {
  if (!singleton) {
    return;
  }
  await singleton.close();
  singleton = undefined;
};
