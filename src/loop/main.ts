import { createInterface } from "node:readline/promises";
import { runDraftPrStep } from "./pr";
import { buildWorkPrompt } from "./prompts";
import { resolveReviewers, runReview } from "./review";
import { runAgent } from "./runner";
import type { Options, ReviewResult } from "./types";
import { hasSignal } from "./utils";

const doneText = (s: string) => `done signal "${s}"`;

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
    const tag = Number.isFinite(maxIterations) ? `/${maxIterations}` : "";
    console.log(`\n[loop] iteration ${i}${tag}`);
    const prompt = buildWorkPrompt(task, doneSignal, opts.proof, reviewNotes);
    reviewNotes = "";
    const result = await runAgent(opts.agent, prompt, opts);
    const output = `${result.parsed}\n${result.combined}`;
    const done = hasSignal(output, doneSignal);
    if (result.exitCode !== 0) {
      const hint = done ? ` (${doneText(doneSignal)} seen)` : "";
      throw new Error(
        `[loop] ${opts.agent} exited with code ${result.exitCode}${hint}`
      );
    }
    if (!done) {
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
