import { runAgent } from "./runner";
import type { Options } from "./types";

const buildDraftPrPrompt = (task: string, hasExistingPr: boolean): string =>
  hasExistingPr
    ? [
        "A PR already exists for this branch. Send a follow-up commit to it.",
        `Task context:\n${task.trim()}`,
        "Commit your follow-up changes, push them, and return the commit in your final response.",
      ].join("\n\n")
    : [
        "Create a draft GitHub pull request for the current branch.",
        `Task context:\n${task.trim()}`,
        "Use `gh pr create --draft` with a clear title and description.",
        "If a PR already exists for this branch, do not create another one.",
        "Return the PR URL in your final response.",
      ].join("\n\n");

export const runDraftPrStep = async (
  task: string,
  opts: Options,
  hasExistingPr = false
): Promise<void> => {
  const action = hasExistingPr ? "send commit" : "create draft PR";
  console.log(`\n[loop] review passed. asking model to ${action}.`);
  const result = await runAgent(
    opts.agent,
    buildDraftPrPrompt(task, hasExistingPr),
    opts
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `[loop] draft PR ${opts.agent} exited with code ${result.exitCode}`
    );
  }
};
