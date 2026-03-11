import { createInterface } from "node:readline/promises";
import {
  doneText,
  formatFollowUp,
  iterationCooldown,
  logIterationHeader,
  logSessionHint,
  nextSessionId,
  tryRunAgent,
} from "./iteration";
import { runDraftPrStep } from "./pr";
import { buildWorkPrompt } from "./prompts";
import { resolveReviewers, runReview } from "./review";
import type { Options } from "./types";
import { hasSignal } from "./utils";

interface IterationResult {
  done: boolean;
  sessionId?: string;
}

const runIterations = async (
  task: string,
  opts: Options,
  reviewers: string[]
): Promise<IterationResult> => {
  let reviewNotes = "";
  let sessionId = opts.sessionId;
  const shouldReview = reviewers.length > 0;
  const { doneSignal, maxIterations } = opts;
  console.log(`\n[loop] PLAN.md:\n\n${task}`);

  for (let i = 1; i <= maxIterations; i++) {
    await iterationCooldown(i);
    logIterationHeader(i, maxIterations, sessionId);

    const prompt = buildWorkPrompt(task, doneSignal, opts.proof, reviewNotes);
    reviewNotes = "";

    const result = await tryRunAgent(opts.agent, prompt, opts, sessionId);
    sessionId = nextSessionId(opts.agent, sessionId);

    if (!result) {
      continue;
    }

    if (result.exitCode !== 0) {
      console.error(
        `\n[loop] ${opts.agent} exited with code ${result.exitCode}`
      );
      logSessionHint(opts.agent, sessionId);
      continue;
    }

    const output = `${result.parsed}\n${result.combined}`;
    if (!hasSignal(output, doneSignal)) {
      continue;
    }

    if (!shouldReview) {
      console.log(`\n[loop] ${doneText(doneSignal)} detected, stopping.`);
      return { done: true, sessionId };
    }

    const review = await runReview(reviewers, task, opts);
    if (review.approved) {
      await runDraftPrStep(task, opts, false, sessionId);
      console.log(
        `\n[loop] ${doneText(doneSignal)} detected and review passed, stopping.`
      );
      return { done: true, sessionId };
    }

    const followUp = formatFollowUp(review);
    reviewNotes = followUp.notes;
    console.log(followUp.log);
  }

  return { done: false, sessionId };
};

export const runLoop = async (task: string, opts: Options): Promise<void> => {
  const reviewers = resolveReviewers(opts.review, opts.agent);
  const rl = process.stdin.isTTY
    ? createInterface({ input: process.stdin, output: process.stdout })
    : undefined;
  let loopTask = task;

  try {
    while (true) {
      const result = await runIterations(loopTask, opts, reviewers);
      opts.sessionId = result.sessionId;
      if (result.done || !rl) {
        if (!result.done) {
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
