import pkg from "../../package.json";
import type { ValueFlag } from "./types";

export const DEFAULT_DONE_SIGNAL = "<promise>DONE</promise>";
export const DEFAULT_CODEX_MODEL = "gpt-5.3-codex";
export const DEFAULT_CLAUDE_MODEL = "opus";
export const LOOP_VERSION = pkg.version;

export const HELP = `
loop - v${LOOP_VERSION} - meta agent loop runner

Usage:
  loop                              Open live panel for running claude/codex instances
  loop [options] [prompt]
  loop update                       Check for updates and stage if available
  loop upgrade                      Alias for update

Options:
  -a, --agent <claude|codex>        Agent CLI to run (default: codex)
  -p, --prompt <text|.md file>      Prompt text or path to a .md prompt file
  -m, --max-iterations <number>.    Max loops (default: infinite)
  -d, --done <signal>               Done signal (default: <promise>DONE</promise>)
  --proof <text>                    Proof requirements for task completion (required)
  --format <pretty|raw>             Log format (default: pretty)
  --review [claude|codex|claudex]   Review on done (default: claudex)
  --tmux                            Run in a detached tmux session (name: repo-loop-X)
  --worktree                        Create and run in a fresh git worktree (name: repo-loop-X)
  -v, --version                     Show loop version
  -h, --help                        Show this help

Auto-update:
  Updates are checked automatically on startup and applied on the next run.
  Use "loop update" to manually check and stage an update.
`.trim();

export const REVIEW_PASS = "<review>PASS</review>";
export const REVIEW_FAIL = "<review>FAIL</review>";
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
  "--format": "format",
};
