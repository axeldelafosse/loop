import { preparePairedOptions } from "./paired-options";
import { buildPlanPrompt, buildPlanReviewPrompt } from "./prompts";
import { runAgent, runReviewerAgent } from "./runner";
import type { Agent, Options, PlanReviewMode } from "./types";
import { isFile, readPrompt } from "./utils";

const PLAN_FILE = "PLAN.md";
const MISSING_PROMPT_ERROR =
  "Missing prompt. Use --prompt, pass positional text, or create PLAN.md.";
const MARKDOWN_PATH_RE = /^[^\s]+\.md$/i;

const isMarkdownInput = (input: string): boolean =>
  MARKDOWN_PATH_RE.test(input.trim());

const resolvePlanReviewer = (
  reviewPlan: PlanReviewMode | undefined,
  agent: Agent
): Agent | undefined => {
  const mode = reviewPlan ?? "other";
  if (mode === "none") {
    return undefined;
  }
  if (mode === "other") {
    return agent === "codex" ? "claude" : "codex";
  }
  return mode;
};

const pairedSessionId = (opts: Options, agent: Agent): string | undefined => {
  if (!opts.pairedMode) {
    return undefined;
  }
  return agent === "claude"
    ? opts.pairedSessionIds?.claude
    : opts.pairedSessionIds?.codex;
};

const runPlanAgent = (agent: Agent, prompt: string, opts: Options) => {
  const sessionId = pairedSessionId(opts, agent);
  return sessionId
    ? runAgent(agent, prompt, opts, sessionId)
    : runAgent(agent, prompt, opts);
};

const runPlanReviewer = (agent: Agent, prompt: string, opts: Options) => {
  const sessionId = pairedSessionId(opts, agent);
  return sessionId
    ? runReviewerAgent(agent, prompt, opts, sessionId)
    : runReviewerAgent(agent, prompt, opts);
};

const runPlanMode = async (opts: Options, task: string): Promise<void> => {
  if (opts.pairedMode) {
    preparePairedOptions(opts, process.cwd(), false);
  }

  console.log("\n[loop] prompt text detected. creating PLAN.md first.");
  const planPrompt = buildPlanPrompt(task);
  const result = await runPlanAgent(opts.agent, planPrompt, opts);

  if (result.exitCode !== 0) {
    throw new Error(
      `[loop] planning ${opts.agent} exited with code ${result.exitCode}`
    );
  }

  if (!isFile(PLAN_FILE)) {
    throw new Error("[loop] planning step did not create PLAN.md");
  }

  const reviewer = resolvePlanReviewer(opts.reviewPlan, opts.agent);
  if (!reviewer) {
    console.log("\n[loop] skipping PLAN.md review (--review-plan none).");
    return;
  }
  console.log(`\n[loop] reviewing PLAN.md with ${reviewer}.`);
  const reviewPrompt = buildPlanReviewPrompt(task);
  const review = await runPlanReviewer(reviewer, reviewPrompt, opts);
  if (review.exitCode !== 0) {
    throw new Error(
      `[loop] plan review ${reviewer} exited with code ${review.exitCode}`
    );
  }
};

export const resolveTask = async (opts: Options): Promise<string> => {
  const source =
    opts.promptInput ?? (isFile(PLAN_FILE) ? PLAN_FILE : undefined);
  if (!source) {
    throw new Error(MISSING_PROMPT_ERROR);
  }

  if (!opts.promptInput || isMarkdownInput(opts.promptInput)) {
    return await readPrompt(source);
  }

  const task = opts.promptInput;
  await runPlanMode(opts, task);
  return await readPrompt(PLAN_FILE);
};
