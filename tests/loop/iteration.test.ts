import { afterEach, expect, mock, test } from "bun:test";
import type { Options, RunResult } from "../../src/loop/types";

class TestCodexAppServerFallbackError extends Error {}

afterEach(() => {
  mock.restore();
});

const loadIteration = (
  mocks: {
    getLastClaudeSessionId?: () => string;
    getLastCodexThreadId?: () => string;
    runAgent?: (
      agent: Options["agent"],
      prompt: string,
      opts: Options,
      sessionId?: string
    ) => Promise<RunResult>;
  } = {}
) => {
  mock.restore();
  mock.module("../../src/loop/claude-sdk-server", () => ({
    getLastClaudeSessionId: mock(mocks.getLastClaudeSessionId ?? (() => "")),
  }));
  mock.module("../../src/loop/codex-app-server", () => ({
    CodexAppServerFallbackError: TestCodexAppServerFallbackError,
    getLastCodexThreadId: mock(mocks.getLastCodexThreadId ?? (() => "")),
  }));
  const runAgentMock = mock(
    mocks.runAgent ??
      (async () => ({
        combined: "",
        exitCode: 0,
        parsed: "",
      }))
  );
  mock.module("../../src/loop/runner", () => ({
    runAgent: runAgentMock,
    runReviewerAgent: runAgentMock,
  }));
  return import("../../src/loop/iteration");
};

test("nextSessionId keeps an explicit Codex resume id until a newer thread is known", async () => {
  const { nextSessionId } = await loadIteration({
    getLastCodexThreadId: () => "",
  });

  expect(nextSessionId("codex", "resume-thread")).toBe("resume-thread");
  expect(nextSessionId("claude", "resume-claude")).toBeUndefined();
});

test("nextSessionId keeps the current Codex work thread over a stale global thread", async () => {
  const { nextSessionId } = await loadIteration({
    getLastCodexThreadId: () => "review-thread",
  });

  expect(nextSessionId("codex", "work-thread")).toBe("work-thread");
});

test("logIterationHeader uses the work session instead of the latest global Codex session", async () => {
  const { logIterationHeader } = await loadIteration({
    getLastCodexThreadId: () => "review-thread",
  });
  const originalLog = console.log;
  const logMock = mock(() => undefined);
  (console as { log: typeof logMock }).log = logMock;

  try {
    logIterationHeader(2, 3, "work-thread");
  } finally {
    console.log = originalLog;
  }

  expect(logMock).toHaveBeenCalledWith(
    "\n[loop] iteration 2/3 (session: work-thread)"
  );
});

test("logSessionHint uses the work session instead of the latest global Codex session", async () => {
  const { logSessionHint } = await loadIteration({
    getLastCodexThreadId: () => "review-thread",
  });
  const originalError = console.error;
  const errorMock = mock(() => undefined);
  (console as { error: typeof errorMock }).error = errorMock;

  try {
    logSessionHint("codex", "work-thread");
  } finally {
    console.error = originalError;
  }

  expect(errorMock).toHaveBeenCalledWith(
    "[loop] to resume: loop --session work-thread"
  );
});
