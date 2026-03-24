import { afterEach, expect, mock, test } from "bun:test";
import type { Options } from "../src/loop/types";

const makeOptions = (): Options => ({
  agent: "codex",
  doneSignal: "<done/>",
  proof: "verify with tests",
  format: "pretty",
  maxIterations: 2,
  codexModel: "test-model",
  pairedMode: true,
  review: "claudex",
  tmux: false,
  worktree: false,
});

const makeOnlyOptions = (
  agent: Options["agent"],
  overrides: Partial<Options> = {}
): Options => ({
  ...makeOptions(),
  agent,
  pairedMode: false,
  review: agent,
  reviewPlan: agent,
  ...overrides,
});

afterEach(() => {
  mock.restore();
});

interface CliModuleDeps {
  checkGitState?: () => string | undefined;
  maybeEnterWorktree?: (opts: Options) => void | Promise<void>;
  parseArgs?: (argv: string[]) => Options;
  resolveTask?: (opts: Options) => Promise<string>;
  runInTmux?: (
    argv: string[],
    overrides?: unknown,
    launch?: { opts: Options; task?: string }
  ) => boolean | Promise<boolean>;
  runLoop?: (task: string, opts: Options) => Promise<void>;
  runPanel?: () => Promise<void>;
}

interface UpdateModuleDeps {
  applyStagedUpdateOnStartup?: () => Promise<void>;
  handleManualUpdateCommand?: (argv: string[]) => Promise<boolean>;
  startAutoUpdateCheck?: () => void;
}

const loadRunCli = async (
  deps: CliModuleDeps = {},
  updateOverrides: UpdateModuleDeps = {}
) => {
  const checkGitStateMock = mock(deps.checkGitState ?? (() => undefined));
  const maybeEnterWorktreeMock = mock(
    deps.maybeEnterWorktree ?? (() => undefined)
  );
  const parseArgsMock = mock(deps.parseArgs ?? (() => makeOptions()));
  const resolveTaskMock = mock(deps.resolveTask ?? (async () => "task"));
  const runInTmuxMock = mock(deps.runInTmux ?? (() => false));
  const runLoopMock = mock(deps.runLoop ?? (async () => undefined));
  const runPanelMock = mock(deps.runPanel ?? (async () => undefined));

  const applyStagedMock = mock(
    updateOverrides.applyStagedUpdateOnStartup ?? (async () => undefined)
  );
  const handleManualMock = mock(
    updateOverrides.handleManualUpdateCommand ?? (async () => false)
  );
  const startAutoCheckMock = mock(
    updateOverrides.startAutoUpdateCheck ?? (() => undefined)
  );
  const closeAppServerMock = mock(async () => undefined);
  const closeClaudeSdkMock = mock(async () => undefined);
  const actualCodexAppServer = await import(
    `../src/loop/codex-app-server?actual=${Date.now()}`
  );
  const actualClaudeSdk = await import(
    `../src/loop/claude-sdk-server?actual=${Date.now()}`
  );

  mock.module("../src/loop/deps", () => ({
    cliDeps: {
      checkGitState: checkGitStateMock,
      maybeEnterWorktree: maybeEnterWorktreeMock,
      parseArgs: parseArgsMock,
      resolveTask: resolveTaskMock,
      runInTmux: runInTmuxMock,
      runLoop: runLoopMock,
      runPanel: runPanelMock,
    },
  }));

  mock.module("../src/loop/update-deps", () => ({
    updateDeps: {
      applyStagedUpdateOnStartup: applyStagedMock,
      handleManualUpdateCommand: handleManualMock,
      startAutoUpdateCheck: startAutoCheckMock,
    },
  }));

  mock.module("../src/loop/codex-app-server", () => ({
    ...actualCodexAppServer,
    closeAppServer: closeAppServerMock,
  }));

  mock.module("../src/loop/claude-sdk-server", () => ({
    ...actualClaudeSdk,
    closeClaudeSdk: closeClaudeSdkMock,
  }));

  const { runCli } = await import(`../src/cli?test=${Date.now()}`);
  return {
    applyStagedMock,
    checkGitStateMock,
    closeAppServerMock,
    closeClaudeSdkMock,
    handleManualMock,
    maybeEnterWorktreeMock,
    parseArgsMock,
    resolveTaskMock,
    runCli,
    runInTmuxMock,
    runLoopMock,
    runPanelMock,
    startAutoCheckMock,
  };
};

test("runCli defaults empty argv to paired interactive tmux mode", async () => {
  const opts = { ...makeOptions(), proof: "", tmux: true };
  const {
    closeAppServerMock,
    closeClaudeSdkMock,
    maybeEnterWorktreeMock,
    parseArgsMock,
    resolveTaskMock,
    runCli,
    runInTmuxMock,
    runLoopMock,
    runPanelMock,
  } = await loadRunCli({
    parseArgs: () => opts,
    runInTmux: () => true,
  });

  await runCli([]);

  expect(runPanelMock).not.toHaveBeenCalled();
  expect(parseArgsMock).toHaveBeenCalledWith(["--tmux"]);
  expect(maybeEnterWorktreeMock).toHaveBeenCalledTimes(1);
  expect(runInTmuxMock).toHaveBeenCalledWith(["--tmux"], undefined, {
    opts,
  });
  expect(resolveTaskMock).not.toHaveBeenCalled();
  expect(runLoopMock).not.toHaveBeenCalled();
  expect(closeAppServerMock).not.toHaveBeenCalled();
  expect(closeClaudeSdkMock).not.toHaveBeenCalled();
});

test("runCli starts panel for dashboard command", async () => {
  const {
    maybeEnterWorktreeMock,
    parseArgsMock,
    resolveTaskMock,
    runCli,
    runInTmuxMock,
    runLoopMock,
    runPanelMock,
  } = await loadRunCli();

  await runCli(["dashboard"]);

  expect(runPanelMock).toHaveBeenCalledTimes(1);
  expect(maybeEnterWorktreeMock).not.toHaveBeenCalled();
  expect(runInTmuxMock).not.toHaveBeenCalled();
  expect(parseArgsMock).not.toHaveBeenCalled();
  expect(resolveTaskMock).not.toHaveBeenCalled();
  expect(runLoopMock).not.toHaveBeenCalled();
});

test("runCli runs task flow when argv has options", async () => {
  const opts = makeOptions();
  const {
    closeAppServerMock,
    closeClaudeSdkMock,
    maybeEnterWorktreeMock,
    parseArgsMock,
    resolveTaskMock,
    runCli,
    runInTmuxMock,
    runLoopMock,
    runPanelMock,
  } = await loadRunCli({
    parseArgs: () => opts,
    resolveTask: async () => "ship feature",
  });

  await runCli(["--proof", "verify with tests"]);

  expect(runPanelMock).not.toHaveBeenCalled();
  expect(maybeEnterWorktreeMock).toHaveBeenCalledWith(opts);
  expect(runInTmuxMock).not.toHaveBeenCalled();
  expect(parseArgsMock).toHaveBeenCalledWith(["--proof", "verify with tests"]);
  expect(resolveTaskMock).toHaveBeenCalledWith(opts);
  expect(runLoopMock).toHaveBeenCalledWith("ship feature", opts);
  expect(closeAppServerMock).toHaveBeenCalledTimes(1);
  expect(closeClaudeSdkMock).toHaveBeenCalledTimes(1);
  expect(opts.pairedMode).toBe(true);
});

test("runCli delegates paired tmux after resolving the task", async () => {
  const opts = { ...makeOptions(), tmux: true };
  const {
    closeAppServerMock,
    closeClaudeSdkMock,
    maybeEnterWorktreeMock,
    runCli,
    runInTmuxMock,
    resolveTaskMock,
    runLoopMock,
    runPanelMock,
  } = await loadRunCli({
    parseArgs: () => opts,
    runInTmux: () => true,
    resolveTask: async () => "ship feature",
  });

  await runCli(["--tmux", "--proof", "verify with tests"]);

  expect(maybeEnterWorktreeMock).toHaveBeenCalledWith(opts);
  expect(resolveTaskMock).toHaveBeenCalledWith(opts);
  expect(runInTmuxMock).toHaveBeenCalledWith(
    ["--tmux", "--proof", "verify with tests"],
    undefined,
    { opts, task: "ship feature" }
  );
  expect(runLoopMock).not.toHaveBeenCalled();
  expect(runPanelMock).not.toHaveBeenCalled();
  expect(closeAppServerMock).not.toHaveBeenCalled();
  expect(closeClaudeSdkMock).not.toHaveBeenCalled();
});

test("runCli starts paired interactive tmux without resolving a task", async () => {
  const opts = { ...makeOptions(), proof: "", tmux: true };
  const {
    closeAppServerMock,
    closeClaudeSdkMock,
    maybeEnterWorktreeMock,
    runCli,
    runInTmuxMock,
    resolveTaskMock,
    runLoopMock,
    runPanelMock,
  } = await loadRunCli({
    parseArgs: () => opts,
    runInTmux: () => true,
  });

  await runCli(["--tmux"]);

  expect(runPanelMock).not.toHaveBeenCalled();
  expect(maybeEnterWorktreeMock).toHaveBeenCalledWith(opts);
  expect(resolveTaskMock).not.toHaveBeenCalled();
  expect(runInTmuxMock).toHaveBeenCalledWith(["--tmux"], undefined, { opts });
  expect(runLoopMock).not.toHaveBeenCalled();
  expect(closeAppServerMock).not.toHaveBeenCalled();
  expect(closeClaudeSdkMock).not.toHaveBeenCalled();
});

test("runCli keeps normal flow when already in tmux session", async () => {
  const opts = { ...makeOptions(), tmux: true };
  const {
    maybeEnterWorktreeMock,
    resolveTaskMock,
    runCli,
    runInTmuxMock,
    runLoopMock,
    runPanelMock,
  } = await loadRunCli({
    parseArgs: () => opts,
    runInTmux: () => false,
    resolveTask: async () => "ship feature",
  });

  await runCli(["--tmux", "--proof", "verify with tests"]);

  expect(runInTmuxMock).toHaveBeenCalledTimes(1);
  expect(maybeEnterWorktreeMock).toHaveBeenCalledWith(opts);
  expect(resolveTaskMock).toHaveBeenCalledWith(opts);
  expect(runLoopMock).toHaveBeenCalledWith("ship feature", opts);
  expect(runPanelMock).not.toHaveBeenCalled();
});

test("runCli prints tmux detach hint first when inside tmux", async () => {
  const originalTmux = process.env.TMUX;
  const originalLog = console.log;
  const logMock = mock((): void => undefined);
  const opts = makeOptions();
  const { runCli } = await loadRunCli({
    parseArgs: () => opts,
    runInTmux: () => false,
    resolveTask: async () => "ship feature",
  });

  process.env.TMUX = "1";
  console.log = logMock;

  try {
    await runCli(["--proof", "verify with tests"]);
  } finally {
    process.env.TMUX = originalTmux;
    console.log = originalLog;
  }

  expect(logMock).toHaveBeenCalledTimes(1);
  expect(logMock).toHaveBeenCalledWith("[loop] detach with Ctrl-b d");
});

test("runCli does not print tmux detach hint outside tmux", async () => {
  const originalTmux = process.env.TMUX;
  const originalLog = console.log;
  const logMock = mock((): void => undefined);
  const opts = makeOptions();
  const { runCli } = await loadRunCli({
    parseArgs: () => opts,
    runInTmux: () => false,
    resolveTask: async () => "ship feature",
  });

  Reflect.deleteProperty(process.env, "TMUX");
  console.log = logMock;

  try {
    await runCli(["--proof", "verify with tests"]);
  } finally {
    process.env.TMUX = originalTmux;
    console.log = originalLog;
  }

  expect(logMock).not.toHaveBeenCalled();
});

test("runCli creates worktree before resolving task when --worktree is set", async () => {
  const calls: string[] = [];
  const opts = { ...makeOptions(), worktree: true };
  const { maybeEnterWorktreeMock, runCli, runLoopMock } = await loadRunCli({
    maybeEnterWorktree: () => {
      calls.push("worktree");
    },
    parseArgs: () => opts,
    runInTmux: () => false,
    resolveTask: async () => {
      await Promise.resolve();
      calls.push("resolve");
      return "ship feature";
    },
  });

  await runCli(["--worktree", "--proof", "verify with tests"]);

  expect(maybeEnterWorktreeMock).toHaveBeenCalledWith(opts);
  expect(calls).toEqual(["worktree", "resolve"]);
  expect(runLoopMock).toHaveBeenCalledWith("ship feature", opts);
});

test("runCli keeps claude-only task flow intact", async () => {
  const opts = makeOnlyOptions("claude", { sessionId: "run-123" });
  const {
    maybeEnterWorktreeMock,
    parseArgsMock,
    resolveTaskMock,
    runCli,
    runInTmuxMock,
    runLoopMock,
    runPanelMock,
  } = await loadRunCli({
    parseArgs: () => opts,
    resolveTask: async () => "ship feature",
  });

  await runCli(["--claude-only", "--session", "run-123", "--proof", "verify"]);

  expect(runPanelMock).not.toHaveBeenCalled();
  expect(runInTmuxMock).not.toHaveBeenCalled();
  expect(maybeEnterWorktreeMock).toHaveBeenCalledWith(opts);
  expect(parseArgsMock).toHaveBeenCalledWith([
    "--claude-only",
    "--session",
    "run-123",
    "--proof",
    "verify",
  ]);
  expect(resolveTaskMock).toHaveBeenCalledWith(opts);
  expect(runLoopMock).toHaveBeenCalledWith("ship feature", opts);
  expect(opts.pairedMode).toBe(false);
});

test("runCli keeps codex-only tmux flow intact", async () => {
  const opts = makeOnlyOptions("codex", {
    sessionId: "resume-run",
    tmux: true,
    worktree: true,
  });
  const {
    closeAppServerMock,
    closeClaudeSdkMock,
    maybeEnterWorktreeMock,
    runCli,
    runInTmuxMock,
    resolveTaskMock,
    runLoopMock,
    runPanelMock,
  } = await loadRunCli({
    parseArgs: () => opts,
    runInTmux: () => true,
  });

  await runCli([
    "--codex-only",
    "--tmux",
    "--worktree",
    "--session",
    "resume-run",
    "--proof",
    "verify",
  ]);

  expect(runPanelMock).not.toHaveBeenCalled();
  expect(runInTmuxMock).toHaveBeenCalledWith([
    "--codex-only",
    "--tmux",
    "--worktree",
    "--session",
    "resume-run",
    "--proof",
    "verify",
  ]);
  expect(maybeEnterWorktreeMock).not.toHaveBeenCalled();
  expect(resolveTaskMock).not.toHaveBeenCalled();
  expect(runLoopMock).not.toHaveBeenCalled();
  expect(closeAppServerMock).not.toHaveBeenCalled();
  expect(closeClaudeSdkMock).not.toHaveBeenCalled();
  expect(opts.pairedMode).toBe(false);
});

test("runCli calls update hooks in correct order before task flow", async () => {
  const calls: string[] = [];
  const opts = makeOptions();
  const { runCli, applyStagedMock, handleManualMock, startAutoCheckMock } =
    await loadRunCli(
      {
        parseArgs: () => opts,
        resolveTask: () => {
          calls.push("resolveTask");
          return Promise.resolve("ship feature");
        },
      },
      {
        applyStagedUpdateOnStartup: () => {
          calls.push("applyStaged");
          return Promise.resolve();
        },
        handleManualUpdateCommand: () => {
          calls.push("handleManual");
          return Promise.resolve(false);
        },
        startAutoUpdateCheck: () => {
          calls.push("autoCheck");
        },
      }
    );

  await runCli(["--proof", "verify with tests"]);

  expect(applyStagedMock).toHaveBeenCalledTimes(1);
  expect(handleManualMock).toHaveBeenCalledTimes(1);
  expect(startAutoCheckMock).toHaveBeenCalledTimes(1);
  expect(calls).toEqual([
    "applyStaged",
    "handleManual",
    "autoCheck",
    "resolveTask",
  ]);
});

test("runCli returns early when handleManualUpdateCommand returns true", async () => {
  const { runCli, runLoopMock, runPanelMock } = await loadRunCli(
    {},
    {
      handleManualUpdateCommand: () => Promise.resolve(true),
    }
  );

  await runCli(["update"]);

  expect(runLoopMock).not.toHaveBeenCalled();
  expect(runPanelMock).not.toHaveBeenCalled();
});
