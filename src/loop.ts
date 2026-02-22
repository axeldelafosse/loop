#!/usr/bin/env bun
import { cliDeps } from "./loop/deps";
import { updateDeps } from "./loop/update-deps";

const TMUX_DETACH_HINT = "[loop] detach with Ctrl-b d";

export const runCli = async (argv: string[]): Promise<void> => {
  await updateDeps.applyStagedUpdateOnStartup();
  if (await updateDeps.handleManualUpdateCommand(argv)) {
    return;
  }
  updateDeps.startAutoUpdateCheck();

  if (process.env.TMUX) {
    console.log(TMUX_DETACH_HINT);
  }
  if (argv.length === 0) {
    await cliDeps.runPanel();
    return;
  }
  const opts = cliDeps.parseArgs(argv);
  if (opts.tmux && cliDeps.runInTmux(argv)) {
    return;
  }
  await cliDeps.maybeEnterWorktree(opts);
  const task = await cliDeps.resolveTask(opts);
  await cliDeps.runLoop(task, opts);
};

const main = async (): Promise<void> => {
  await runCli(process.argv.slice(2));
};

if (import.meta.main) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[loop] error: ${message}`);
    process.exit(1);
  });
}
