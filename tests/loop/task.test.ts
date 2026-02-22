import { afterEach, expect, mock, test } from "bun:test";
import type { Options, RunResult } from "../../src/loop/types";

const makeOptions = (promptInput?: string): Options => ({
  agent: "codex",
  doneSignal: "<done/>",
  proof: "verify with tests",
  format: "raw",
  maxIterations: 5,
  model: "test-model",
  ...(promptInput ? { promptInput } : {}),
});

afterEach(() => {
  mock.restore();
});

interface TaskDeps {
  isFile?: (path: string) => boolean;
  readPrompt?: (input: string) => Promise<string>;
  runAgent?: (
    agent: Options["agent"],
    prompt: string,
    opts: Options
  ) => Promise<RunResult>;
}

const loadResolveTask = async (deps: TaskDeps = {}) => {
  const isFileMock = mock(deps.isFile ?? (() => false));
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
  mock.module("../../src/loop/runner", () => ({ runAgent: runAgentMock }));

  const { resolveTask } = await import("../../src/loop/task");
  return { isFileMock, readPromptMock, resolveTask, runAgentMock };
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
  expect(runAgentMock).toHaveBeenCalledTimes(1);
  expect(runAgentMock).toHaveBeenCalledWith(
    "codex",
    expect.stringContaining("Task:\nfix bug in README.md"),
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
  expect(runAgentMock).toHaveBeenCalledTimes(1);
  expect(runAgentMock).toHaveBeenCalledWith(
    "codex",
    expect.stringContaining("Task:\nship feature"),
    expect.any(Object)
  );
  expect(readPromptMock).toHaveBeenCalledWith("PLAN.md");
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
