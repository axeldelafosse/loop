import { NEWLINE_RE, REVIEW_FAIL, REVIEW_PASS } from "./constants";

export const SPAWN_TEAM_WITH_WORKTREE_ISOLATION =
  "Spawn a team of agents with worktree isolation.";

const appendProofRequirements = (parts: string[], proof: string): void => {
  const trimmed = proof.trim();
  if (!trimmed) {
    return;
  }
  parts.push(`Proof requirements:\n${trimmed}`);
};

const hasProofInTask = (task: string, proof: string): boolean => {
  const proofLines = proof
    .split(NEWLINE_RE)
    .map((line) => line.trim())
    .filter(Boolean);
  if (proofLines.length === 0) {
    return true;
  }

  const taskLines = new Set(
    task
      .split(NEWLINE_RE)
      .map((line) => line.trim())
      .filter(Boolean)
  );
  return proofLines.every((line) => taskLines.has(line));
};

export const buildPlanPrompt = (task: string): string =>
  [
    "Plan mode:",
    `Task:\n${task.trim()}`,
    "Create or update PLAN.md in the current repo with a clear implementation plan.",
    "Only write the plan in this step. Enter plan mode. Do not implement code yet.",
  ].join("\n\n");

export const buildPlanReviewPrompt = (task: string): string =>
  [
    "Plan review mode:",
    `Task:\n${task.trim()}`,
    "Review PLAN.md for correctness, missing steps, and verification gaps.",
    "Update PLAN.md directly if needed.",
    "Only edit PLAN.md in this step. Enter plan mode. Do not implement code yet.",
  ].join("\n\n");

export const buildWorkPrompt = (
  task: string,
  doneSignal: string,
  proof: string,
  reviewNotes?: string
): string => {
  const parts = [task.trim()];

  if (reviewNotes) {
    parts.push(
      `Review feedback:\n${reviewNotes.trim()}\n\nDecide what to address now. If you skip any comment, explain why briefly.`
    );
  }

  if (!hasProofInTask(task, proof)) {
    appendProofRequirements(parts, proof);
  }

  parts.push(
    `${SPAWN_TEAM_WITH_WORKTREE_ISOLATION} When all work is verified and once you have a proof that the task is completed, append "${doneSignal}" on its own final line.`
  );
  return parts.join("\n\n");
};

export const buildReviewPrompt = (
  task: string,
  doneSignal: string,
  proof: string
): string => {
  const parts = [
    `Review this completed work for the task below and verify it in the current repo.\n\nTask:\n${task.trim()}`,
    "Focus your review on unstaged changes (the diff produced by `git diff`). Run checks/tests/commands as needed.",
  ];

  appendProofRequirements(parts, proof);

  parts.push(
    `If review is needed, end your response with exactly "${REVIEW_FAIL}" on the final non-empty line. Nothing may follow this line.`
  );
  parts.push(
    `If the work is complete, end with exactly "${REVIEW_PASS}" on the final non-empty line. No extra content after this line.`
  );
  parts.push(
    "When reporting failures, include concrete file paths, commands, and code locations that must change."
  );
  parts.push(
    `${SPAWN_TEAM_WITH_WORKTREE_ISOLATION} The final line must be one of the two review signals on its own line, with no surrounding comments or markdown, and it must not include "${doneSignal}".`
  );
  return parts.join("\n\n");
};
