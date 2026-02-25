import { createInterface } from "node:readline/promises";
import { getLastClaudeSessionId } from "./claude-sdk-server";
import { getLastCodexThreadId } from "./codex-app-server";
import { runDraftPrStep } from "./pr";
import { buildWorkPrompt } from "./prompts";
import { resolveReviewers, runReview } from "./review";
import { runAgent } from "./runner";
import type { Agent, Options, ReviewResult, RunResult } from "./types";
import { hasSignal } from "./utils";

const DEFAULT_ITERATION_COOLDOWN_MS = 30_000;
const parseIterationCooldownMs = (): number => {
  const raw = process.env.LOOP_COOLDOWN_MS;
  if (raw === undefined) {
    return DEFAULT_ITERATION_COOLDOWN_MS;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    return DEFAULT_ITERATION_COOLDOWN_MS;
  }
  return parsed;
};
const ITERATION_COOLDOWN_MS = parseIterationCooldownMs();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const iterationCooldown = (i: number) =>
  i > 1 ? sleep(ITERATION_COOLDOWN_MS) : Promise.resolve();

const lastSession = (agent: Agent): string =>
  agent === "claude" ? getLastClaudeSessionId() : getLastCodexThreadId();

const doneText = (s: string) => `done signal "${s}"`;

const logSessionHint = (agent: Agent): void => {
  const sid = lastSession(agent);
  if (sid) {
    console.error(`[loop] to resume: loop --session ${sid}`);
  }
};

const logIterationHeader = (
  i: number,
  maxIterations: number,
  agent: Agent
): void => {
  const tag = Number.isFinite(maxIterations) ? `/${maxIterations}` : "";
  const sid = lastSession(agent);
  const sidTag = sid ? ` (session: ${sid})` : "";
  console.log(`\n[loop] iteration ${i}${tag}${sidTag}`);
};

const tryRunAgent = async (
  agent: Agent,
  prompt: string,
  opts: Options
): Promise<RunResult | undefined> => {
  try {
    return await runAgent(agent, prompt, opts);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`\n[loop] ${agent} error: ${msg}`);
    logSessionHint(agent);
    return undefined;
  }
};

const formatFollowUp = (review: ReviewResult) => {
  if (review.failureCount > 1) {
    const header = review.consensusFail
      ? "Both reviewers requested changes. Decide for each comment whether to address it now. If you skip one, explain why briefly. If both reviews found the same issue, it might be worth addressing."
      : "Multiple reviewers requested changes. Decide for each comment whether to address it now. If you skip one, explain why briefly.";
    return {
      notes: review.notes ? `${header}\n\n${review.notes}` : "",
      log: review.consensusFail
        ? "\n[loop] both reviewers requested changes. deciding what to address."
        : "\n[loop] multiple reviewers requested changes. deciding what to address.",
    };
  }

  return {
    notes: review.notes,
    log: "\n[loop] one reviewer requested changes. continuing loop.",
  };
};

const runIterations = async (
  task: string,
  opts: Options,
  reviewers: string[]
) => {
  let reviewNotes = "";
  const shouldReview = reviewers.length > 0;
  const { doneSignal, maxIterations } = opts;
  console.log(`\n[loop] PLAN.md:\n\n${task}`);
  for (let i = 1; i <= maxIterations; i++) {
    await iterationCooldown(i);
    logIterationHeader(i, maxIterations, opts.agent);
    const prompt = buildWorkPrompt(task, doneSignal, opts.proof, reviewNotes);
    reviewNotes = "";
    const result = await tryRunAgent(opts.agent, prompt, opts);
    if (!result) {
      continue;
    }
    if (result.exitCode !== 0) {
      console.error(
        `\n[loop] ${opts.agent} exited with code ${result.exitCode}`
      );
      logSessionHint(opts.agent);
      continue;
    }
    const output = `${result.parsed}\n${result.combined}`;
    if (!hasSignal(output, doneSignal)) {
      continue;
    }
    if (!shouldReview) {
      console.log(`\n[loop] ${doneText(doneSignal)} detected, stopping.`);
      return true;
    }
    const review = await runReview(reviewers, task, opts);
    if (review.approved) {
      await runDraftPrStep(task, opts);
      console.log(
        `\n[loop] ${doneText(doneSignal)} detected and review passed, stopping.`
      );
      return true;
    }
    const followUp = formatFollowUp(review);
    reviewNotes = followUp.notes;
    console.log(followUp.log);
  }
  return false;
};

export const runLoop = async (task: string, opts: Options): Promise<void> => {
  const reviewers = resolveReviewers(opts.review, opts.agent);
  const rl = process.stdin.isTTY
    ? createInterface({ input: process.stdin, output: process.stdout })
    : undefined;
  let loopTask = task;
  try {
    while (true) {
      const done = await runIterations(loopTask, opts, reviewers);
      if (done || !rl) {
        if (!done) {
          console.log(
            `\n[loop] reached max iterations (${opts.maxIterations}), stopping.`
          );
        }
        return;
      }
      console.log(`\n[loop] reached max iterations (${opts.maxIterations}).`);
      const answer = await rl.question(
        "\n[loop] follow-up prompt (blank to exit): "
      );
      if (!answer.trim()) {
        return;
      }
      loopTask = `${loopTask}\n\nFollow-up:\n${answer.trim()}`;
    }
  } finally {
    rl?.close();
  }
};
