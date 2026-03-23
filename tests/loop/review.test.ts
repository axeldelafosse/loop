import { expect, test } from "bun:test";
import { REVIEW_FAIL, REVIEW_PASS } from "../../src/loop/constants";
import { createRunReview, resolveReviewers } from "../../src/loop/review";
import type { Options, RunResult } from "../../src/loop/types";

const makeRunResult = ({
  parsed = "",
  combined = "",
  exitCode = 0,
}: Partial<RunResult> = {}): RunResult => ({
  combined,
  exitCode,
  parsed,
});

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

test("resolveReviewers returns empty list when review is not enabled", () => {
  expect(resolveReviewers(undefined, "codex")).toEqual([]);
});

test("resolveReviewers returns claudex reviewers in deterministic order", () => {
  expect(resolveReviewers("claudex", "codex")).toEqual(["codex", "claude"]);
  expect(resolveReviewers("claudex", "claude")).toEqual(["claude", "codex"]);
});

test("resolveReviewers returns the explicit reviewer", () => {
  expect(resolveReviewers("claude", "codex")).toEqual(["claude"]);
  expect(resolveReviewers("codex", "claude")).toEqual(["codex"]);
});

test("runReview approves only when final line is a valid pass signal", async () => {
  const runReview = createRunReview(() =>
    Promise.resolve(makeRunResult({ parsed: `x\n${REVIEW_PASS}\n\n` }))
  );
  const result = await runReview(["codex"], "task", makeOptions());

  expect(result).toEqual({
    approved: true,
    consensusFail: false,
    failureCount: 0,
    failures: [],
    notes: "",
  });
});

test("runReview accepts quoted final signal and ignores non-final review lines", async () => {
  const runReview = createRunReview(() =>
    Promise.resolve(
      makeRunResult({ parsed: `some context\n"${REVIEW_PASS}"\n\n   ` })
    )
  );
  const result = await runReview(["codex"], "task", makeOptions());

  expect(result).toEqual({
    approved: true,
    consensusFail: false,
    failureCount: 0,
    failures: [],
    notes: "",
  });
});

test("runReview accepts final signal with surrounding whitespace", async () => {
  const runReview = createRunReview(() =>
    Promise.resolve(
      makeRunResult({ parsed: `x\n  \t${REVIEW_PASS}  \n\n   \n` })
    )
  );
  const result = await runReview(["codex"], "task", makeOptions());

  expect(result).toEqual({
    approved: true,
    consensusFail: false,
    failureCount: 0,
    failures: [],
    notes: "",
  });
});

test("runReview accepts final signal from combined output with trailing blank lines", async () => {
  const runReview = createRunReview(() =>
    Promise.resolve(
      makeRunResult({
        parsed: "x",
        combined: `\n  ${REVIEW_PASS}\n\n  \t\n`,
      })
    )
  );
  const result = await runReview(["codex"], "task", makeOptions());

  expect(result).toEqual({
    approved: true,
    consensusFail: false,
    failureCount: 0,
    failures: [],
    notes: "",
  });
});

test("runReview rejects output with missing final review signal", async () => {
  const runReview = createRunReview(() =>
    Promise.resolve(
      makeRunResult({ parsed: "Needs one more fix.\nAdditional notes follow." })
    )
  );
  const result = await runReview(["codex"], "task", makeOptions());

  expect(result.approved).toBe(false);
  expect(result.failureCount).toBe(1);
  expect(result.notes).toContain("missing a valid final review signal");
});

test("runReview accepts quoted final fail with whitespace-only body", async () => {
  const runReview = createRunReview(() =>
    Promise.resolve(
      makeRunResult({
        parsed: `\n   \n"${REVIEW_FAIL}"\n \t \n`,
        combined: "",
      })
    )
  );
  const result = await runReview(["codex"], "task", makeOptions());

  expect(result).toEqual({
    approved: false,
    consensusFail: false,
    failureCount: 1,
    failures: [
      {
        reason:
          'Reviewer requested more work. (Expected "<review>PASS</review>" or "<review>FAIL</review>" in output.)',
        reviewer: "codex",
      },
    ],
    notes:
      '[codex] Reviewer requested more work. (Expected "<review>PASS</review>" or "<review>FAIL</review>" in output.)',
  });
});

test("runReview rejects trailing token on quoted final signal", async () => {
  const runReview = createRunReview(() =>
    Promise.resolve(
      makeRunResult({ parsed: `please add tests\n"${REVIEW_PASS}" extra` })
    )
  );
  const result = await runReview(["codex"], "task", makeOptions());

  expect(result.approved).toBe(false);
  expect(result.failureCount).toBe(1);
  expect(result.notes).toContain("final review signal");
});

test("runReview accepts final signal when parsed is empty and combined contains body", async () => {
  const runReview = createRunReview(() =>
    Promise.resolve(
      makeRunResult({
        parsed: "",
        combined: `Checks passed.\n${REVIEW_PASS}\n`,
      })
    )
  );
  const result = await runReview(["codex"], "task", makeOptions());

  expect(result).toEqual({
    approved: true,
    consensusFail: false,
    failureCount: 0,
    failures: [],
    notes: "",
  });
});

test("runReview rejects output with quoted final fail plus non-final pass", async () => {
  const runReview = createRunReview(() =>
    Promise.resolve(
      makeRunResult({ parsed: `"${REVIEW_FAIL}"\n${REVIEW_PASS}` })
    )
  );
  const result = await runReview(["codex"], "task", makeOptions());

  expect(result.approved).toBe(false);
  expect(result.failureCount).toBe(1);
  expect(result.notes).toContain("both");
});

test("runReview rejects output with final pass and earlier fail", async () => {
  const runReview = createRunReview(() =>
    Promise.resolve(makeRunResult({ parsed: `${REVIEW_FAIL}\n${REVIEW_PASS}` }))
  );
  const result = await runReview(["codex"], "task", makeOptions());

  expect(result.approved).toBe(false);
  expect(result.failureCount).toBe(1);
  expect(result.notes).toContain("both");
});

test("runReview rejects malformed final signal text", async () => {
  const runReview = createRunReview(() =>
    Promise.resolve(makeRunResult({ parsed: `${REVIEW_PASS} please` }))
  );
  const result = await runReview(["codex"], "task", makeOptions());

  expect(result.approved).toBe(false);
  expect(result.failureCount).toBe(1);
  expect(result.notes).toContain("final review signal");
});

test("runReview rejects output with extra non-empty content after final signal", async () => {
  const runReview = createRunReview(() =>
    Promise.resolve(
      makeRunResult({ parsed: `${REVIEW_FAIL}\naddressed later` })
    )
  );
  const result = await runReview(["codex"], "task", makeOptions());

  expect(result.approved).toBe(false);
  expect(result.failureCount).toBe(1);
  expect(result.notes).toContain("final review signal");
});

test("runReview rejects non-final or malformed review signals", async () => {
  const runReview = createRunReview(() =>
    Promise.resolve(makeRunResult({ parsed: `${REVIEW_PASS} with notes` }))
  );
  const result = await runReview(["codex"], "task", makeOptions());

  expect(result.approved).toBe(false);
  expect(result.failureCount).toBe(1);
  expect(result.notes).toContain("final review signal");
});

test("runReview requires deterministic output when both pass and fail are present", async () => {
  const runReview = createRunReview(() =>
    Promise.resolve(makeRunResult({ parsed: `${REVIEW_PASS}\n${REVIEW_FAIL}` }))
  );
  const result = await runReview(["codex"], "task", makeOptions());

  expect(result.approved).toBe(false);
  expect(result.failureCount).toBe(1);
  expect(result.notes).toContain("both");
});

test("runReview extracts fail reasons from body before final signal", async () => {
  const runReview = createRunReview(() =>
    Promise.resolve(
      makeRunResult({ parsed: `Fix this.\nAnd this.\n${REVIEW_FAIL}` })
    )
  );
  const result = await runReview(["codex"], "task", makeOptions());

  expect(result.approved).toBe(false);
  expect(result.failureCount).toBe(1);
  expect(result.notes).toContain("Fix this.");
  expect(result.notes).toContain("And this.");
});

test("runReview keeps deterministic output when both pass and fail are present", async () => {
  const runReview = createRunReview(() =>
    Promise.resolve(
      makeRunResult({ parsed: `${REVIEW_PASS}\n${REVIEW_FAIL}\n` })
    )
  );
  const result = await runReview(["codex"], "task", makeOptions());

  expect(result.approved).toBe(false);
  expect(result.failureCount).toBe(1);
  expect(result.notes).toContain("both");
});

test("runReview keeps deterministic output when one pass and one fail in output", async () => {
  const runReview = createRunReview(() =>
    Promise.resolve(
      makeRunResult({
        parsed: `${REVIEW_PASS}\nSome info\n${REVIEW_FAIL}\n`,
      })
    )
  );
  const result = await runReview(["codex"], "task", makeOptions());

  expect(result.approved).toBe(false);
  expect(result.failureCount).toBe(1);
  expect(result.notes).toContain("both");
});

test("runReview keeps deterministic note ordering regardless completion order", async () => {
  const runReview = createRunReview(async (reviewer) => {
    if (reviewer === "codex") {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return makeRunResult({ parsed: `codex review failed.\n${REVIEW_FAIL}` });
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
    return makeRunResult({ parsed: `claude review failed.\n${REVIEW_FAIL}` });
  });

  const result = await runReview(["codex", "claude"], "task", makeOptions());

  expect(result.approved).toBe(false);
  expect(result.failureCount).toBe(2);
  expect(result.notes).toBe(
    '[codex] codex review failed. (Expected "<review>PASS</review>" or "<review>FAIL</review>" in output.)\n\n[claude] claude review failed. (Expected "<review>PASS</review>" or "<review>FAIL</review>" in output.)'
  );
});

test("runReview handles non-zero exit code as deterministic reviewer failure", async () => {
  const runReview = createRunReview(() =>
    Promise.resolve(makeRunResult({ exitCode: 3, parsed: "", combined: "x" }))
  );
  const result = await runReview(["codex"], "task", makeOptions());

  expect(result).toEqual({
    approved: false,
    consensusFail: false,
    failureCount: 1,
    failures: [
      {
        reason:
          '[loop] review exited with code 3 (Expected "<review>PASS</review>" or "<review>FAIL</review>" in output.)',
        reviewer: "codex",
      },
    ],
    notes:
      '[codex] [loop] review exited with code 3 (Expected "<review>PASS</review>" or "<review>FAIL</review>" in output.)',
  });
});

test("runReview handles reviewer runtime failures", async () => {
  const runReview = createRunReview(() => Promise.reject("network glitch"));
  const result = await runReview(["codex"], "task", makeOptions());

  expect(result).toEqual({
    approved: false,
    consensusFail: false,
    failureCount: 1,
    failures: [
      {
        reason: "[loop] review codex failed: network glitch",
        reviewer: "codex",
      },
    ],
    notes: "[codex] [loop] review codex failed: network glitch",
  });
});

test("runReview marks consensus failure when all reviewers fail", async () => {
  const runReview = createRunReview(() =>
    Promise.resolve(makeRunResult({ parsed: REVIEW_FAIL }))
  );
  const result = await runReview(["claude", "codex"], "task", makeOptions());

  expect(result.approved).toBe(false);
  expect(result.consensusFail).toBe(true);
  expect(result.failureCount).toBe(2);
  expect(result.notes).toContain("[claude]");
});
