import pkg from "../../package.json";
import type { ValueFlag } from "./types";

export const DEFAULT_DONE_SIGNAL = "<promise>DONE</promise>";
export const DEFAULT_CODEX_MODEL = "gpt-5.4";
export const DEFAULT_CLAUDE_MODEL = "opus";
export const DEFAULT_MAX_ITERATIONS = 20;
export const LOOP_VERSION = pkg.version;

export const HELP = `
loop - v${LOOP_VERSION} - meta agent loop runner

Usage:
  loop                                     Open live panel for running claude/codex instances
  loop [options] [prompt]
  loop update                              Check for updates and apply if available
  loop upgrade                             Alias for update
  claude-loop [options] [prompt]           Alias for: loop --claude-only
  codex-loop [options] [prompt]            Alias for: loop --codex-only

Options:
  -a, --agent <claude|codex>               Agent CLI to run (default: codex)
  --claude-only                            Use Claude for work, review, and plan review
  --codex-only                             Use Codex for work, review, and plan review
  -p, --prompt <text|.md file>             Prompt text or path to a .md prompt file
  -m, --max-iterations <number>            Max loops (default: ${DEFAULT_MAX_ITERATIONS})
  -d, --done <signal>                      Done signal (default: <promise>DONE</promise>)
  --proof <text>                           Proof requirements for task completion
  --codex-model <model>                    Override codex model (default: ${DEFAULT_CODEX_MODEL})
  --codex-reviewer-model <model>           Override codex review model
  --claude-reviewer-model <model>          Override claude review model
  --format <pretty|raw>                    Log format (default: pretty)
  --review [claude|codex|claudex]          Review on done (default: claudex)
  --review-plan [other|claude|codex|none]  Review PLAN.md after plain-text planning (default: other)
  --session <id>                           Resume from a previous session/thread ID
  --tmux                                   Run in a detached tmux session (name: repo-loop-X)
  --worktree                               Create and run in a fresh git worktree (name: repo-loop-X)
  -v, --version                            Show loop version
  -h, --help                               Show this help

Auto-update:
  Updates are checked automatically on startup and applied on the next run.
  Use "loop update" to manually check and apply an update.
`.trim();

export const REVIEW_PASS = "<review>PASS</review>";
export const REVIEW_FAIL = "<review>FAIL</review>";
export const AGENT_TURN_TIMEOUT_MS = 42_000_069;
export const NEWLINE_RE = /\r?\n/;

export const VALUE_FLAGS: Record<string, ValueFlag> = {
  "-a": "agent",
  "--agent": "agent",
  "-p": "prompt",
  "--prompt": "prompt",
  "-m": "max",
  "--max-iterations": "max",
  "-d": "done",
  "--done": "done",
  "--proof": "proof",
  "--codex-model": "codexModel",
  "--codex-reviewer-model": "codexReviewerModel",
  "--claude-reviewer-model": "claudeReviewerModel",
  "--format": "format",
  "--session": "session",
};
