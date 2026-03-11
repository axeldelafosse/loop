import { afterEach, expect, mock, test } from "bun:test";
import type { Options, ReviewResult, RunResult } from "../../src/loop/types";

process.env.LOOP_COOLDOWN_MS = "0";

const makeOptions = (overrides: Partial<Options> = {}): Options => ({
  agent: "codex",
  doneSignal: "<done/>",
  proof: "verify with tests",
  format: "raw",
  maxIterations: 2,
  codexModel: "test-model",
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
  failureCount: 0,
  notes: "",
});
class TestCodexAppServerFallbackError extends Error {}

afterEach(() => {
  mock.restore();
});

const loadRunLoop = async (mocks: {
  buildWorkPrompt?: (...args: unknown[]) => string;
  CodexAppServerFallbackError?: typeof Error;
  getLastClaudeSessionId?: () => string;
  getLastCodexThreadId?: () => string;
  resolveReviewers?: () => string[];
  runAgent?: (
    agent: string,
    prompt: string,
    opts: Options,
    sessionId?: string
  ) => Promise<RunResult>;
  runDraftPrStep?: (...args: unknown[]) => Promise<undefined>;
  runReview?: () => Promise<ReviewResult>;
  question?: () => Promise<string>;
}) => {
  mock.restore();
  const realReview = await import("../../src/loop/review");
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
    createRunReview: realReview.createRunReview,
  }));
  mock.module("../../src/loop/runner", () => ({
    runAgent: mock(mocks.runAgent ?? (async () => makeRunResult("working"))),
  }));
  mock.module("../../src/loop/codex-app-server", () => ({
    CodexAppServerFallbackError:
      mocks.CodexAppServerFallbackError ?? TestCodexAppServerFallbackError,
    getLastCodexThreadId: mock(mocks.getLastCodexThreadId ?? (() => "")),
  }));
  mock.module("../../src/loop/claude-sdk-server", () => ({
    getLastClaudeSessionId: mock(mocks.getLastClaudeSessionId ?? (() => "")),
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

test("runLoop continues on non-zero exit code instead of throwing", async () => {
  const { runLoop, runAgent } = await loadRunLoop({
    resolveReviewers: () => [],
    runAgent: async () => makeRunResult("<done/>", "", 1),
  });

  await runLoop("Ship feature", makeOptions({ review: undefined }));

  expect(runAgent).toHaveBeenCalledTimes(2);
});

test("runLoop creates draft PR when done signal is reviewed and approved", async () => {
  const opts = makeOptions({ review: "claudex" });
  let codexThreadId = "";
  const { runLoop, runAgent, runReview, runDraftPrStep } = await loadRunLoop({
    getLastCodexThreadId: () => codexThreadId,
    resolveReviewers: () => ["codex", "claude"],
    runAgent: () => {
      codexThreadId = "thread-1";
      return Promise.resolve(makeRunResult("<done/>"));
    },
    runReview: async () => ({
      approved: true,
      consensusFail: false,
      failureCount: 0,
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
    false,
    "thread-1"
  );
});

test("runLoop skips review when agent exits non-zero even with done signal", async () => {
  const { runLoop, runAgent, runReview, runDraftPrStep } = await loadRunLoop({
    resolveReviewers: () => ["codex", "claude"],
    runAgent: async () => makeRunResult("<done/>", "", 1),
  });

  await runLoop("Ship feature", makeOptions());

  expect(runAgent).toHaveBeenCalledTimes(2);
  expect(runReview).not.toHaveBeenCalled();
  expect(runDraftPrStep).not.toHaveBeenCalled();
});

test("runLoop prompts for follow-up in interactive mode on max iterations", async () => {
  let callCount = 0;
  const { runLoop, runAgent } = await loadRunLoop({
    resolveReviewers: () => [],
    runAgent: () => {
      callCount++;
      return Promise.resolve(
        callCount <= 2 ? makeRunResult("working") : makeRunResult("<done/>")
      );
    },
    question: async () => (callCount <= 2 ? "Do more work" : ""),
  });

  const originalIsTty = process.stdin.isTTY;
  Object.defineProperty(process.stdin, "isTTY", {
    configurable: true,
    value: true,
  });
  try {
    await runLoop(
      "Ship feature",
      makeOptions({ maxIterations: 2, review: undefined })
    );
  } finally {
    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: originalIsTty,
    });
  }

  expect(runAgent).toHaveBeenCalledTimes(3);
});

test("runLoop exits immediately on done signal in interactive mode", async () => {
  const { runLoop, runAgent } = await loadRunLoop({
    resolveReviewers: () => [],
    runAgent: async () => makeRunResult("<done/>"),
    question: async () => "should not be called",
  });

  const originalIsTty = process.stdin.isTTY;
  Object.defineProperty(process.stdin, "isTTY", {
    configurable: true,
    value: true,
  });
  try {
    await runLoop("Ship feature", makeOptions({ review: undefined }));
  } finally {
    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: originalIsTty,
    });
  }

  expect(runAgent).toHaveBeenCalledTimes(1);
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
      failureCount: 2,
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

test("runLoop forwards single-review notes into the next iteration prompt", async () => {
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
      failureCount: 1,
      notes: "[codex] Reviewer found more work to do.",
    }),
  });

  await runLoop("Ship feature", makeOptions({ maxIterations: 2 }));

  expect(buildWorkPrompt).toHaveBeenCalledTimes(2);
  expect(promptNotes[0]).toBe("");
  expect(promptNotes[1]).toBe("[codex] Reviewer found more work to do.");
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

test("runLoop reuses the latest Codex thread across iterations", async () => {
  const sessionIds: Array<string | undefined> = [];
  let codexThreadId = "";
  const { runLoop } = await loadRunLoop({
    getLastCodexThreadId: () => codexThreadId,
    resolveReviewers: () => [],
    runAgent: (_agent, _prompt, _opts, sessionId) => {
      sessionIds.push(sessionId);
      codexThreadId = "thread-1";
      return Promise.resolve(makeRunResult("working"));
    },
  });

  await runLoop(
    "Ship feature",
    makeOptions({ maxIterations: 3, review: undefined })
  );

  expect(sessionIds).toEqual([undefined, "thread-1", "thread-1"]);
});

test("runLoop carries the Codex thread into follow-up cycles", async () => {
  const sessionIds: Array<string | undefined> = [];
  let codexThreadId = "";
  let promptCount = 0;
  const { runLoop } = await loadRunLoop({
    getLastCodexThreadId: () => codexThreadId,
    resolveReviewers: () => [],
    runAgent: (_agent, _prompt, _opts, sessionId) => {
      sessionIds.push(sessionId);
      codexThreadId = "thread-follow-up";
      promptCount++;
      return Promise.resolve(
        makeRunResult(promptCount === 1 ? "working" : "<done/>")
      );
    },
    question: async () => (promptCount === 1 ? "Keep going" : ""),
  });

  const originalIsTty = process.stdin.isTTY;
  Object.defineProperty(process.stdin, "isTTY", {
    configurable: true,
    value: true,
  });
  try {
    await runLoop(
      "Ship feature",
      makeOptions({ maxIterations: 1, review: undefined })
    );
  } finally {
    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: originalIsTty,
    });
  }

  expect(sessionIds).toEqual([undefined, "thread-follow-up"]);
});

test("runLoop logs the work thread instead of the last reviewer thread", async () => {
  const logs: string[] = [];
  let codexThreadId = "";
  let runCount = 0;
  const { runLoop } = await loadRunLoop({
    getLastCodexThreadId: () => codexThreadId,
    resolveReviewers: () => ["codex"],
    runAgent: () => {
      runCount++;
      codexThreadId = "work-thread";
      return Promise.resolve(
        runCount === 1 ? makeRunResult("<done/>") : makeRunResult("working")
      );
    },
    runReview: () => {
      codexThreadId = "review-thread";
      return {
        approved: false,
        consensusFail: false,
        failureCount: 1,
        notes: "keep going",
      };
    },
  });

  const originalLog = console.log;
  const logSpy = mock((message?: unknown): void => {
    logs.push(String(message ?? ""));
  });
  (console as { log: typeof logSpy }).log = logSpy;

  try {
    await runLoop("Ship feature", makeOptions({ maxIterations: 2 }));
  } finally {
    console.log = originalLog;
  }

  expect(
    logs.some((line) => line.includes("iteration 2/2 (session: work-thread)"))
  ).toBe(true);
  expect(
    logs.some((line) => line.includes("iteration 2/2 (session: review-thread)"))
  ).toBe(false);
});

test("runLoop keeps an explicit resumed Codex thread after retryable errors", async () => {
  const sessionIds: Array<string | undefined> = [];
  let attempts = 0;
  const { runLoop, runAgent } = await loadRunLoop({
    getLastCodexThreadId: () => "",
    resolveReviewers: () => [],
    runAgent: (_agent, _prompt, _opts, sessionId) => {
      sessionIds.push(sessionId);
      attempts++;
      if (attempts === 1) {
        throw new Error("temporary codex failure");
      }
      return Promise.resolve(makeRunResult("working"));
    },
  });

  await runLoop(
    "Ship feature",
    makeOptions({
      maxIterations: 2,
      review: undefined,
      sessionId: "resume-thread",
    })
  );

  expect(runAgent).toHaveBeenCalledTimes(2);
  expect(sessionIds).toEqual(["resume-thread", "resume-thread"]);
});

test("runLoop keeps the Codex work thread after a reviewer thread and retryable error", async () => {
  const sessionIds: Array<string | undefined> = [];
  let codexThreadId = "";
  let runCount = 0;
  const { runLoop } = await loadRunLoop({
    getLastCodexThreadId: () => codexThreadId,
    resolveReviewers: () => ["codex"],
    runAgent: (_agent, _prompt, _opts, sessionId) => {
      sessionIds.push(sessionId);
      runCount++;
      if (runCount === 1) {
        codexThreadId = "work-thread";
        return Promise.resolve(makeRunResult("<done/>"));
      }
      if (runCount === 2) {
        throw new Error("temporary codex failure");
      }
      codexThreadId = "work-thread";
      return Promise.resolve(makeRunResult("working"));
    },
    runReview: () => {
      codexThreadId = "review-thread";
      return {
        approved: false,
        consensusFail: false,
        failureCount: 1,
        notes: "keep going",
      };
    },
  });

  await runLoop("Ship feature", makeOptions({ maxIterations: 3 }));

  expect(sessionIds).toEqual([undefined, "work-thread", "work-thread"]);
});

test("runLoop aborts on Codex app-server fallback errors", async () => {
  class AppServerFallbackError extends Error {}
  const { runLoop, runAgent } = await loadRunLoop({
    CodexAppServerFallbackError: AppServerFallbackError,
    resolveReviewers: () => [],
    runAgent: () => {
      throw new AppServerFallbackError("app-server unsupported");
    },
  });

  await expect(
    runLoop("Ship feature", makeOptions({ review: undefined }))
  ).rejects.toThrow("app-server unsupported");
  expect(runAgent).toHaveBeenCalledTimes(1);
});

test("runLoop clears Claude session ids after the first iteration", async () => {
  const sessionIds: Array<string | undefined> = [];
  let claudeSessionId = "";
  const { runLoop } = await loadRunLoop({
    getLastClaudeSessionId: () => claudeSessionId,
    resolveReviewers: () => [],
    runAgent: (_agent, _prompt, _opts, sessionId) => {
      sessionIds.push(sessionId);
      claudeSessionId = "claude-session-1";
      return Promise.resolve(makeRunResult("working"));
    },
  });

  await runLoop(
    "Ship feature",
    makeOptions({
      agent: "claude",
      maxIterations: 3,
      review: undefined,
      sessionId: "resume-claude",
    })
  );

  expect(sessionIds).toEqual(["resume-claude", undefined, undefined]);
});
