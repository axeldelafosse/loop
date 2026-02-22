import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { resolve } from "node:path";
import { DEFAULT_CLAUDE_MODEL } from "../../src/loop/constants";
import type { Options, RunResult } from "../../src/loop/types";

interface AppServerModule {
  CodexAppServerFallbackError: typeof Error;
}

const CODEX_TRANSPORT_ENV = "CODEX_TRANSPORT";
const CODEX_TRANSPORT_EXEC = "exec";
const projectRoot = process.cwd();
const runnerPath = resolve(projectRoot, "src/loop/runner.ts");
const runnerImportPath = `${runnerPath}?runner-test`;
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
  doneSignal: "<done/>",
  format: "raw",
  maxIterations: 1,
  model: "test-model",
  proof: "verify",
  ...opts,
});

class RunnerCodexFallbackError extends Error {}
const appServerFallback: AppServerModule["CodexAppServerFallbackError"] =
  RunnerCodexFallbackError;

const hasAppServerProcess: MockFn<() => boolean> = mock(() => false);
const interruptAppServer: MockFn<(signal: "SIGINT" | "SIGTERM") => void> = mock(
  () => undefined
);
const runCodexTurn: MockFn<
  (_prompt: string, _opts: Options) => Promise<RunResult>
> = mock(async () => makeResult());
const runLegacyAgent: MockFn<
  (agent: string, prompt: string, opts: Options) => Promise<RunResult>
> = mock(async () => makeResult());
let runAgent: (
  agent: string,
  prompt: string,
  opts: Options
) => Promise<RunResult>;
let buildCommand: (
  agent: string,
  prompt: string,
  model: string
) => { args: string[]; cmd: string };
const startAppServer: MockFn<() => Promise<void>> = mock(async () => undefined);
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
    hasAppServerProcess,
    interruptAppServer,
    runCodexTurn,
    runLegacyAgent,
    startAppServer,
    useAppServer,
  }));
};

mock.restore();
installCodexServerMock();

beforeEach(async () => {
  mock.restore();
  installCodexServerMock();
  ({ runAgent, buildCommand, runnerInternals } = await import(
    runnerImportPath
  ));
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

test("runAgent uses app-server transport by default", async () => {
  const result = await runAgent("codex", "say hello", makeOptions());

  expect(result.exitCode).toBe(0);
  expect(startAppServer).toHaveBeenCalledTimes(1);
  expect(runCodexTurn).toHaveBeenCalledTimes(1);
  expect(runnerInternals).toBeDefined();
});

test("buildCommand uses Opus for Claude regardless of codex-model override", () => {
  const command = buildCommand(
    "claude",
    "summarize the issue",
    "gpt-5.3-codex-spark"
  );
  const modelArgIndex = command.args.indexOf("--model");
  expect(modelArgIndex).toBeGreaterThan(-1);
  expect(command.args[modelArgIndex + 1]).toBe(DEFAULT_CLAUDE_MODEL);
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
