import { afterEach, expect, mock, test } from "bun:test";
import type { Options, ReviewResult, RunResult } from "../../src/loop/types";

const makeOptions = (overrides: Partial<Options> = {}): Options => ({
  agent: "codex",
  doneSignal: "<done/>",
  proof: "verify with tests",
  format: "raw",
  maxIterations: 2,
  model: "test-model",
  review: "claudex",
  ...overrides,
});

const makeRunResult = (
  parsed: string,
  combined = "",
  exitCode = 0
): RunResult => ({
  combined,
  exitCode,
  parsed,
});

const noopReview = async (): Promise<ReviewResult> => ({
  approved: true,
  consensusFail: false,
  notes: "",
});

afterEach(() => {
  mock.restore();
});

const loadRunLoop = async (mocks: {
  buildWorkPrompt?: (...args: unknown[]) => string;
  resolveReviewers?: () => string[];
  runAgent?: () => Promise<RunResult>;
  runDraftPrStep?: () => Promise<undefined>;
  runReview?: () => Promise<ReviewResult>;
  question?: () => Promise<string>;
}) => {
  mock.module("node:readline/promises", () => ({
    createInterface: mock(() => ({
      close: mock(() => undefined),
      question: mock(async () => mocks.question?.() ?? ""),
    })),
  }));
  mock.module("../../src/loop/prompts", () => ({
    buildWorkPrompt: mock(mocks.buildWorkPrompt ?? (() => "prompt")),
  }));
  mock.module("../../src/loop/review", () => ({
    resolveReviewers: mock(mocks.resolveReviewers ?? (() => [])),
    runReview: mock(mocks.runReview ?? noopReview),
  }));
  mock.module("../../src/loop/runner", () => ({
    runAgent: mock(mocks.runAgent ?? (async () => makeRunResult("working"))),
  }));
  mock.module("../../src/loop/pr", () => ({
    runDraftPrStep: mock(mocks.runDraftPrStep ?? (async () => undefined)),
  }));

  const { runLoop } = await import("../../src/loop/main");
  const { buildWorkPrompt } = await import("../../src/loop/prompts");
  const { resolveReviewers, runReview } = await import("../../src/loop/review");
  const { runAgent } = await import("../../src/loop/runner");
  const { runDraftPrStep } = await import("../../src/loop/pr");

  return {
    buildWorkPrompt: buildWorkPrompt as ReturnType<typeof mock>,
    resolveReviewers: resolveReviewers as ReturnType<typeof mock>,
    runAgent: runAgent as ReturnType<typeof mock>,
    runDraftPrStep: runDraftPrStep as ReturnType<typeof mock>,
    runLoop,
    runReview: runReview as ReturnType<typeof mock>,
  };
};

test("runLoop stops immediately on done signal when review is disabled", async () => {
  const { runLoop, runAgent, runReview, runDraftPrStep } = await loadRunLoop({
    resolveReviewers: () => [],
    runAgent: async () => makeRunResult("<done/>"),
  });

  await runLoop("Ship feature", makeOptions({ review: undefined }));

  expect(runAgent).toHaveBeenCalledTimes(1);
  expect(runReview).not.toHaveBeenCalled();
  expect(runDraftPrStep).not.toHaveBeenCalled();
});

test("runLoop creates draft PR when done signal is reviewed and approved", async () => {
  const opts = makeOptions({ review: "claudex" });
  const { runLoop, runAgent, runReview, runDraftPrStep } = await loadRunLoop({
    resolveReviewers: () => ["codex", "claude"],
    runAgent: async () => makeRunResult("<done/>"),
    runReview: async () => ({
      approved: true,
      consensusFail: false,
      notes: "",
    }),
  });

  await runLoop("Ship feature", opts);

  expect(runAgent).toHaveBeenCalledTimes(1);
  expect(runReview).toHaveBeenCalledTimes(1);
  expect(runDraftPrStep).toHaveBeenNthCalledWith(
    1,
    "Ship feature",
    opts,
    false
  );
});

test("runLoop uses follow-up commit prompt after a PR is already created", async () => {
  const answers = ["Update docs", ""];
  const { runLoop, runAgent, runReview, runDraftPrStep } = await loadRunLoop({
    resolveReviewers: () => ["codex", "claude"],
    runAgent: async () => makeRunResult("<done/>"),
    runReview: async () => ({
      approved: true,
      consensusFail: false,
      notes: "",
    }),
    question: async () => answers.shift() ?? "",
  });

  await runLoop("Ship feature", makeOptions({ review: "claudex" }));

  expect(runAgent).toHaveBeenCalledTimes(2);
  expect(runReview).toHaveBeenCalledTimes(2);
  expect(runDraftPrStep).toHaveBeenNthCalledWith(
    1,
    "Ship feature",
    expect.any(Object),
    false
  );
  expect(runDraftPrStep).toHaveBeenNthCalledWith(
    2,
    "Ship feature\n\nFollow-up:\nUpdate docs",
    expect.any(Object),
    true
  );
});

test("runLoop forwards consensus review notes into the next iteration prompt", async () => {
  const promptNotes: string[] = [];
  let runCount = 0;

  const { runLoop, buildWorkPrompt, runReview } = await loadRunLoop({
    buildWorkPrompt: (
      _task: unknown,
      _done: unknown,
      _proof: unknown,
      reviewNotes?: unknown
    ) => {
      promptNotes.push((reviewNotes as string) ?? "");
      return `prompt-${promptNotes.length}`;
    },
    resolveReviewers: () => ["codex", "claude"],
    runAgent: () => {
      runCount++;
      return Promise.resolve(
        runCount === 1 ? makeRunResult("<done/>") : makeRunResult("working")
      );
    },
    runReview: async () => ({
      approved: false,
      consensusFail: true,
      notes: "[codex] Fix tests.\n\n[claude] Improve docs.",
    }),
  });

  await runLoop("Ship feature", makeOptions({ maxIterations: 2 }));

  expect(buildWorkPrompt).toHaveBeenCalledTimes(2);
  expect(promptNotes[0]).toBe("");
  expect(promptNotes[1]).toContain("Both reviewers requested changes.");
  expect(promptNotes[1]).toContain("[codex] Fix tests.");
  expect(promptNotes[1]).toContain("[claude] Improve docs.");
  expect(runReview).toHaveBeenCalledTimes(1);
});

test("runLoop forwards single-review fallback notes into the next iteration prompt", async () => {
  const promptNotes: string[] = [];
  let runCount = 0;

  const { runLoop, buildWorkPrompt } = await loadRunLoop({
    buildWorkPrompt: (
      _task: unknown,
      _done: unknown,
      _proof: unknown,
      reviewNotes?: unknown
    ) => {
      promptNotes.push((reviewNotes as string) ?? "");
      return `prompt-${promptNotes.length}`;
    },
    resolveReviewers: () => ["codex"],
    runAgent: () => {
      runCount++;
      return Promise.resolve(
        runCount === 1 ? makeRunResult("<done/>") : makeRunResult("working")
      );
    },
    runReview: async () => ({
      approved: false,
      consensusFail: false,
      notes: "",
    }),
  });

  await runLoop("Ship feature", makeOptions({ maxIterations: 2 }));

  expect(buildWorkPrompt).toHaveBeenCalledTimes(2);
  expect(promptNotes[0]).toBe("");
  expect(promptNotes[1]).toBe("Reviewer found more work to do.");
});

test("runLoop stops after max iterations when done signal is never found", async () => {
  const { runLoop, runAgent, runReview } = await loadRunLoop({
    resolveReviewers: () => [],
    runAgent: async () => makeRunResult("working"),
  });

  await runLoop("Ship feature", makeOptions({ maxIterations: 3 }));

  expect(runAgent).toHaveBeenCalledTimes(3);
  expect(runReview).not.toHaveBeenCalled();
});
