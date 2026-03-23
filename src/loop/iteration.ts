import { getLastClaudeSessionId } from "./claude-sdk-server";
import { getLastCodexThreadId } from "./codex-app-server";
import { runAgent } from "./runner";
import type { Agent, Options, ReviewResult, RunResult } from "./types";

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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const iterationCooldown = (i: number): Promise<void> =>
  i > 1 ? sleep(parseIterationCooldownMs()) : Promise.resolve();

const lastSession = (agent: Agent): string =>
  agent === "claude" ? getLastClaudeSessionId() : getLastCodexThreadId();

export const doneText = (s: string): string => `done signal "${s}"`;

export const logSessionHint = (agent: Agent): void => {
  const sid = lastSession(agent);
  if (sid) {
    console.error(`[loop] to resume: loop --session ${sid}`);
  }
};

export const logIterationHeader = (
  i: number,
  maxIterations: number,
  agent: Agent
): void => {
  const tag = Number.isFinite(maxIterations) ? `/${maxIterations}` : "";
  const sid = lastSession(agent);
  const sidTag = sid ? ` (session: ${sid})` : "";
  console.log(`\n[loop] iteration ${i}${tag}${sidTag}`);
};

export const tryRunAgent = async (
  agent: Agent,
  prompt: string,
  opts: Options,
  sessionId?: string
): Promise<RunResult | undefined> => {
  try {
    return await runAgent(agent, prompt, opts, sessionId);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`\n[loop] ${agent} error: ${msg}`);
    logSessionHint(agent);
    return undefined;
  }
};

export const formatFollowUp = (
  review: ReviewResult
): { notes: string; log: string } => {
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
