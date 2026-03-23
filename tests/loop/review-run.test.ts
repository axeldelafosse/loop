import { expect, mock, test } from "bun:test";
import { REVIEW_FAIL, REVIEW_PASS } from "../../src/loop/constants";
import { createRunReview } from "../../src/loop/review";
import type { Agent, Options, RunResult } from "../../src/loop/types";

const makeOptions = (): Options => ({
  agent: "codex",
  doneSignal: "<done/>",
  proof: "verify with tests",
  format: "raw",
  maxIterations: 5,
  codexModel: "test-model",
});

const makeRunReview = (
  impl: (reviewer: Agent, prompt: string, opts: Options) => Promise<RunResult>
) => {
  const runAgentMock = mock(impl);
  const runReview = createRunReview(runAgentMock);
  return { runAgentMock, runReview };
};

test("runReview approves when all reviewers pass", async () => {
  const { runAgentMock, runReview } = makeRunReview(async () => ({
    combined: "",
    exitCode: 0,
    parsed: `Looks good.\n${REVIEW_PASS}`,
  }));

  const result = await runReview(
    ["codex", "claude"],
    "ship task",
    makeOptions()
  );

  expect(result).toEqual({
    approved: true,
    consensusFail: false,
    failureCount: 0,
    failures: [],
    notes: "",
  });
  expect(runAgentMock).toHaveBeenCalledTimes(2);
});

test("runReview ignores transport noise in combined when parsed has final pass signal", async () => {
  const { runReview } = makeRunReview(async () => ({
    combined:
      '{"method":"item/agentMessage/delta","params":{"delta":"thinking"}}\n{"method":"turn/completed","params":{"status":"completed"}}',
    exitCode: 0,
    parsed: `Looks good.\n${REVIEW_PASS}`,
  }));

  const result = await runReview(["codex"], "ship task", makeOptions());

  expect(result).toEqual({
    approved: true,
    consensusFail: false,
    failureCount: 0,
    failures: [],
    notes: "",
  });
});

test("runReview treats mixed PASS and FAIL as failure", async () => {
  const { runReview } = makeRunReview(async () => ({
    combined: "",
    exitCode: 0,
    parsed: `Note this issue.\n${REVIEW_PASS}\n${REVIEW_FAIL}`,
  }));

  const result = await runReview(["codex"], "ship task", makeOptions());

  expect(result.approved).toBe(false);
  expect(result.consensusFail).toBe(false);
  expect(result.failureCount).toBe(1);
  expect(result.notes).toContain("[codex]");
  expect(result.notes).toContain("both");
});

test("runReview rejects missing final review signal", async () => {
  const { runReview } = makeRunReview(async () => ({
    combined: "",
    exitCode: 0,
    parsed: "Needs one more fix.",
  }));

  const result = await runReview(["codex"], "ship task", makeOptions());

  expect(result.approved).toBe(false);
  expect(result.consensusFail).toBe(false);
  expect(result.failureCount).toBe(1);
  expect(result.notes).toContain("missing a valid final review signal");
});

test("runReview rejects malformed final review signal", async () => {
  const { runReview } = makeRunReview(async () => ({
    combined: "",
    exitCode: 0,
    parsed: `${REVIEW_PASS} please`,
  }));

  const result = await runReview(["codex"], "ship task", makeOptions());

  expect(result.approved).toBe(false);
  expect(result.consensusFail).toBe(false);
  expect(result.failureCount).toBe(1);
  expect(result.notes).toContain("malformed final review signal");
});

test("runReview rejects trailing content after final review signal", async () => {
  const { runReview } = makeRunReview(async () => ({
    combined: "",
    exitCode: 0,
    parsed: `${REVIEW_FAIL}\nPlease address this next`,
  }));

  const result = await runReview(["codex"], "ship task", makeOptions());

  expect(result.approved).toBe(false);
  expect(result.consensusFail).toBe(false);
  expect(result.failureCount).toBe(1);
  expect(result.notes).toContain("content after the final review signal");
});

test("runReview accepts quoted final review signal", async () => {
  const { runReview } = makeRunReview(async () => ({
    combined: "",
    exitCode: 0,
    parsed: `Looks good.\n"${REVIEW_PASS}"`,
  }));

  const result = await runReview(["codex"], "ship task", makeOptions());

  expect(result).toEqual({
    approved: true,
    consensusFail: false,
    failureCount: 0,
    failures: [],
    notes: "",
  });
});

test("runReview uses fallback message when fail output has no body", async () => {
  const { runReview } = makeRunReview(async () => ({
    combined: "",
    exitCode: 0,
    parsed: `${REVIEW_FAIL}`,
  }));

  const result = await runReview(["codex"], "ship task", makeOptions());

  expect(result.approved).toBe(false);
  expect(result.failureCount).toBe(1);
  expect(result.notes).toContain("Reviewer requested more work.");
});

test("runReview marks consensus failure when every reviewer fails", async () => {
  const { runReview } = makeRunReview((reviewer) => {
    if (reviewer === "codex") {
      return {
        combined: "",
        exitCode: 0,
        parsed: `${REVIEW_FAIL}\nFix naming.`,
      };
    }

    return {
      combined: "",
      exitCode: 0,
      parsed: `${REVIEW_FAIL}\nFix tests.`,
    };
  });

  const result = await runReview(
    ["codex", "claude"],
    "ship task",
    makeOptions()
  );

  expect(result.approved).toBe(false);
  expect(result.consensusFail).toBe(true);
  expect(result.failureCount).toBe(2);
  expect(result.notes).toContain("[codex]");
  expect(result.notes).toContain("[claude]");
});

test("runReview accepts pass signal from combined output with parsed body", async () => {
  const { runReview } = makeRunReview(() => ({
    combined: `\n\t${REVIEW_PASS}\n`,
    exitCode: 0,
    parsed: "Changed files:\n- src/loop/review.ts",
  }));

  const result = await runReview(
    ["codex", "claude"],
    "ship task",
    makeOptions()
  );

  expect(result).toEqual({
    approved: true,
    consensusFail: false,
    failureCount: 0,
    failures: [],
    notes: "",
  });
});

test("runReview reads fail signal from combined output with body", async () => {
  const { runReview } = makeRunReview(() => ({
    combined: `Address one more edge case.\n${REVIEW_FAIL}`,
    exitCode: 0,
    parsed: "",
  }));

  const result = await runReview(["codex"], "ship task", makeOptions());

  expect(result.approved).toBe(false);
  expect(result.failureCount).toBe(1);
  expect(result.notes).toContain("Address one more edge case.");
});

test("runReview is not consensus failure when only one reviewer fails", async () => {
  const { runReview } = makeRunReview((reviewer) => {
    if (reviewer === "codex") {
      return {
        combined: "",
        exitCode: 0,
        parsed: REVIEW_PASS,
      };
    }

    return {
      combined: "please update docs",
      exitCode: 0,
      parsed: REVIEW_FAIL,
    };
  });

  const result = await runReview(
    ["codex", "claude"],
    "ship task",
    makeOptions()
  );

  expect(result.approved).toBe(false);
  expect(result.consensusFail).toBe(false);
  expect(result.failureCount).toBe(1);
  expect(result.notes).toContain("[claude]");
  expect(result.notes).not.toContain("[codex]");
});

test("runReview keeps parallel results when one reviewer exits non-zero", async () => {
  const { runReview } = makeRunReview((reviewer) => {
    if (reviewer === "codex") {
      return {
        combined: "",
        exitCode: 0,
        parsed: REVIEW_PASS,
      };
    }

    return {
      combined: "error",
      exitCode: 2,
      parsed: "",
    };
  });

  const result = await runReview(
    ["codex", "claude"],
    "ship task",
    makeOptions()
  );

  expect(result.approved).toBe(false);
  expect(result.consensusFail).toBe(false);
  expect(result.failureCount).toBe(1);
  expect(result.notes).toContain("[claude]");
  expect(result.notes).toContain("exited with code 2");
  expect(result.notes).not.toContain("[codex]");
});

test("runReview handles non-zero exit for a single reviewer as failure", async () => {
  const { runReview } = makeRunReview(async () => ({
    combined: "error",
    exitCode: 2,
    parsed: "",
  }));

  const result = await runReview(["codex"], "ship task", makeOptions());
  expect(result.approved).toBe(false);
  expect(result.consensusFail).toBe(false);
  expect(result.failureCount).toBe(1);
  expect(result.notes).toContain("[codex]");
  expect(result.notes).toContain("exited with code 2");
});

test("runReview supports one failing reviewer through rejection and keeps deterministic notes", async () => {
  const { runReview } = makeRunReview((reviewer) => {
    if (reviewer === "codex") {
      return Promise.resolve({
        combined: "",
        exitCode: 0,
        parsed: REVIEW_PASS,
      });
    }

    return Promise.reject(new Error("reviewer timed out"));
  });

  const result = await runReview(
    ["codex", "claude"],
    "ship task",
    makeOptions()
  );

  expect(result.approved).toBe(false);
  expect(result.consensusFail).toBe(false);
  expect(result.failureCount).toBe(1);
  expect(result.notes).toBe(
    "[claude] [loop] review claude failed: reviewer timed out"
  );
});

test("runReview keeps deterministic note ordering regardless completion order", async () => {
  const { runReview } = makeRunReview(async (reviewer) => {
    if (reviewer === "codex") {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return {
        combined: "",
        exitCode: 0,
        parsed: `codex failed.\n${REVIEW_FAIL}`,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
    return {
      combined: "",
      exitCode: 0,
      parsed: `claude failed.\n${REVIEW_FAIL}`,
    };
  });

  const result = await runReview(
    ["codex", "claude"],
    "ship task",
    makeOptions()
  );

  expect(result.failureCount).toBe(2);
  expect(result.notes).toBe(
    '[codex] codex failed. (Expected "<review>PASS</review>" or "<review>FAIL</review>" in output.)\n\n' +
      '[claude] claude failed. (Expected "<review>PASS</review>" or "<review>FAIL</review>" in output.)'
  );
});

test("runReview formats non-Error reviewer rejection deterministically", async () => {
  const { runReview } = makeRunReview(() =>
    Promise.reject({ reason: "timeout", code: 9 })
  );
  const result = await runReview(["codex"], "ship task", makeOptions());

  expect(result.approved).toBe(false);
  expect(result.failureCount).toBe(1);
  expect(result.notes).toBe(
    '[codex] [loop] review codex failed: {"reason":"timeout","code":9}'
  );
});
