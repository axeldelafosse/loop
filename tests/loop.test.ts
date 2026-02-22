import { afterEach, expect, mock, test } from "bun:test";
import type { Options } from "../src/loop/types";

const makeOptions = (): Options => ({
  agent: "codex",
  doneSignal: "<done/>",
  proof: "verify with tests",
  format: "pretty",
  maxIterations: 2,
  model: "test-model",
  review: "claudex",
  tmux: false,
  worktree: false,
});

afterEach(() => {
  mock.restore();
});

interface CliModuleDeps {
  maybeEnterWorktree?: (opts: Options) => void | Promise<void>;
  parseArgs?: (argv: string[]) => Options;
  resolveTask?: (opts: Options) => Promise<string>;
  runInTmux?: (argv: string[]) => boolean;
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

  mock.module("../src/loop/deps", () => ({
    cliDeps: {
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

  const { runCli } = await import(`../src/loop?test=${Date.now()}`);
  return {
    applyStagedMock,
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

test("runCli starts panel when argv is empty", async () => {
  const {
    maybeEnterWorktreeMock,
    parseArgsMock,
    resolveTaskMock,
    runCli,
    runInTmuxMock,
    runLoopMock,
    runPanelMock,
  } = await loadRunCli();

  await runCli([]);

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
});

test("runCli delegates to tmux and skips task flow when tmux run starts", async () => {
  const opts = { ...makeOptions(), tmux: true };
  const {
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

  expect(runInTmuxMock).toHaveBeenCalledWith([
    "--tmux",
    "--proof",
    "verify with tests",
  ]);
  expect(maybeEnterWorktreeMock).not.toHaveBeenCalled();
  expect(resolveTaskMock).not.toHaveBeenCalled();
  expect(runLoopMock).not.toHaveBeenCalled();
  expect(runPanelMock).not.toHaveBeenCalled();
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
