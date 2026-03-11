import { NEWLINE_RE, REVIEW_FAIL, REVIEW_PASS } from "./constants";
import { buildReviewPrompt } from "./prompts";
import { runReviewerAgent } from "./runner";
import type {
  Agent,
  Options,
  ReviewMode,
  ReviewResult,
  RunResult,
} from "./types";

const REVIEW_SIGNAL_HELP = `Expected "${REVIEW_PASS}" or "${REVIEW_FAIL}" in output.`;
const REVIEW_FAILURE_FALLBACK = "Reviewer requested more work.";
const REVIEW_MISSING_SIGNAL =
  "Reviewer output was missing a valid final review signal.";
const REVIEW_MALFORMED_SIGNAL =
  "Reviewer output had a malformed final review signal.";
const REVIEW_MIXED_SIGNALS =
  "Output contained both review pass and review fail signals.";
const REVIEW_TRAILING_SIGNAL =
  "Reviewer output had content after the final review signal.";

const QUOTED_REVIEW_PASS = `"${REVIEW_PASS}"`;
const QUOTED_REVIEW_FAIL = `"${REVIEW_FAIL}"`;

type ReviewSignal = "pass" | "fail";

interface ReviewCheck {
  reason: string;
  status: "pass" | "fail";
}

interface ReviewSignalSummary {
  finalLine: string | undefined;
  finalLineIndex: number | undefined;
  finalSignal: ReviewSignal | undefined;
  hasFailSignal: boolean;
  hasPassSignal: boolean;
  lastSignalLineIndex: number | undefined;
  lines: string[];
}

const cleanOutputText = (text: string): string =>
  text.replace(/\r/g, "").trimEnd();

const parseSignal = (line: string): ReviewSignal | undefined => {
  const trimmed = line.trim();
  if (trimmed === REVIEW_PASS || trimmed === QUOTED_REVIEW_PASS) {
    return "pass";
  }
  if (trimmed === REVIEW_FAIL || trimmed === QUOTED_REVIEW_FAIL) {
    return "fail";
  }
  return undefined;
};

const splitOutputLines = (output: string): string[] => output.split(NEWLINE_RE);

const hasExplicitSignal = (output: string): boolean =>
  splitOutputLines(output).some((line) => parseSignal(line) !== undefined);

const cleanOutput = (result: RunResult): string => {
  const parsed = cleanOutputText(result.parsed);
  const combined = cleanOutputText(result.combined);
  if (!parsed) {
    return combined;
  }
  if (!combined) {
    return parsed;
  }
  if (hasExplicitSignal(parsed)) {
    return parsed;
  }
  if (hasExplicitSignal(combined)) {
    return combined;
  }
  return parsed;
};

const getFinalNonEmptyLine = (
  lines: string[]
): { finalLine: string | undefined; finalLineIndex: number | undefined } => {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index].trim() !== "") {
      return { finalLine: lines[index], finalLineIndex: index };
    }
  }

  return { finalLine: undefined, finalLineIndex: undefined };
};

const collectSignalPresence = (
  lines: string[]
): {
  hasFailSignal: boolean;
  hasPassSignal: boolean;
  lastSignalLineIndex: number | undefined;
} => {
  let hasFailSignal = false;
  let hasPassSignal = false;
  let lastSignalLineIndex: number | undefined;

  for (const [index, line] of lines.entries()) {
    const signal = parseSignal(line);
    if (signal === "fail") {
      hasFailSignal = true;
      lastSignalLineIndex = index;
      continue;
    }
    if (signal === "pass") {
      hasPassSignal = true;
      lastSignalLineIndex = index;
    }
  }

  return {
    hasFailSignal,
    hasPassSignal,
    lastSignalLineIndex,
  };
};

const lineContainsReviewSignalToken = (line: string): boolean => {
  const trimmed = line.trim();
  return (
    trimmed.includes(REVIEW_PASS) ||
    trimmed.includes(REVIEW_FAIL) ||
    trimmed.includes(QUOTED_REVIEW_PASS) ||
    trimmed.includes(QUOTED_REVIEW_FAIL)
  );
};

const parseSignalSummary = (output: string): ReviewSignalSummary => {
  const lines = splitOutputLines(output);
  const { finalLine, finalLineIndex } = getFinalNonEmptyLine(lines);
  const { hasPassSignal, hasFailSignal, lastSignalLineIndex } =
    collectSignalPresence(lines);
  const finalSignal = finalLine ? parseSignal(finalLine) : undefined;

  return {
    finalLine,
    finalLineIndex,
    finalSignal,
    hasFailSignal,
    hasPassSignal,
    lastSignalLineIndex,
    lines,
  };
};

const reasonFromFailureOutput = (
  lines: string[],
  finalLineIndex: number | undefined
): string => {
  if (finalLineIndex === undefined) {
    return REVIEW_FAILURE_FALLBACK;
  }

  return (
    lines
      .slice(0, finalLineIndex)
      .filter((line) => line.trim())
      .join("\n") || REVIEW_FAILURE_FALLBACK
  );
};

const formatFailure = (reason: string): string =>
  `${reason} (${REVIEW_SIGNAL_HELP})`;

const formatUnknownError = (reason: unknown): string => {
  if (reason instanceof Error) {
    return reason.message || "unknown error";
  }

  if (reason == null) {
    return "unknown error";
  }

  if (typeof reason === "string") {
    return reason;
  }

  if (typeof reason === "boolean" || typeof reason === "number") {
    return String(reason);
  }

  return JSON.stringify(reason) || "unknown error";
};

export const resolveReviewers = (
  review: ReviewMode | undefined,
  agent: Agent
): Agent[] => {
  if (!review) {
    return [];
  }

  if (review === "claudex") {
    return agent === "codex" ? ["codex", "claude"] : ["claude", "codex"];
  }

  return [review];
};

type RunAgentFn = (
  agent: Agent,
  prompt: string,
  opts: Options
) => Promise<RunResult>;

const runReviewWith = async (
  run: RunAgentFn,
  reviewers: Agent[],
  task: string,
  opts: Options
): Promise<ReviewResult> => {
  const prompt = buildReviewPrompt(task, opts.doneSignal, opts.proof);
  const orderedReviewers = [...new Set(reviewers)];

  const runOne = async (reviewer: Agent) => {
    console.log(`\n[loop] review with ${reviewer}`);
    return { result: await run(reviewer, prompt, opts), reviewer };
  };

  const reasonForFailure = (reviewer: Agent, reason: unknown): string =>
    `[loop] review ${reviewer} failed: ${formatUnknownError(reason)}`;

  const evaluateOutput = (result: RunResult): ReviewCheck => {
    if (result.exitCode !== 0) {
      return {
        status: "fail",
        reason: formatFailure(
          `[loop] review exited with code ${result.exitCode}`
        ),
      };
    }

    const output = cleanOutput(result);
    const signals = parseSignalSummary(output);
    const final = signals.finalSignal;
    const finalHasReviewToken = signals.finalLine
      ? lineContainsReviewSignalToken(signals.finalLine)
      : false;

    if (
      signals.lastSignalLineIndex !== undefined &&
      signals.lastSignalLineIndex !== signals.finalLineIndex
    ) {
      return {
        status: "fail",
        reason: formatFailure(REVIEW_TRAILING_SIGNAL),
      };
    }

    if (!final) {
      return {
        status: "fail",
        reason: formatFailure(
          finalHasReviewToken ? REVIEW_MALFORMED_SIGNAL : REVIEW_MISSING_SIGNAL
        ),
      };
    }

    if (final === "pass" && signals.hasFailSignal) {
      return {
        status: "fail",
        reason: formatFailure(REVIEW_MIXED_SIGNALS),
      };
    }

    if (final === "fail" && signals.hasPassSignal) {
      return {
        status: "fail",
        reason: formatFailure(REVIEW_MIXED_SIGNALS),
      };
    }

    if (final === "fail") {
      return {
        status: "fail",
        reason: formatFailure(
          reasonFromFailureOutput(signals.lines, signals.finalLineIndex)
        ),
      };
    }

    return {
      status: "pass",
      reason: "",
    };
  };

  const notes: string[] = [];
  let failures = 0;

  const addFailure = (reviewer: Agent, reason: string): void => {
    failures += 1;
    notes.push(`[${reviewer}] ${reason.trim() || REVIEW_FAILURE_FALLBACK}`);
  };

  const settled = await Promise.allSettled(
    orderedReviewers.map((reviewer) => runOne(reviewer))
  );
  for (const [index, outcome] of settled.entries()) {
    if (outcome.status === "fulfilled") {
      const check = evaluateOutput(outcome.value.result);
      if (check.status === "fail") {
        addFailure(outcome.value.reviewer, check.reason);
      }
      continue;
    }

    const reviewer = orderedReviewers[index];
    addFailure(reviewer, reasonForFailure(reviewer, outcome.reason));
  }

  return {
    approved: failures === 0,
    consensusFail:
      orderedReviewers.length > 1 && failures === orderedReviewers.length,
    failureCount: failures,
    notes: notes.join("\n\n"),
  };
};

export const createRunReview = (run: RunAgentFn) => {
  return (reviewers: Agent[], task: string, opts: Options) =>
    runReviewWith(run, reviewers, task, opts);
};

export const runReview = async (
  reviewers: Agent[],
  task: string,
  opts: Options
): Promise<ReviewResult> =>
  runReviewWith(runReviewerAgent, reviewers, task, opts);
