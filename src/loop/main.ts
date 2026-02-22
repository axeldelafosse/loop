import { createInterface } from "node:readline/promises";
import { runDraftPrStep } from "./pr";
import { buildWorkPrompt } from "./prompts";
import { resolveReviewers, runReview } from "./review";
import { runAgent } from "./runner";
import type { Options } from "./types";
import { hasSignal } from "./utils";

const doneSignalText = (doneSignal: string) => `done signal "${doneSignal}"`;
const doneSignalMissingText = (signal: string) =>
  `\n[loop] ${doneSignalText(signal)} detected, stopping.`;
const doneSignalPassedText = (signal: string) =>
  `\n[loop] ${doneSignalText(signal)} detected and review passed, stopping.`;
const doneSignalExitText = (doneSignal: string, exitCode: number) =>
  `[loop] ${doneSignalText(doneSignal)} seen despite exit code ${exitCode}.`;
const bothReviewersNotes = (notes: string): string =>
  "Both reviewers requested changes. Decide for each comment whether to address it now. " +
  `If you skip one, explain why briefly. If both reviews found the same issue, it might be worth addressing.\n\n${notes}`;

const runIterations = async (
  task: string,
  opts: Options,
  reviewers: string[],
  hasExistingPr = false
): Promise<boolean> => {
  let reviewNotes = "";
  const shouldReview = reviewers.length > 0;
  const doneSignal = opts.doneSignal;
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
    const output = `${result.parsed}\n${result.combined}`;
    const done = hasSignal(output, doneSignal);
    if (!done && result.exitCode !== 0) {
      throw new Error(
        `[loop] ${opts.agent} exited with code ${result.exitCode}`
      );
    }
    if (!done) {
      continue;
    }
    if (result.exitCode !== 0) {
      console.log(doneSignalExitText(doneSignal, result.exitCode));
    }
    if (!shouldReview) {
      console.log(doneSignalMissingText(doneSignal));
      return true;
    }
    const review = await runReview(reviewers, task, opts);
    if (review.approved) {
      await runDraftPrStep(task, opts, hasExistingPr);
      console.log(doneSignalPassedText(opts.doneSignal));
      return true;
    }
    if (review.consensusFail) {
      reviewNotes = bothReviewersNotes(review.notes);
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
  const interactive = process.stdin.isTTY;
  const rl = interactive
    ? createInterface({ input: process.stdin, output: process.stdout })
    : undefined;
  let hasExistingPr = false;
  let loopTask = task;
  while (true) {
    const done = await runIterations(loopTask, opts, reviewers, hasExistingPr);
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
    loopTask = `${loopTask}\n\nFollow-up:\n${followUp}`;
  }
};
