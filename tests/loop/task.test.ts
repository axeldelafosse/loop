import { afterEach, expect, mock, test } from "bun:test";
import type { Options, RunResult } from "../../src/loop/types";

const makeOptions = (
  promptInput?: string,
  overrides: Partial<Options> = {}
): Options => ({
  agent: "codex",
  doneSignal: "<done/>",
  proof: "verify with tests",
  format: "raw",
  maxIterations: 5,
  codexModel: "test-model",
  ...(promptInput ? { promptInput } : {}),
  ...overrides,
});

afterEach(() => {
  mock.restore();
});

interface TaskDeps {
  isFile?: (path: string) => boolean;
  preparePairedOptions?: (
    opts: Options,
    cwd?: string,
    createManifest?: boolean
  ) => void;
  readPrompt?: (input: string) => Promise<string>;
  runAgent?: (
    agent: Options["agent"],
    prompt: string,
    opts: Options,
    sessionId?: string
  ) => Promise<RunResult>;
}

const loadResolveTask = async (deps: TaskDeps = {}) => {
  const isFileMock = mock(deps.isFile ?? (() => false));
  const preparePairedOptionsMock = mock(
    deps.preparePairedOptions ?? (() => undefined)
  );
  const readPromptMock = mock(
    deps.readPrompt ?? (async (input: string) => input)
  );
  const runAgentMock = mock(
    deps.runAgent ??
      (async () => ({
        combined: "",
        exitCode: 0,
        parsed: "",
      }))
  );
  const realUtils = await import("../../src/loop/utils");

  mock.module("../../src/loop/utils", () => ({
    isFile: isFileMock,
    readPrompt: readPromptMock,
    hasSignal: realUtils.hasSignal,
  }));
  mock.module("../../src/loop/paired-options", () => ({
    preparePairedOptions: preparePairedOptionsMock,
  }));
  mock.module("../../src/loop/runner", () => ({
    runAgent: runAgentMock,
    runReviewerAgent: runAgentMock,
  }));

  const { resolveTask } = await import("../../src/loop/task");
  return {
    isFileMock,
    preparePairedOptionsMock,
    readPromptMock,
    resolveTask,
    runAgentMock,
  };
};

test("resolveTask throws when no prompt input and PLAN.md is missing", async () => {
  const { resolveTask } = await loadResolveTask();

  await expect(resolveTask(makeOptions())).rejects.toThrow(
    "Missing prompt. Use --prompt, pass positional text, or create PLAN.md."
  );
});

test("resolveTask uses PLAN.md when prompt input is missing", async () => {
  const { readPromptMock, resolveTask, runAgentMock } = await loadResolveTask({
    isFile: (path) => path === "PLAN.md",
    readPrompt: async () => "existing plan",
  });

  const task = await resolveTask(makeOptions());

  expect(task).toBe("existing plan");
  expect(readPromptMock).toHaveBeenCalledWith("PLAN.md");
  expect(runAgentMock).not.toHaveBeenCalled();
});

test("resolveTask reads markdown prompt input directly", async () => {
  const { resolveTask, runAgentMock } = await loadResolveTask({
    readPrompt: async () => "direct markdown task",
  });

  const task = await resolveTask(makeOptions("TASK.md"));

  expect(task).toBe("direct markdown task");
  expect(runAgentMock).not.toHaveBeenCalled();
});

test("resolveTask treats spaced text ending with .md as prompt text", async () => {
  const { resolveTask, runAgentMock } = await loadResolveTask({
    isFile: (path) => path === "PLAN.md",
    readPrompt: async (input) =>
      input === "PLAN.md" ? "generated plan task" : input,
    runAgent: async () => ({
      combined: "",
      exitCode: 0,
      parsed: "<done/>",
    }),
  });

  const task = await resolveTask(makeOptions("fix bug in README.md"));
  expect(task).toBe("generated plan task");
  expect(runAgentMock).toHaveBeenCalledTimes(2);
  expect(runAgentMock).toHaveBeenNthCalledWith(
    1,
    "codex",
    expect.stringContaining("Task:\nfix bug in README.md"),
    expect.any(Object)
  );
  expect(runAgentMock).toHaveBeenNthCalledWith(
    2,
    "claude",
    expect.stringContaining("Plan review mode:"),
    expect.any(Object)
  );
});

test("resolveTask creates PLAN.md first for plain-text prompt input", async () => {
  const { readPromptMock, resolveTask, runAgentMock } = await loadResolveTask({
    isFile: (path) => path === "PLAN.md",
    readPrompt: async (input) =>
      input === "PLAN.md" ? "generated plan task" : "unexpected read",
    runAgent: async () => ({
      combined: "",
      exitCode: 0,
      parsed: "<done/>",
    }),
  });

  const task = await resolveTask(makeOptions("ship feature"));

  expect(task).toBe("generated plan task");
  expect(runAgentMock).toHaveBeenCalledTimes(2);
  expect(runAgentMock).toHaveBeenNthCalledWith(
    1,
    "codex",
    expect.stringContaining("Task:\nship feature"),
    expect.any(Object)
  );
  expect(runAgentMock).toHaveBeenNthCalledWith(
    2,
    "claude",
    expect.stringContaining("Plan review mode:"),
    expect.any(Object)
  );
  expect(readPromptMock).toHaveBeenCalledWith("PLAN.md");
});

test("resolveTask prepares paired planning without creating a manifest", async () => {
  const { preparePairedOptionsMock, resolveTask } = await loadResolveTask({
    isFile: (path) => path === "PLAN.md",
    readPrompt: async (input) =>
      input === "PLAN.md" ? "generated plan task" : input,
    runAgent: async () => ({
      combined: "",
      exitCode: 0,
      parsed: "<done/>",
    }),
  });

  await resolveTask(makeOptions("ship feature", { pairedMode: true }));

  expect(preparePairedOptionsMock).toHaveBeenCalledWith(
    expect.any(Object),
    process.cwd(),
    false
  );
});

test("resolveTask primes paired planning sessions before agent turns", async () => {
  const { preparePairedOptionsMock, resolveTask, runAgentMock } =
    await loadResolveTask({
      isFile: (path) => path === "PLAN.md",
      preparePairedOptions: (opts) => {
        opts.pairedSessionIds = {
          claude: "claude-session-1",
          codex: "codex-thread-1",
        };
      },
      readPrompt: async () => "generated plan task",
      runAgent: async () => ({
        combined: "",
        exitCode: 0,
        parsed: "",
      }),
    });

  await resolveTask(makeOptions("ship feature", { pairedMode: true }));

  expect(preparePairedOptionsMock).toHaveBeenCalledTimes(1);
  expect(runAgentMock).toHaveBeenNthCalledWith(
    1,
    "codex",
    expect.any(String),
    expect.any(Object),
    "codex-thread-1"
  );
  expect(runAgentMock).toHaveBeenNthCalledWith(
    2,
    "claude",
    expect.any(String),
    expect.any(Object),
    "claude-session-1"
  );
});

test("resolveTask reviews PLAN.md with other model by default in plain-text flow", async () => {
  const { resolveTask, runAgentMock } = await loadResolveTask({
    isFile: (path) => path === "PLAN.md",
    readPrompt: async (input) =>
      input === "PLAN.md" ? "generated plan task" : input,
    runAgent: async () => ({
      combined: "",
      exitCode: 0,
      parsed: "",
    }),
  });

  const task = await resolveTask(makeOptions("ship feature"));

  expect(task).toBe("generated plan task");
  expect(runAgentMock).toHaveBeenCalledTimes(2);
  expect(runAgentMock).toHaveBeenNthCalledWith(
    1,
    "codex",
    expect.stringContaining("Plan mode:"),
    expect.any(Object)
  );
  expect(runAgentMock).toHaveBeenNthCalledWith(
    2,
    "claude",
    expect.stringContaining("Plan review mode:"),
    expect.any(Object)
  );
});

test("resolveTask uses codex as review-plan=other reviewer when primary is claude", async () => {
  const { runAgentMock, resolveTask } = await loadResolveTask({
    isFile: (path) => path === "PLAN.md",
    readPrompt: async () => "generated plan task",
    runAgent: async () => ({
      combined: "",
      exitCode: 0,
      parsed: "",
    }),
  });

  await resolveTask(
    makeOptions("ship feature", { agent: "claude", reviewPlan: "other" })
  );

  expect(runAgentMock).toHaveBeenNthCalledWith(
    1,
    "claude",
    expect.any(String),
    expect.any(Object)
  );
  expect(runAgentMock).toHaveBeenNthCalledWith(
    2,
    "codex",
    expect.any(String),
    expect.any(Object)
  );
});

test("resolveTask skips plan review when review-plan is none", async () => {
  const { runAgentMock, resolveTask } = await loadResolveTask({
    isFile: (path) => path === "PLAN.md",
    readPrompt: async () => "generated plan task",
    runAgent: async () => ({
      combined: "",
      exitCode: 0,
      parsed: "",
    }),
  });

  await resolveTask(makeOptions("ship feature", { reviewPlan: "none" }));

  expect(runAgentMock).toHaveBeenCalledTimes(1);
  expect(runAgentMock).toHaveBeenNthCalledWith(
    1,
    "codex",
    expect.any(String),
    expect.any(Object)
  );
});

test("resolveTask throws when plan review exits non-zero", async () => {
  let calls = 0;
  const { resolveTask } = await loadResolveTask({
    isFile: (path) => path === "PLAN.md",
    runAgent: () => {
      calls += 1;
      return {
        combined: "",
        exitCode: calls === 1 ? 0 : 2,
        parsed: "",
      };
    },
  });

  await expect(resolveTask(makeOptions("ship feature"))).rejects.toThrow(
    "[loop] plan review claude exited with code 2"
  );
});

test("resolveTask throws when planning exits non-zero", async () => {
  const { resolveTask } = await loadResolveTask({
    runAgent: async () => ({
      combined: "",
      exitCode: 2,
      parsed: "",
    }),
  });

  await expect(resolveTask(makeOptions("ship feature"))).rejects.toThrow(
    "[loop] planning codex exited with code 2"
  );
});

test("resolveTask throws when planning does not create PLAN.md", async () => {
  const { resolveTask } = await loadResolveTask({
    runAgent: async () => ({
      combined: "",
      exitCode: 0,
      parsed: "<done/>",
    }),
  });

  await expect(resolveTask(makeOptions("ship feature"))).rejects.toThrow(
    "[loop] planning step did not create PLAN.md"
  );
});
