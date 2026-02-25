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
interface SpawnConfig {
  args: string[];
  cmd: string;
}

type LegacyAgentRunner = (
  agent: Agent,
  prompt: string,
  opts: Options
) => Promise<RunResult>;
interface RunnerState {
  runLegacyAgent: LegacyAgentRunner;
  useAppServer: () => boolean;
}

const SIGNAL_EXIT_CODES: Record<ExitSignal, number> = {
  SIGINT: 130,
  SIGTERM: 143,
};

const activeChildren = new Set<ReturnType<typeof spawn>>();
let activeAppServerRuns = 0;
let activeClaudeSdkRuns = 0;
let watchingSignals = false;
let fallbackWarned = false;
const runnerState: RunnerState = {
  runLegacyAgent: (agent, prompt, opts) => runLegacyAgent(agent, prompt, opts),
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
  model: string
): SpawnConfig => {
  if (agent === "claude") {
    return {
      args: [
        "-p",
        prompt,
        "--dangerously-skip-permissions",
        "--output-format",
        "stream-json",
        "--verbose",
        "--model",
        DEFAULT_CLAUDE_MODEL,
      ],
      cmd: "claude",
    };
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

const runCodexAgent = async (
  prompt: string,
  opts: Options
): Promise<RunResult> => {
  if (!runnerState.useAppServer()) {
    return runnerState.runLegacyAgent("codex", prompt, opts);
  }

  const renderer = createCodexRenderer({
    format: opts.format,
    write: (text) => {
      process.stdout.write(text);
    },
  });

  activeAppServerRuns += 1;
  syncSignalHandlers();
  try {
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

    const result = await runCodexTurn(prompt, opts, {
      onRaw: renderer.onRawLine,
    });
    const finalParsed = result.parsed || renderer.getParsed();
    if (
      opts.format === "pretty" &&
      renderer.wrotePretty() &&
      !finalParsed.endsWith("\n")
    ) {
      process.stdout.write("\n");
    }
    return { ...result, parsed: finalParsed };
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
      return runnerState.runLegacyAgent("codex", prompt, opts);
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
  opts: Options
): Promise<RunResult> => {
  const { args, cmd } = buildCommand(agent, prompt, opts.model);
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
  opts: Options
): Promise<RunResult> => runLegacyAgent(agent, prompt, opts);

export const runnerInternals = {
  reset(): void {
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
  opts: Options
): Promise<RunResult> => {
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
    await startClaudeSdk();
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

export const runAgent = (
  agent: Agent,
  prompt: string,
  opts: Options
): Promise<RunResult> => {
  if (agent === "codex") {
    return runCodexAgent(prompt, opts);
  }
  if (agent === "claude") {
    return runClaudeAgent(prompt, opts);
  }
  return runLegacyAgent(agent, prompt, opts);
};
