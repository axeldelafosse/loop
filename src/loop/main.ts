import { createInterface } from "node:readline/promises";
import { runDraftPrStep } from "./pr";
import { buildWorkPrompt } from "./prompts";
import { resolveReviewers, runReview } from "./review";
import { runAgent } from "./runner";
import type { Options } from "./types";
import { hasSignal } from "./utils";

const runIterations = async (
  task: string,
  opts: Options,
  reviewers: string[],
  hasExistingPr = false
): Promise<boolean> => {
  let reviewNotes = "";
  console.log(`\n[loop] PLAN.md:\n\n${task}`);
  for (let i = 1; i <= opts.maxIterations; i++) {
    const tag = Number.isFinite(opts.maxIterations)
      ? `/${opts.maxIterations}`
      : "";
    console.log(`\n[loop] iteration ${i}${tag}`);
    const prompt = buildWorkPrompt(
      task,
      opts.doneSignal,
      opts.proof,
      reviewNotes
    );
    reviewNotes = "";
    const result = await runAgent(opts.agent, prompt, opts);
    if (result.exitCode !== 0) {
      throw new Error(
        `[loop] ${opts.agent} exited with code ${result.exitCode}`
      );
    }
    const output = `${result.parsed}\n${result.combined}`;
    if (!hasSignal(output, opts.doneSignal)) {
      continue;
    }
    if (reviewers.length === 0) {
      console.log(
        `\n[loop] done signal "${opts.doneSignal}" detected, stopping.`
      );
      return true;
    }
    const review = await runReview(reviewers, task, opts);
    if (review.approved) {
      await runDraftPrStep(task, opts, hasExistingPr);
      console.log(
        `\n[loop] done signal "${opts.doneSignal}" detected and review passed, stopping.`
      );
      return true;
    }
    if (review.consensusFail) {
      reviewNotes =
        "Both reviewers requested changes. Decide for each comment whether to address it now. " +
        `If you skip one, explain why briefly. If both reviews found the same issue, it might be worth addressing.\n\n${review.notes}`;
      console.log(
        "\n[loop] both reviews collected. original agent deciding what to address."
      );
      continue;
    }
    reviewNotes = review.notes || "Reviewer found more work to do.";
    console.log("\n[loop] review found more work. continuing loop.");
  }
  return false;
};

export const runLoop = async (task: string, opts: Options): Promise<void> => {
  const reviewers = resolveReviewers(opts.review, opts.agent);
  const interactive = process.stdin.isTTY || Boolean(process.env.TMUX);
  const rl = interactive
    ? createInterface({ input: process.stdin, output: process.stdout })
    : undefined;
  let hasExistingPr = false;
  let currentTask = task;
  while (true) {
    const done = await runIterations(
      currentTask,
      opts,
      reviewers,
      hasExistingPr
    );
    if (reviewers.length > 0 && done) {
      hasExistingPr = true;
    }
    if (!rl) {
      if (!done) {
        console.log(
          `\n[loop] reached max iterations (${opts.maxIterations}), stopping.`
        );
      }
      return;
    }
    if (!done) {
      console.log(`\n[loop] reached max iterations (${opts.maxIterations}).`);
    }
    const answer = await rl.question(
      "\n[loop] follow-up prompt (blank to exit): "
    );
    const followUp = answer.trim() || null;
    if (!followUp) {
      rl.close();
      return;
    }
    currentTask = `${currentTask}\n\nFollow-up:\n${followUp}`;
  }
};
