import { afterEach, expect, mock, test } from "bun:test";
import type { Options, RunResult } from "../../src/loop/types";

const makeOptions = (): Options => ({
  agent: "codex",
  doneSignal: "<done/>",
  proof: "verify with tests",
  format: "raw",
  maxIterations: 5,
  model: "test-model",
});

afterEach(() => {
  mock.restore();
});

const loadRunDraftPrStep = async (
  impl: (
    agent: Options["agent"],
    prompt: string,
    opts: Options
  ) => Promise<RunResult>
) => {
  const runAgentMock = mock(impl);
  mock.module("../../src/loop/runner", () => ({ runAgent: runAgentMock }));
  const { runDraftPrStep } = await import("../../src/loop/pr");
  return { runAgentMock, runDraftPrStep };
};

test("runDraftPrStep prompts model to create draft PR", async () => {
  const { runAgentMock, runDraftPrStep } = await loadRunDraftPrStep(
    async () => ({
      combined: "",
      exitCode: 0,
      parsed: "https://github.com/org/repo/pull/1",
    })
  );

  const opts = makeOptions();
  await runDraftPrStep("Implement feature X", opts);

  expect(runAgentMock).toHaveBeenCalledTimes(1);
  const [agent, prompt, passedOpts] = runAgentMock.mock.calls[0] as [
    Options["agent"],
    string,
    Options,
  ];

  expect(agent).toBe("codex");
  expect(prompt).toContain("Create a draft GitHub pull request");
  expect(prompt).toContain("gh pr create --draft");
  expect(prompt).toContain("Task context:\nImplement feature X");
  expect(passedOpts).toBe(opts);
});

test("runDraftPrStep prompts model to send a follow-up commit when PR exists", async () => {
  const { runAgentMock, runDraftPrStep } = await loadRunDraftPrStep(
    async () => ({
      combined: "",
      exitCode: 0,
      parsed: "",
    })
  );

  const opts = makeOptions();
  await runDraftPrStep("Implement feature X", opts, true);

  const [, prompt] = runAgentMock.mock.calls[0] as [
    Options["agent"],
    string,
    Options,
  ];

  expect(prompt).toContain("A PR already exists for this branch");
  expect(prompt).toContain("follow-up commit");
  expect(prompt).not.toContain("gh pr create --draft");
});

test("runDraftPrStep throws when model exits non-zero", async () => {
  const { runDraftPrStep } = await loadRunDraftPrStep(async () => ({
    combined: "",
    exitCode: 2,
    parsed: "",
  }));

  await expect(
    runDraftPrStep("Implement feature X", makeOptions())
  ).rejects.toThrow("[loop] draft PR codex exited with code 2");
});
