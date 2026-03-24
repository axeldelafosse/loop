export type Agent = "claude" | "codex";
export type Format = "pretty" | "raw";
export type ReviewMode = Agent | "claudex";
export type PlanReviewMode = Agent | "other" | "none";
export type ReviewStatus = "pass" | "fail";
export type RunLifecycleState =
  | "submitted"
  | "working"
  | "reviewing"
  | "input-required"
  | "completed"
  | "failed"
  | "stopped";
export type RunStatus = "running" | "done" | "failed" | "stopped";
export interface PairedSessionIds {
  claude?: string;
  codex?: string;
}
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
  | "runId"
  | "session";

export interface Options {
  agent: Agent;
  claudeMcpConfigPath?: string;
  claudePersistentSession?: boolean;
  claudeReviewerModel?: string;
  codexMcpConfigArgs?: string[];
  codexModel: string;
  codexReviewerModel?: string;
  doneSignal: string;
  format: Format;
  maxIterations: number;
  pairedMode?: boolean;
  pairedSessionIds?: PairedSessionIds;
  promptInput?: string;
  proof: string;
  resumeRunId?: string;
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

export interface ReviewFailure {
  reason: string;
  reviewer: Agent;
}

export interface ReviewOutcome extends ReviewFailure {
  status: ReviewStatus;
}

export interface ReviewResult {
  approved: boolean;
  consensusFail: boolean;
  failureCount: number;
  failures: ReviewFailure[];
  notes: string;
  reviews: ReviewOutcome[];
}
