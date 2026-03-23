import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { resolve } from "node:path";
import type { Options, RunResult } from "../../src/loop/types";

interface AppServerModule {
  CodexAppServerFallbackError: typeof Error;
  CodexAppServerUnexpectedExitError: typeof Error;
}

const CODEX_TRANSPORT_ENV = "CODEX_TRANSPORT";
const CODEX_TRANSPORT_EXEC = "exec";
const projectRoot = process.cwd();
const runnerPath = resolve(projectRoot, "src/loop/runner.ts");
const runnerImportPath = `${runnerPath}?runner-test`;
const claudeSdkPath = resolve(projectRoot, "src/loop/claude-sdk-server.ts");
const codexAppServerPath = resolve(projectRoot, "src/loop/codex-app-server.ts");

type MockFn<T extends (...args: unknown[]) => unknown> = ReturnType<
  typeof mock<T>
>;

const makeResult = (overrides: Partial<RunResult> = {}): RunResult => ({
  combined: "",
  exitCode: 0,
  parsed: "",
  ...overrides,
});

const makeOptions = (opts: Partial<Options> = {}): Options => ({
  agent: "codex",
  codexModel: "test-model",
  doneSignal: "<done/>",
  format: "raw",
  maxIterations: 1,
  proof: "verify",
  ...opts,
});

class RunnerCodexFallbackError extends Error {}
class RunnerCodexUnexpectedExitError extends RunnerCodexFallbackError {}
const appServerFallback: AppServerModule["CodexAppServerFallbackError"] =
  RunnerCodexFallbackError;
const appServerUnexpectedExit: AppServerModule["CodexAppServerUnexpectedExitError"] =
  RunnerCodexUnexpectedExitError;

const hasAppServerProcess: MockFn<() => boolean> = mock(() => false);
const interruptAppServer: MockFn<(signal: "SIGINT" | "SIGTERM") => void> = mock(
  () => undefined
);
const runCodexTurn: MockFn<
  (
    _prompt: string,
    _opts: Options,
    _callbacks: {
      onParsed?: (text: string) => void;
      onRaw: (text: string) => void;
    }
  ) => Promise<RunResult>
> = mock(async () => makeResult());
const runLegacyAgent: MockFn<
  (
    agent: string,
    prompt: string,
    opts: Options,
    sessionId?: string,
    kind?: string
  ) => Promise<RunResult>
> = mock(async () => makeResult());
const hasClaudeSdkProcess: MockFn<() => boolean> = mock(() => false);
const interruptClaudeSdk: MockFn<(signal: "SIGINT" | "SIGTERM") => void> = mock(
  () => undefined
);
const runClaudeTurn: MockFn<
  (
    _prompt: string,
    _opts: Options,
    _callbacks: {
      onDelta: (text: string) => void;
      onParsed: (text: string) => void;
      onRaw: (text: string) => void;
    }
  ) => Promise<RunResult>
> = mock(async () => makeResult());
const startClaudeSdk: MockFn<
  (
    model?: string,
    sessionId?: string,
    launchOptions?: { mcpConfig?: string; persistent?: boolean }
  ) => Promise<void>
> = mock(async () => undefined);
let runAgent: (
  agent: string,
  prompt: string,
  opts: Options
) => Promise<RunResult>;
let runReviewerAgent: (
  agent: string,
  prompt: string,
  opts: Options
) => Promise<RunResult>;
let startPersistentAgentSession: (
  agent: string,
  opts: Options,
  sessionId?: string,
  sessionOptions?: {
    claudeLaunch?: { mcpConfig?: string; persistent?: boolean };
    codexLaunch?: {
      configValues?: string[];
      persistentThread?: boolean;
      resumeThreadId?: string;
      threadModel?: string;
    };
  },
  kind?: "review" | "work"
) => Promise<void>;
let buildCommand: (
  agent: string,
  prompt: string,
  model: string
) => { args: string[]; cmd: string };
const startAppServer: MockFn<
  (launchOptions?: {
    configValues?: string[];
    persistentThread?: boolean;
  }) => Promise<void>
> = mock(async () => undefined);
const useAppServer: MockFn<() => boolean> = mock(
  () => process.env[CODEX_TRANSPORT_ENV] !== CODEX_TRANSPORT_EXEC
);
let runnerInternals: {
  reset: () => void;
  setLegacyAgent: (
    next: (agent: string, prompt: string, opts: Options) => Promise<RunResult>
  ) => void;
  setUseAppServer: (next: () => boolean) => void;
};

const installCodexServerMock = (): void => {
  mock.module(codexAppServerPath, () => ({
    CODEX_TRANSPORT_ENV,
    CODEX_TRANSPORT_EXEC,
    CodexAppServerFallbackError: appServerFallback,
    CodexAppServerUnexpectedExitError: appServerUnexpectedExit,
    hasAppServerProcess,
    interruptAppServer,
    runCodexTurn,
    runLegacyAgent,
    startAppServer,
    useAppServer,
  }));
};

const installClaudeSdkMock = (): void => {
  mock.module(claudeSdkPath, () => ({
    hasClaudeSdkProcess,
    interruptClaudeSdk,
    runClaudeTurn,
    startClaudeSdk,
  }));
};

mock.restore();
installCodexServerMock();
installClaudeSdkMock();

beforeEach(async () => {
  mock.restore();
  installCodexServerMock();
  installClaudeSdkMock();
  ({
    runAgent,
    runReviewerAgent,
    buildCommand,
    runnerInternals,
    startPersistentAgentSession,
  } = await import(runnerImportPath));
  process.env[CODEX_TRANSPORT_ENV] = "";
  startAppServer.mockReset();
  startAppServer.mockResolvedValue(undefined);
  hasAppServerProcess.mockReset();
  hasAppServerProcess.mockReturnValue(false);
  interruptAppServer.mockReset();
  runCodexTurn.mockReset();
  runCodexTurn.mockResolvedValue(makeResult());
  runLegacyAgent.mockReset();
  runLegacyAgent.mockResolvedValue(makeResult());
  hasClaudeSdkProcess.mockReset();
  hasClaudeSdkProcess.mockReturnValue(false);
  interruptClaudeSdk.mockReset();
  runClaudeTurn.mockReset();
  runClaudeTurn.mockResolvedValue(makeResult());
  startClaudeSdk.mockReset();
  startClaudeSdk.mockResolvedValue(undefined);
  useAppServer.mockReset();
  useAppServer.mockImplementation(
    () => process.env[CODEX_TRANSPORT_ENV] !== CODEX_TRANSPORT_EXEC
  );
  runnerInternals.reset();
  runnerInternals.setUseAppServer(() => useAppServer());
  runnerInternals.setLegacyAgent(
    (agent: string, prompt: string, opts: Options) =>
      runLegacyAgent(agent, prompt, opts)
  );
});

afterAll(() => {
  mock.restore();
});

test("runAgent uses non-persistent app-server threads by default", async () => {
  const result = await runAgent("codex", "say hello", makeOptions());

  expect(result.exitCode).toBe(0);
  expect(startAppServer).toHaveBeenCalledTimes(1);
  expect(startAppServer.mock.calls[0]?.[0]).toMatchObject({
    persistentThread: false,
  });
  expect(runCodexTurn).toHaveBeenCalledTimes(1);
  expect(runnerInternals).toBeDefined();
});

test("runAgent keeps app-server threads persistent for explicit resume", async () => {
  const result = await runAgent(
    "codex",
    "say hello",
    makeOptions(),
    "thread-1"
  );

  expect(result.exitCode).toBe(0);
  expect(startAppServer).toHaveBeenCalledTimes(1);
  expect(startAppServer.mock.calls[0]?.[0]).toMatchObject({
    persistentThread: true,
  });
});

test("buildCommand uses the provided Claude model", () => {
  const command = buildCommand(
    "claude",
    "summarize the issue",
    "sonnet-review"
  );
  const modelArgIndex = command.args.indexOf("--model");
  expect(modelArgIndex).toBeGreaterThan(-1);
  expect(command.args[modelArgIndex + 1]).toBe("sonnet-review");
});

test("runAgent honors CODEX_TRANSPORT=exec and uses legacy codex exec", async () => {
  process.env[CODEX_TRANSPORT_ENV] = CODEX_TRANSPORT_EXEC;
  runnerInternals.setUseAppServer(() => false);
  runLegacyAgent.mockResolvedValue(makeResult({ parsed: "legacy done" }));

  const result = await runAgent("codex", "say hello", makeOptions());

  expect(result.exitCode).toBe(0);
  expect(result.parsed).toBe("legacy done");
  expect(runLegacyAgent).toHaveBeenCalledTimes(1);
  expect(startAppServer).not.toHaveBeenCalled();
  expect(runCodexTurn).not.toHaveBeenCalled();
  expect(useAppServer).not.toHaveBeenCalled();
});

test("runAgent propagates turn/completed success exit code", async () => {
  runCodexTurn.mockResolvedValue(makeResult({ exitCode: 0, parsed: "done" }));

  const result = await runAgent("codex", "say hi", makeOptions());

  expect(result.exitCode).toBe(0);
});

test("runAgent propagates turn/completed failure exit code", async () => {
  runCodexTurn.mockResolvedValue(makeResult({ exitCode: 1, parsed: "failed" }));

  const result = await runAgent("codex", "say hi", makeOptions());

  expect(result.exitCode).toBe(1);
  expect(result.parsed).toBe("failed");
});

test("runReviewerAgent uses codex reviewer model for codex reviews", async () => {
  process.env[CODEX_TRANSPORT_ENV] = CODEX_TRANSPORT_EXEC;
  runnerInternals.setUseAppServer(() => false);

  await runReviewerAgent(
    "codex",
    "review this",
    makeOptions({ codexReviewerModel: "codex-review" })
  );

  expect(runLegacyAgent).toHaveBeenCalledTimes(1);
  expect(runLegacyAgent.mock.calls[0]?.[2]).toMatchObject({
    codexModel: "codex-review",
  });
});

test("runReviewerAgent uses claude reviewer model for claude reviews", async () => {
  await runReviewerAgent(
    "claude",
    "review this",
    makeOptions({ claudeReviewerModel: "claude-review" })
  );

  expect(startClaudeSdk).toHaveBeenCalledWith("claude-review", undefined);
});

test("startPersistentAgentSession enables persistent Claude sessions", async () => {
  await startPersistentAgentSession(
    "claude",
    makeOptions({ claudeReviewerModel: "claude-review" }),
    "session-1",
    { claudeLaunch: { mcpConfig: "/tmp/bridge.json" } },
    "review"
  );

  expect(startClaudeSdk).toHaveBeenCalledWith("claude-review", "session-1", {
    mcpConfig: "/tmp/bridge.json",
    persistent: true,
  });
});

test("startPersistentAgentSession enables persistent Codex threads", async () => {
  await startPersistentAgentSession("codex", makeOptions(), undefined, {
    codexLaunch: { configValues: ['mcp_servers.bridge.command="/bin/echo"'] },
  });

  expect(startAppServer).toHaveBeenCalledWith(
    expect.objectContaining({
      configValues: ['mcp_servers.bridge.command="/bin/echo"'],
      persistentThread: true,
      threadModel: "test-model",
    })
  );
});

test("startPersistentAgentSession resumes persistent Codex threads", async () => {
  await startPersistentAgentSession(
    "codex",
    makeOptions(),
    "thread-1",
    undefined,
    "review"
  );

  expect(startAppServer).toHaveBeenCalledWith(
    expect.objectContaining({
      persistentThread: true,
      resumeThreadId: "thread-1",
      threadModel: "test-model",
    })
  );
});

test("runAgent inserts pretty-mode blank line after message completion", async () => {
  runCodexTurn.mockImplementation((_prompt, _opts, callbacks) => {
    callbacks.onRaw(
      JSON.stringify({
        method: "item/agentMessage/delta",
        params: { itemId: "item-1", delta: "I checked the repo." },
      })
    );
    callbacks.onRaw(
      JSON.stringify({
        method: "item/completed",
        params: {
          item: {
            id: "item-1",
            type: "agentMessage",
            content: [{ text: "I checked the repo." }],
          },
        },
      })
    );
    callbacks.onRaw(
      JSON.stringify({
        method: "item/agentMessage/delta",
        params: { itemId: "item-2", delta: "I am updating PLAN.md." },
      })
    );
    return Promise.resolve(makeResult());
  });

  const originalWrite = process.stdout.write;
  const writes: string[] = [];
  const writeSpy = mock((chunk: string | Uint8Array): boolean => {
    writes.push(
      typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8")
    );
    return true;
  });
  (process.stdout as { write: typeof writeSpy }).write = writeSpy;

  try {
    const result = await runAgent(
      "codex",
      "say hi",
      makeOptions({ format: "pretty" })
    );
    expect(result.parsed).toBe("I checked the repo.\nI am updating PLAN.md.");
    expect(writes.join("")).toContain(
      "I checked the repo.\n\nI am updating PLAN.md.\n"
    );
  } finally {
    process.stdout.write = originalWrite;
  }
});

test("runAgent preserves nested delta newline content in pretty mode", async () => {
  runCodexTurn.mockImplementation((_prompt, _opts, callbacks) => {
    callbacks.onRaw(
      JSON.stringify({
        method: "item/agentMessage/delta",
        params: {
          delta: {
            text: "Heading",
            content: [{ text: "\n- one" }, { text: "\n- two" }],
          },
        },
      })
    );
    return Promise.resolve(makeResult());
  });

  const originalWrite = process.stdout.write;
  const writes: string[] = [];
  const writeSpy = mock((chunk: string | Uint8Array): boolean => {
    writes.push(
      typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8")
    );
    return true;
  });
  (process.stdout as { write: typeof writeSpy }).write = writeSpy;

  try {
    const result = await runAgent(
      "codex",
      "say hi",
      makeOptions({ format: "pretty" })
    );
    expect(result.parsed).toBe("Heading\n- one\n- two");
    expect(writes.join("")).toContain("Heading\n- one\n- two\n");
  } finally {
    process.stdout.write = originalWrite;
  }
});

test("runAgent retries once after an unexpected app-server exit", async () => {
  let attempts = 0;
  runCodexTurn.mockImplementation((_prompt, _opts, callbacks) => {
    attempts += 1;
    if (attempts === 1) {
      callbacks.onRaw(
        JSON.stringify({
          method: "item/agentMessage/delta",
          params: { delta: "partial output" },
        })
      );
      throw new appServerUnexpectedExit("codex app-server exited unexpectedly");
    }
    callbacks.onRaw(
      JSON.stringify({
        method: "item/agentMessage/delta",
        params: { delta: "final output" },
      })
    );
    return Promise.resolve(makeResult());
  });

  const originalError = console.error;
  const errorSpy = mock(() => undefined);
  console.error = errorSpy;

  try {
    const result = await runAgent("codex", "say hi", makeOptions());

    expect(result.exitCode).toBe(0);
    expect(result.parsed).toBe("final output");
    expect(startAppServer).toHaveBeenCalledTimes(2);
    expect(startAppServer.mock.calls[0]?.[0]).toMatchObject({
      persistentThread: false,
    });
    expect(startAppServer.mock.calls[1]?.[0]).toMatchObject({
      persistentThread: false,
    });
    expect(runCodexTurn).toHaveBeenCalledTimes(2);
    expect(runLegacyAgent).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith(
      "[loop] codex app-server exited unexpectedly. Restarting app-server and retrying."
    );
  } finally {
    console.error = originalError;
  }
});

test("runAgent falls back after retrying an unexpected app-server exit", async () => {
  runCodexTurn.mockImplementation(() => {
    throw new appServerUnexpectedExit("codex app-server exited unexpectedly");
  });

  const originalError = console.error;
  const errorSpy = mock(() => undefined);
  console.error = errorSpy;

  try {
    const result = await runAgent("codex", "say hi", makeOptions());

    expect(result.exitCode).toBe(0);
    expect(startAppServer).toHaveBeenCalledTimes(2);
    expect(runCodexTurn).toHaveBeenCalledTimes(2);
    expect(runLegacyAgent).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledTimes(2);
    expect(errorSpy).toHaveBeenNthCalledWith(
      1,
      "[loop] codex app-server exited unexpectedly. Restarting app-server and retrying."
    );
    expect(errorSpy).toHaveBeenNthCalledWith(
      2,
      "[loop] codex app-server transport failed. Falling back to `codex exec --json`."
    );
  } finally {
    console.error = originalError;
  }
});

test("runAgent only falls back to legacy once per process for app-server compatibility errors", async () => {
  runCodexTurn.mockImplementation(() => {
    throw new appServerFallback("app-server unsupported");
  });

  const originalError = console.error;
  const errorSpy = mock(() => undefined);
  console.error = errorSpy;

  try {
    const first = await runAgent("codex", "say hi", makeOptions());
    const second = await runAgent("codex", "say hi again", makeOptions());

    expect(first.exitCode).toBe(0);
    expect(second.exitCode).toBe(0);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith(
      "[loop] codex app-server transport failed. Falling back to `codex exec --json`."
    );
    expect(runLegacyAgent).toHaveBeenCalledTimes(2);
  } finally {
    console.error = originalError;
  }
});

test("runAgent does not fallback on non-compatibility app-server failures", async () => {
  runCodexTurn.mockImplementation(() => {
    throw new Error("something else");
  });

  await expect(runAgent("codex", "say hi", makeOptions())).rejects.toThrow(
    "something else"
  );
  expect(runLegacyAgent).not.toHaveBeenCalled();
});

test("SIGINT forwards to interruptAppServer while app-server run is active", async () => {
  let resolveTurn: ((result: RunResult) => void) | undefined;
  runCodexTurn.mockImplementation(
    () =>
      new Promise<RunResult>((resolve) => {
        resolveTurn = resolve;
      })
  );

  const signalBase = process.listenerCount("SIGINT");
  const signalTermBase = process.listenerCount("SIGTERM");

  const originalExit = process.exit;
  const exitSpy = mock((code?: number): never => {
    return code as never;
  });
  (process as { exit: typeof exitSpy }).exit = exitSpy;

  try {
    const pending = runAgent("codex", "say hi", makeOptions());

    await Promise.resolve();
    expect(process.listenerCount("SIGINT")).toBe(signalBase + 1);
    expect(process.listenerCount("SIGTERM")).toBe(signalTermBase + 1);

    process.emit("SIGINT");
    expect(interruptAppServer).toHaveBeenCalledTimes(1);
    expect(interruptAppServer).toHaveBeenCalledWith("SIGINT");
    expect(exitSpy).toHaveBeenCalledWith(130);

    resolveTurn?.(makeResult());
    const result = await pending;
    expect(result.exitCode).toBe(0);
    expect(process.listenerCount("SIGINT")).toBe(signalBase);
    expect(process.listenerCount("SIGTERM")).toBe(signalTermBase);
  } finally {
    process.exit = originalExit;
  }
});
