export type Agent = "claude" | "codex";
export type Format = "pretty" | "raw";
export type ReviewMode = Agent | "claudex";
export type ValueFlag =
  | "agent"
  | "prompt"
  | "max"
  | "done"
  | "proof"
  | "codexModel"
  | "format";

export interface Options {
  agent: Agent;
  doneSignal: string;
  format: Format;
  maxIterations: number;
  model: string;
  promptInput?: string;
  proof: string;
  review?: ReviewMode;
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
  notes: string;
}
