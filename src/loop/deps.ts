import { parseArgs } from "./args";
import { checkGitState } from "./git";
import { runLoop } from "./main";
import { runPanel } from "./panel";
import { resolveTask } from "./task";
import { runInTmux } from "./tmux";
import { maybeEnterWorktree } from "./worktree";

export const cliDeps = {
  checkGitState,
  maybeEnterWorktree,
  parseArgs,
  resolveTask,
  runInTmux,
  runLoop,
  runPanel,
};
