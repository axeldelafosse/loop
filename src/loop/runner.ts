import { spawn } from "bun";
import {
  hasClaudeSdkProcess,
  interruptClaudeSdk,
  runClaudeTurn,
  startClaudeSdk,
} from "./claude-sdk-server";
import {
  CODEX_TRANSPORT_ENV,
  CODEX_TRANSPORT_EXEC,
  CodexAppServerFallbackError,
  CodexAppServerUnexpectedExitError,
  hasAppServerProcess,
  interruptAppServer,
  runCodexTurn,
  startAppServer,
  useAppServer,
} from "./codex-app-server";
import { createCodexRenderer } from "./codex-render";
import { DEFAULT_CLAUDE_MODEL } from "./constants";
import { DETACH_CHILD_PROCESS, killChildProcess } from "./process";
import type { Agent, Options, RunResult } from "./types";

type ExitSignal = "SIGINT" | "SIGTERM";
type AgentRunKind = "review" | "work";
interface SpawnConfig {
  args: string[];
  cmd: string;
}

type LegacyAgentRunner = (
  agent: Agent,
  prompt: string,
  opts: Options,
  sessionId?: string,
  kind?: AgentRunKind
) => Promise<RunResult>;
interface RunnerState {
  runLegacyAgent: LegacyAgentRunner;
  useAppServer: () => boolean;
}

const SIGNAL_EXIT_CODES: Record<ExitSignal, number> = {
  SIGINT: 130,
  SIGTERM: 143,
};
const APP_SERVER_RETRY_LIMIT = 1;
const APP_SERVER_RETRY_LOG =
  "[loop] codex app-server exited unexpectedly. Restarting app-server and retrying.";

const activeChildren = new Set<ReturnType<typeof spawn>>();
let activeAppServerRuns = 0;
let activeClaudeSdkRuns = 0;
let watchingSignals = false;
let fallbackWarned = false;
const runnerState: RunnerState = {
  runLegacyAgent: (agent, prompt, opts, sessionId, kind) =>
    runLegacyAgent(agent, prompt, opts, sessionId, kind),
  useAppServer: () => useAppServer(),
};

const killChildren = (signal: ExitSignal): void => {
  for (const child of activeChildren) {
    killChildProcess(child, signal);
  }
};

const killChildrenHard = (): void => {
  for (const child of activeChildren) {
    killChildProcess(child, "SIGKILL");
  }
};

process.on("exit", killChildrenHard);

const onSigint = (): void => {
  killChildren("SIGINT");
  interruptAppServer("SIGINT");
  interruptClaudeSdk("SIGINT");
  process.exit(SIGNAL_EXIT_CODES.SIGINT);
};

const onSigterm = (): void => {
  killChildren("SIGTERM");
  interruptAppServer("SIGTERM");
  interruptClaudeSdk("SIGTERM");
  process.exit(SIGNAL_EXIT_CODES.SIGTERM);
};

const syncSignalHandlers = (): void => {
  const hasAppServerWork = hasAppServerProcess();
  const hasClaudeSdkWork = hasClaudeSdkProcess();
  const hasWork =
    activeChildren.size > 0 ||
    activeAppServerRuns > 0 ||
    activeClaudeSdkRuns > 0 ||
    hasAppServerWork ||
    hasClaudeSdkWork;
  if (hasWork && !watchingSignals) {
    process.on("SIGINT", onSigint);
    process.on("SIGTERM", onSigterm);
    watchingSignals = true;
    return;
  }

  if (!hasWork && watchingSignals) {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    watchingSignals = false;
  }
};

export const buildCommand = (
  agent: Agent,
  prompt: string,
  model: string,
  sessionId?: string
): SpawnConfig => {
  if (agent === "claude") {
    const args = [
      "-p",
      prompt,
      "--dangerously-skip-permissions",
      "--output-format",
      "stream-json",
      "--verbose",
      "--model",
      model,
    ];
    if (sessionId) {
      args.push("--resume", sessionId);
    }
    return { args, cmd: "claude" };
  }

  return {
    args: [
      "exec",
      "--json",
      "--model",
      model,
      "-c",
      'model_reasoning_effort="xhigh"',
      "--yolo",
      prompt,
    ],
    cmd: "codex",
  };
};

const resolveModel = (
  agent: Agent,
  opts: Options,
  kind: AgentRunKind
): string => {
  if (agent === "codex") {
    return kind === "review"
      ? (opts.codexReviewerModel ?? opts.codexModel)
      : opts.codexModel;
  }

  return kind === "review"
    ? (opts.claudeReviewerModel ?? DEFAULT_CLAUDE_MODEL)
    : DEFAULT_CLAUDE_MODEL;
};

const withCodexModel = (opts: Options, model: string): Options => {
  if (opts.codexModel === model) {
    return opts;
  }
  return { ...opts, codexModel: model };
};

const eventMessage = (line: string): string => {
  if (!line.trim().startsWith("{")) {
    return "";
  }

  try {
    const event = JSON.parse(line) as {
      item?: {
        content?: Array<{ text?: string }>;
        text?: string;
        type?: string;
      };
      message?: { content?: Array<{ text?: string; type?: string }> };
      result?: unknown;
      type?: string;
    };

    if (
      event.type === "item.completed" &&
      event.item?.type === "agent_message"
    ) {
      return (
        event.item.text?.trim() ||
        (event.item.content ?? [])
          .map((part) => part.text ?? "")
          .join("")
          .trim()
      );
    }

    if (event.type === "assistant") {
      return (event.message?.content ?? [])
        .filter((part) => part.type === "text")
        .map((part) => part.text ?? "")
        .join("")
        .trim();
    }

    if (event.type === "result" && typeof event.result === "string") {
      return event.result.trim();
    }

    return "";
  } catch {
    return "";
  }
};

const consume = async (
  stream: ReadableStream<Uint8Array>,
  onText: (text: string) => void
): Promise<void> => {
  const reader = stream.getReader();
  const decoder = new TextDecoder();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (value) {
        onText(decoder.decode(value, { stream: true }));
      }
    }

    const tail = decoder.decode();
    if (tail) {
      onText(tail);
    }
  } finally {
    reader.releaseLock();
  }
};

const appendParsedLine = (
  text: string,
  opts: Options,
  state: { parsed: string; prettyCount: number; lastMessage: string }
): { parsed: string; prettyCount: number; lastMessage: string } => {
  const trimmed = text.trim();
  if (!trimmed || (opts.format === "pretty" && trimmed === state.lastMessage)) {
    return state;
  }
  if (opts.format === "pretty") {
    if (state.prettyCount > 0) {
      process.stdout.write("\n");
    }
    process.stdout.write(`${trimmed}\n`);
    return {
      lastMessage: trimmed,
      prettyCount: state.prettyCount + 1,
      parsed: `${state.parsed ? `${state.parsed}\n` : ""}${trimmed}`,
    };
  }

  return {
    ...state,
    lastMessage: trimmed,
    parsed: `${state.parsed ? `${state.parsed}\n` : ""}${trimmed}`,
  };
};

const isRetryableAppServerError = (error: unknown): boolean =>
  error instanceof CodexAppServerUnexpectedExitError;

const runCodexAppServerAttempt = async (
  prompt: string,
  opts: Options,
  sessionId?: string
): Promise<RunResult> => {
  const renderer = createCodexRenderer({
    format: opts.format,
    write: (text) => {
      process.stdout.write(text);
    },
  });

  try {
    await startAppServer();
  } catch (error) {
    if (process.env[CODEX_TRANSPORT_ENV] === CODEX_TRANSPORT_EXEC) {
      throw error;
    }
    throw new CodexAppServerFallbackError(
      error instanceof Error ? error.message : String(error)
    );
  }

  const result = await runCodexTurn(
    prompt,
    opts,
    { onRaw: renderer.onRawLine },
    sessionId
  );
  const finalParsed = result.parsed || renderer.getParsed();
  if (
    opts.format === "pretty" &&
    renderer.wrotePretty() &&
    !finalParsed.endsWith("\n")
  ) {
    process.stdout.write("\n");
  }
  return { ...result, parsed: finalParsed };
};

const runCodexAgent = async (
  prompt: string,
  opts: Options,
  sessionId?: string,
  kind: AgentRunKind = "work"
): Promise<RunResult> => {
  // Legacy codex exec resolves from opts again, so bake the final model into
  // codexModel before either transport path runs.
  const runOpts = withCodexModel(opts, resolveModel("codex", opts, kind));
  if (!runnerState.useAppServer()) {
    return runnerState.runLegacyAgent(
      "codex",
      prompt,
      runOpts,
      sessionId,
      kind
    );
  }

  activeAppServerRuns += 1;
  syncSignalHandlers();
  try {
    let attempts = 0;
    while (true) {
      try {
        return await runCodexAppServerAttempt(prompt, runOpts, sessionId);
      } catch (error) {
        if (
          attempts >= APP_SERVER_RETRY_LIMIT ||
          !isRetryableAppServerError(error)
        ) {
          throw error;
        }
        attempts += 1;
        console.error(APP_SERVER_RETRY_LOG);
      }
    }
  } catch (error) {
    if (
      process.env[CODEX_TRANSPORT_ENV] !== CODEX_TRANSPORT_EXEC &&
      error instanceof CodexAppServerFallbackError
    ) {
      if (!fallbackWarned) {
        fallbackWarned = true;
        console.error(
          "[loop] codex app-server transport failed. Falling back to `codex exec --json`."
        );
      }
      return runnerState.runLegacyAgent(
        "codex",
        prompt,
        runOpts,
        sessionId,
        kind
      );
    }
    throw error;
  } finally {
    activeAppServerRuns -= 1;
    syncSignalHandlers();
  }
};

const runLegacyAgent = async (
  agent: Agent,
  prompt: string,
  opts: Options,
  sessionId?: string,
  kind: AgentRunKind = "work"
): Promise<RunResult> => {
  const { args, cmd } = buildCommand(
    agent,
    prompt,
    resolveModel(agent, opts, kind),
    sessionId
  );
  const proc = spawn([cmd, ...args], {
    detached: DETACH_CHILD_PROCESS,
    env: process.env,
    stderr: "pipe",
    stdout: "pipe",
  });
  activeChildren.add(proc);
  syncSignalHandlers();

  let stdout = "";
  let stderr = "";
  let parsed = "";
  let pending = "";
  let state = { parsed: "", prettyCount: 0, lastMessage: "" };

  const onLine = (line: string): void => {
    const message = eventMessage(line);
    if (message) {
      state = appendParsedLine(message, opts, state);
      parsed = state.parsed;
      return;
    }

    if (
      !line.trim().startsWith("{") &&
      opts.format === "pretty" &&
      line.trim()
    ) {
      if (state.prettyCount > 0) {
        process.stdout.write("\n");
      }
      process.stdout.write(`${line}\n`);
      state.prettyCount += 1;
    }
  };

  try {
    const outTask = consume(proc.stdout, (text) => {
      stdout += text;
      pending += text;

      let index = pending.indexOf("\n");
      while (index !== -1) {
        onLine(pending.slice(0, index));
        pending = pending.slice(index + 1);
        index = pending.indexOf("\n");
      }

      if (opts.format === "raw") {
        process.stdout.write(text);
      }
    });

    const errTask = consume(proc.stderr, (text) => {
      stderr += text;
      process.stderr.write(text);
    });

    await Promise.all([outTask, errTask]);
    if (pending.trim()) {
      onLine(pending);
    }

    const exitCode = await proc.exited;
    return { combined: `${stdout}\n${stderr}`, exitCode, parsed };
  } finally {
    activeChildren.delete(proc);
    syncSignalHandlers();
  }
};

const defaultRunLegacyAgent: LegacyAgentRunner = (
  agent: Agent,
  prompt: string,
  opts: Options,
  sessionId?: string,
  kind?: AgentRunKind
): Promise<RunResult> => runLegacyAgent(agent, prompt, opts, sessionId, kind);

export const runnerInternals = {
  reset(): void {
    fallbackWarned = false;
    runnerState.useAppServer = () => useAppServer();
    runnerState.runLegacyAgent = defaultRunLegacyAgent;
  },
  setUseAppServer(next: () => boolean): void {
    runnerState.useAppServer = next;
  },
  setLegacyAgent(next: LegacyAgentRunner): void {
    runnerState.runLegacyAgent = next;
  },
};

const runClaudeAgent = async (
  prompt: string,
  opts: Options,
  sessionId?: string,
  kind: AgentRunKind = "work"
): Promise<RunResult> => {
  const model = resolveModel("claude", opts, kind);
  let parsed = "";
  let state = { parsed: "", prettyCount: 0, lastMessage: "" };
  const onParsed = (text: string): void => {
    state = appendParsedLine(text, opts, state);
    parsed = state.parsed;
  };
  const onRaw = (text: string): void => {
    if (opts.format === "raw") {
      process.stdout.write(`${text}\n`);
    }
  };
  const onDelta = (text: string): void => {
    if (opts.format === "pretty") {
      process.stdout.write(text);
    }
  };

  activeClaudeSdkRuns += 1;
  syncSignalHandlers();
  try {
    await startClaudeSdk(model, sessionId);
    const result = await runClaudeTurn(prompt, opts, {
      onDelta,
      onParsed,
      onRaw,
    });
    return { ...result, parsed: result.parsed || parsed };
  } finally {
    activeClaudeSdkRuns -= 1;
    syncSignalHandlers();
  }
};

const runAgentWithKind = (
  agent: Agent,
  prompt: string,
  opts: Options,
  sessionId?: string,
  kind: AgentRunKind = "work"
): Promise<RunResult> => {
  if (agent === "codex") {
    return runCodexAgent(prompt, opts, sessionId, kind);
  }
  return runClaudeAgent(prompt, opts, sessionId, kind);
};

export const runAgent = (
  agent: Agent,
  prompt: string,
  opts: Options,
  sessionId?: string
): Promise<RunResult> => runAgentWithKind(agent, prompt, opts, sessionId);

export const runReviewerAgent = (
  agent: Agent,
  prompt: string,
  opts: Options,
  sessionId?: string
): Promise<RunResult> =>
  runAgentWithKind(agent, prompt, opts, sessionId, "review");
