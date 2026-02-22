import { REVIEW_FAIL, REVIEW_PASS } from "./constants";

const NEWLINE_RE = /\r?\n/;
const SPAWN_TEAM_WITH_WORKTREE_ISOLATION =
  "Spawn a team of agents with worktree isolation.";

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
    "Only write the plan in this step. Do not implement code yet.",
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
    parts.push(`Proof requirements:\n${proof.trim()}`);
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
    "Run checks/tests/commands as needed and inspect changed files.",
  ];

  parts.push(`Proof requirements:\n${proof.trim()}`);

  parts.push(
    `If more work is needed, explain what to change and end with "${REVIEW_FAIL}" on its own final line.`
  );
  parts.push(
    `If the work is complete, end with "${REVIEW_PASS}" on its own final line.`
  );
  parts.push(
    `${SPAWN_TEAM_WITH_WORKTREE_ISOLATION} Do not use "${doneSignal}" in your final line.`
  );
  return parts.join("\n\n");
};
