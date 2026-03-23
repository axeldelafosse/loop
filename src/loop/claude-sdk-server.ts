import {
  type Server,
  type ServerWebSocket,
  serve,
  spawn,
  spawnSync,
} from "bun";
import { AGENT_TURN_TIMEOUT_MS, DEFAULT_CLAUDE_MODEL } from "./constants";
import { findFreePort } from "./ports";
import { DETACH_CHILD_PROCESS, killChildProcess } from "./process";
import type { Options, RunResult } from "./types";

type ExitSignal = "SIGINT" | "SIGTERM";
type Callback = (text: string) => void;
type ServeFn = (...args: Parameters<typeof serve>) => ReturnType<typeof serve>;
type SpawnFn = (...args: Parameters<typeof spawn>) => ReturnType<typeof spawn>;
type WSRole = "claude" | "frontend";
export interface ClaudeSdkLaunchOptions {
  mcpConfig?: string;
  persistent?: boolean;
}
interface WSData {
  role: WSRole;
}

interface ContentBlock {
  text?: string;
  type: string;
}

interface StreamEvent {
  delta?: { text?: string; type?: string };
  type?: string;
}

interface NdjsonMessage {
  event?: StreamEvent;
  is_error?: boolean;
  message?: { content?: ContentBlock[]; role?: string };
  request?: {
    input?: Record<string, unknown>;
    subtype?: string;
    tool_name?: string;
  };
  request_id?: string;
  response?: { request_id?: string; subtype?: string };
  result?: string;
  session_id?: string;
  subtype?: string;
  type: string;
}

interface TurnState {
  backgroundTaskSeen: boolean;
  combined: string;
  drainingBackground: boolean;
  hasStreamed: boolean;
  onDelta: Callback;
  onParsed: Callback;
  onRaw: Callback;
  parsed: string;
  reject: (error: Error) => void;
  resolve: (result: RunResult) => void;
}

const CLAUDE_SDK_BASE_PORT = 8765;
const CLAUDE_SDK_PORT_RANGE = 100;
const BACKGROUND_TASK_CONTINUATION =
  "Background tasks are complete. Continue with the task.";
const DEFAULT_CHILD_POLL_INTERVAL_MS = 2000;
const START_TIMEOUT_MS = 60_000;

let childPollIntervalMs = DEFAULT_CHILD_POLL_INTERVAL_MS;
let waitTimeoutMs = AGENT_TURN_TIMEOUT_MS;

type CountChildProcessesFn = (pid: number) => number;

const asRecord = (value: unknown): Record<string, unknown> => {
  if (typeof value === "object" && value !== null) {
    return value as Record<string, unknown>;
  }
  return {};
};

const wait = async (ms: number): Promise<void> => {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
};

const countChildProcesses = (pid: number): number => {
  if (process.platform === "win32" || !Number.isInteger(pid) || pid <= 0) {
    return 0;
  }
  try {
    const proc = spawnSync({
      cmd: ["pgrep", "-g", String(pid)],
      stderr: "ignore",
      stdout: "pipe",
    });
    const output = new TextDecoder().decode(proc.stdout).trim();
    if (!output) {
      return 0;
    }
    return output
      .split("\n")
      .map((rawPid) => Number.parseInt(rawPid.trim(), 10))
      .filter((childPid) => Number.isInteger(childPid) && childPid > 0)
      .filter((childPid) => childPid !== pid).length;
  } catch {
    return 0;
  }
};

let countChildProcessesFn: CountChildProcessesFn = countChildProcesses;

const drainStream = (stream: ReadableStream<Uint8Array>): void => {
  const reader = stream.getReader();
  const pump = (): void => {
    reader
      .read()
      .then(({ done }) => {
        if (!done) {
          pump();
        }
      })
      .catch(() => {
        // ignore read errors after process exit
      });
  };
  pump();
};

const pipeToStderr = (stream: ReadableStream<Uint8Array>): void => {
  const reader = stream.getReader();
  const pump = (): void => {
    reader
      .read()
      .then(({ done, value }) => {
        if (done) {
          return;
        }
        if (value) {
          process.stderr.write(value);
        }
        pump();
      })
      .catch(() => {
        // ignore read errors after process exit
      });
  };
  pump();
};

const isValidNdjson = (text: string): boolean => {
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      JSON.parse(trimmed);
    } catch {
      return false;
    }
  }
  return true;
};

let spawnFn: SpawnFn = spawn;
let serveFn: ServeFn = serve;

export const claudeSdkInternals = {
  BACKGROUND_TASK_CONTINUATION,
  countChildProcesses,
  restoreSpawnFn(): void {
    spawnFn = spawn;
  },
  setSpawnFn(next: SpawnFn): void {
    spawnFn = next;
  },
  restoreServeFn(): void {
    serveFn = serve;
  },
  setServeFn(next: ServeFn): void {
    serveFn = next;
  },
  restoreCountChildProcessesFn(): void {
    countChildProcessesFn = countChildProcesses;
  },
  setCountChildProcessesFn(next: CountChildProcessesFn): void {
    countChildProcessesFn = next;
  },
  restoreChildPollIntervalMs(): void {
    childPollIntervalMs = DEFAULT_CHILD_POLL_INTERVAL_MS;
  },
  setChildPollIntervalMs(next: number): void {
    childPollIntervalMs = next;
  },
  restoreWaitTimeoutMs(): void {
    waitTimeoutMs = AGENT_TURN_TIMEOUT_MS;
  },
  setWaitTimeoutMs(next: number): void {
    waitTimeoutMs = next;
  },
};

class ClaudeSdkClient {
  private child: ReturnType<typeof spawn> | undefined;
  private closed = false;
  private lastSessionId = "";
  private lock: Promise<void> = Promise.resolve();
  private mcpConfig = "";
  private model = DEFAULT_CLAUDE_MODEL;
  private port = 0;
  private persistentSession = false;
  private ready = false;
  private resumeId = "";
  private server: Server | undefined;
  private sessionId = "";
  private started = false;
  private turn: TurnState | undefined;
  private initRequestId = "";
  private waitingForConnection: (() => void) | undefined;
  private waitingForInitialize: (() => void) | undefined;
  private ws: ServerWebSocket<WSData> | undefined;
  private readonly frontends = new Set<ServerWebSocket<WSData>>();

  get process(): ReturnType<typeof spawn> | undefined {
    return this.child;
  }

  hasProcess(): boolean {
    return this.child !== undefined;
  }

  getLastSessionId(): string {
    return this.lastSessionId;
  }

  setResumeId(id: string): void {
    this.resumeId = id;
  }

  setModel(model: string): void {
    this.model = model;
  }

  resolveResumeId(id?: string): string | undefined {
    return id || this.sessionId || this.lastSessionId || undefined;
  }

  shouldRestart(
    model: string,
    resumeSessionId?: string,
    options: ClaudeSdkLaunchOptions = {}
  ): boolean {
    if (!this.started) {
      return false;
    }

    if (this.model !== model) {
      return true;
    }

    if (this.mcpConfig !== (options.mcpConfig?.trim() ?? "")) {
      return true;
    }

    if (this.persistentSession !== (options.persistent ?? false)) {
      return true;
    }

    return Boolean(
      resumeSessionId &&
        resumeSessionId !== this.sessionId &&
        resumeSessionId !== this.lastSessionId
    );
  }

  configureLaunch(options: ClaudeSdkLaunchOptions = {}): void {
    if (this.started) {
      return;
    }
    this.mcpConfig = options.mcpConfig?.trim() ?? "";
    this.persistentSession = options.persistent ?? false;
  }

  async restart(): Promise<void> {
    if (this.turn) {
      throw new Error("cannot restart claude sdk during an active turn");
    }
    await this.cleanup();
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }
    this.started = true;
    try {
      this.port = await findFreePort(
        CLAUDE_SDK_BASE_PORT,
        CLAUDE_SDK_PORT_RANGE
      );
      this.createServer();

      const connected = new Promise<void>((r) => {
        this.waitingForConnection = r;
      });
      const initialized = new Promise<void>((r) => {
        this.waitingForInitialize = r;
      });

      const url = `ws://localhost:${this.port}`;
      const resumeArgs = this.resumeId ? ["--resume", this.resumeId] : [];
      const mcpArgs = this.mcpConfig
        ? ["--mcp-config", this.mcpConfig, "--strict-mcp-config"]
        : [];
      this.resumeId = "";

      this.child = spawnFn(
        [
          "claude",
          "-p",
          "placeholder",
          "--output-format",
          "stream-json",
          "--input-format",
          "stream-json",
          "--verbose",
          "--model",
          this.model,
          ...mcpArgs,
          "--dangerously-skip-permissions",
          "--sdk-url",
          url,
          ...resumeArgs,
        ],
        {
          detached: DETACH_CHILD_PROCESS,
          env: process.env,
          stderr: "pipe",
          stdout: "pipe",
        }
      );

      drainStream(this.child.stdout);
      pipeToStderr(this.child.stderr);

      const timeout = new Promise<never>((_, reject) => {
        setTimeout(
          () => reject(new Error("claude sdk startup timed out")),
          START_TIMEOUT_MS
        );
      });
      const exited = this.child.exited.then((code) => {
        throw new Error(`claude exited with code ${code} during startup`);
      });

      await Promise.race([connected.then(() => initialized), timeout, exited]);
      this.ready = true;
    } catch (error) {
      await this.cleanup();
      throw error;
    }
  }

  runTurn(
    prompt: string,
    opts: Options,
    onParsed: Callback,
    onRaw: Callback,
    onDelta: Callback
  ): Promise<RunResult> {
    const task = this.lock.then(() =>
      this.runTurnExclusive(prompt, opts, onParsed, onRaw, onDelta)
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
    if (this.turn) {
      this.turn.reject(new Error("claude sdk server closed"));
      this.turn = undefined;
    }
    await this.cleanup();
  }

  private broadcastToFrontends(data: string): void {
    for (const ws of this.frontends) {
      ws.send(data);
    }
  }

  private handleFrontendMessage(
    _ws: ServerWebSocket<WSData>,
    text: string
  ): void {
    if (!isValidNdjson(text)) {
      return;
    }
    // Fan out frontend-originated NDJSON so observer UIs can render
    // user prompts that may not be echoed back by Claude.
    this.broadcastToFrontends(text);
    this.ws?.send(text);
  }

  private createServer(): void {
    const self = this;
    this.server = serveFn({
      port: this.port,
      fetch(req, server) {
        const path = new URL(req.url).pathname;
        const role: WSRole = path === "/ws" ? "frontend" : "claude";
        if (server.upgrade(req, { data: { role } as WSData })) {
          return undefined;
        }
        return new Response("loop", { status: 200 });
      },
      websocket: {
        idleTimeout: 0,
        perMessageDeflate: false,
        close(ws, _code, _reason) {
          const d = ws.data as WSData;
          if (d.role === "frontend") {
            self.frontends.delete(ws as ServerWebSocket<WSData>);
            return;
          }
          if (!self.closed) {
            self.handleUnexpectedClose();
          }
        },
        message(ws, data) {
          const d = ws.data as WSData;
          const text =
            typeof data === "string"
              ? data
              : new TextDecoder().decode(data as ArrayBuffer);

          if (d.role === "frontend") {
            self.handleFrontendMessage(ws as ServerWebSocket<WSData>, text);
            return;
          }

          for (const line of text.split("\n")) {
            if (!line.trim()) {
              continue;
            }
            try {
              self.handleMessage(JSON.parse(line) as NdjsonMessage, line);
            } catch {
              // ignore parse errors
            }
          }
        },
        open(ws) {
          const d = ws.data as WSData;
          if (d.role === "frontend") {
            self.frontends.add(ws as ServerWebSocket<WSData>);
            // send current status
            if (self.ready) {
              ws.send(
                `${JSON.stringify({
                  type: "status",
                  text: "claude code is connected",
                })}\n`
              );
            }
            return;
          }

          self.ws = ws as ServerWebSocket<WSData>;
          self.waitingForConnection?.();
          self.waitingForConnection = undefined;

          // Send initialize control_request per SDK protocol
          self.initRequestId = crypto.randomUUID();
          ws.send(
            `${JSON.stringify({
              type: "control_request",
              request_id: self.initRequestId,
              request: { subtype: "initialize" },
            })}\n`
          );
        },
      },
    });
  }

  private handleMessage(msg: NdjsonMessage, raw: string): void {
    // broadcast to frontend observers
    this.broadcastToFrontends(`${raw}\n`);

    if (this.turn) {
      this.turn.combined += `${raw}\n`;
      this.turn.onRaw(raw);
    }

    switch (msg.type) {
      case "system":
        if (msg.subtype === "init") {
          this.sessionId = msg.session_id || "";
          this.lastSessionId = this.sessionId || this.lastSessionId;
          if (this.sessionId) {
            console.error(`[loop] claude session: ${this.sessionId}`);
          }
        }
        return;
      case "control_response":
        this.handleControlResponse(msg);
        return;
      case "stream_event":
        this.handleStreamEvent(msg);
        return;
      case "assistant":
        this.handleAssistant(msg);
        return;
      case "result":
        this.handleResult(msg);
        return;
      case "control_request":
        this.handleControlRequest(msg);
        return;
      default:
        return;
    }
  }

  private handleControlResponse(msg: NdjsonMessage): void {
    if (
      msg.response?.request_id === this.initRequestId &&
      msg.response?.subtype === "success"
    ) {
      this.waitingForInitialize?.();
      this.waitingForInitialize = undefined;
    }
  }

  private handleStreamEvent(msg: NdjsonMessage): void {
    if (!this.turn) {
      return;
    }
    const event = msg.event;
    if (
      event?.type === "content_block_delta" &&
      event.delta?.type === "text_delta" &&
      event.delta.text
    ) {
      this.turn.hasStreamed = true;
      this.turn.onDelta(event.delta.text);
    }
  }

  private handleAssistant(msg: NdjsonMessage): void {
    if (!this.turn) {
      return;
    }
    const content = msg.message?.content;
    if (!Array.isArray(content)) {
      return;
    }
    const text = content
      .filter((b) => b.type === "text" && b.text)
      .map((b) => b.text)
      .join("")
      .trim();
    if (!text) {
      return;
    }
    this.turn.parsed = this.turn.parsed ? `${this.turn.parsed}\n${text}` : text;
    if (!this.turn.hasStreamed) {
      this.turn.onParsed(text);
    }
  }

  private handleResult(msg: NdjsonMessage): void {
    if (!this.turn) {
      return;
    }
    const state = this.turn;
    if (state.backgroundTaskSeen) {
      if (state.drainingBackground) {
        return;
      }
      state.drainingBackground = true;
      this.drainAndContinue(state).catch(() => {
        // timeout and close handlers reject turn state; ignore drain errors
      });
      return;
    }
    this.turn = undefined;
    state.resolve({
      combined: state.combined,
      exitCode: msg.is_error ? 1 : 0,
      parsed: state.parsed,
    });
  }

  private handleControlRequest(msg: NdjsonMessage): void {
    if (!(this.ws && msg.request_id)) {
      return;
    }
    const input = asRecord(msg.request?.input);
    if (
      this.turn &&
      msg.request?.tool_name === "Task" &&
      input.run_in_background === true
    ) {
      this.turn.backgroundTaskSeen = true;
    }
    if (msg.request?.subtype === "can_use_tool") {
      this.sendJson({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: msg.request_id,
          response: {
            behavior: "allow",
            updatedInput: msg.request.input || {},
          },
        },
      });
    }
  }

  private async drainAndContinue(state: TurnState): Promise<void> {
    while (this.turn === state) {
      const pid = this.child?.pid;
      const remaining =
        typeof pid === "number" ? countChildProcessesFn(pid) : 0;
      if (remaining <= 0) {
        if (this.turn !== state) {
          return;
        }
        state.backgroundTaskSeen = false;
        state.drainingBackground = false;
        this.sendUserMessage(BACKGROUND_TASK_CONTINUATION);
        return;
      }
      await wait(childPollIntervalMs);
    }
  }

  private sendJson(data: Record<string, unknown>): void {
    this.ws?.send(`${JSON.stringify(data)}\n`);
  }

  private sendUserMessage(content: string): void {
    const payload = {
      type: "user",
      message: { role: "user", content },
      parent_tool_use_id: null,
      session_id: this.sessionId,
    };
    const raw = `${JSON.stringify(payload)}\n`;
    this.broadcastToFrontends(raw);
    this.ws?.send(raw);
  }

  private async runTurnExclusive(
    prompt: string,
    _opts: Options,
    onParsed: Callback,
    onRaw: Callback,
    onDelta: Callback
  ): Promise<RunResult> {
    if (!(this.child && this.ready)) {
      await this.start();
    }
    if (!this.ws) {
      throw new Error("claude sdk server not connected");
    }

    const result = await new Promise<RunResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (this.turn) {
          this.turn = undefined;
          reject(new Error("claude sdk turn timed out"));
        }
      }, waitTimeoutMs);

      this.turn = {
        backgroundTaskSeen: false,
        combined: "",
        drainingBackground: false,
        hasStreamed: false,
        onDelta,
        onParsed,
        onRaw,
        parsed: "",
        resolve: (r) => {
          clearTimeout(timeout);
          resolve(r);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      };

      this.sendUserMessage(prompt);
    });

    if (!this.persistentSession) {
      // Claude SDK session state is process-bound, so restart per turn to force a
      // fresh session ID and avoid carrying state across independent loop turns.
      await this.cleanup();
    }
    return result;
  }

  private async cleanup(): Promise<void> {
    for (const ws of this.frontends) {
      try {
        ws.close();
      } catch {
        // ignore close errors
      }
    }
    this.frontends.clear();
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // ignore close errors
      }
      this.ws = undefined;
    }
    if (this.server) {
      this.server.stop();
      this.server = undefined;
    }
    if (this.child) {
      killChildProcess(this.child, "SIGTERM");
      await this.child.exited;
      this.child = undefined;
    }
    this.ready = false;
    this.started = false;
    this.sessionId = "";
  }

  private handleUnexpectedClose(): void {
    const state = this.turn;
    this.turn = undefined;
    this.broadcastToFrontends(
      `${JSON.stringify({ type: "status", text: "claude code disconnected" })}\n`
    );
    state?.reject(new Error("claude sdk connection closed unexpectedly"));
    this.ws = undefined;
    this.cleanup().catch(() => {
      // ignore cleanup errors after unexpected websocket close
    });
  }
}

let singleton: ClaudeSdkClient | undefined;

process.on("exit", () => {
  killChildProcess(singleton?.process, "SIGKILL");
});

const getClient = (): ClaudeSdkClient => {
  if (!singleton) {
    singleton = new ClaudeSdkClient();
  }
  return singleton;
};

export const startClaudeSdk = async (
  model = DEFAULT_CLAUDE_MODEL,
  resumeSessionId?: string,
  launchOptions: ClaudeSdkLaunchOptions = {}
): Promise<void> => {
  const client = getClient();
  const needsRestart = client.shouldRestart(
    model,
    resumeSessionId,
    launchOptions
  );
  const nextResumeId =
    needsRestart || launchOptions.persistent
      ? client.resolveResumeId(resumeSessionId)
      : resumeSessionId;
  if (needsRestart) {
    await client.restart();
  }
  client.setModel(model);
  if (nextResumeId && !client.hasProcess()) {
    client.setResumeId(nextResumeId);
  }
  client.configureLaunch(launchOptions);
  await client.start();
};

export const runClaudeTurn = (
  prompt: string,
  opts: Options,
  callbacks: { onDelta: Callback; onParsed: Callback; onRaw: Callback }
): Promise<RunResult> => {
  return getClient().runTurn(
    prompt,
    opts,
    callbacks.onParsed,
    callbacks.onRaw,
    callbacks.onDelta
  );
};

export const interruptClaudeSdk = (signal: ExitSignal): void => {
  getClient().interrupt(signal);
};

export const hasClaudeSdkProcess = (): boolean => getClient().hasProcess();

export const getLastClaudeSessionId = (): string =>
  singleton?.getLastSessionId() ?? "";

export const closeClaudeSdk = async (): Promise<void> => {
  if (!singleton) {
    return;
  }
  await singleton.close();
  singleton = undefined;
};
