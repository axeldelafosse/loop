export type Agent = "claude" | "codex";
export type Format = "pretty" | "raw";
export type ReviewMode = Agent | "claudex";
export type PlanReviewMode = Agent | "other" | "none";
export type ValueFlag =
  | "agent"
  | "prompt"
  | "max"
  | "done"
  | "proof"
  | "codexModel"
  | "codexReviewerModel"
  | "claudeReviewerModel"
  | "format"
  | "session";

export interface Options {
  agent: Agent;
  claudeReviewerModel?: string;
  codexModel: string;
  codexReviewerModel?: string;
  doneSignal: string;
  format: Format;
  maxIterations: number;
  promptInput?: string;
  proof: string;
  review?: ReviewMode;
  reviewPlan?: PlanReviewMode;
  sessionId?: string;
  tmux?: boolean;
  worktree?: boolean;
}

export interface RunResult {
  combined: string;
  exitCode: number;
  parsed: string;
}

export interface ReviewResult {
  approved: boolean;
  consensusFail: boolean;
  failureCount: number;
  notes: string;
}
