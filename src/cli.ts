#!/usr/bin/env bun
import { BRIDGE_SUBCOMMAND, runBridgeMcpServer } from "./loop/bridge";
import { closeClaudeSdk } from "./loop/claude-sdk-server";
import { closeAppServer } from "./loop/codex-app-server";
import { cliDeps } from "./loop/deps";
import type { Agent } from "./loop/types";
import { updateDeps } from "./loop/update-deps";

const TMUX_DETACH_HINT = "[loop] detach with Ctrl-b d";

const parseBridgeArgs = (argv: string[]): { runDir: string; source: Agent } => {
  const [runDir, source] = argv;
  if (!runDir || (source !== "claude" && source !== "codex")) {
    throw new Error("Usage: loop __bridge-mcp <run-dir> <claude|codex>");
  }
  return { runDir, source };
};

export const runCli = async (argv: string[]): Promise<void> => {
  if (argv[0] === BRIDGE_SUBCOMMAND) {
    const { runDir, source } = parseBridgeArgs(argv.slice(1));
    await runBridgeMcpServer(runDir, source);
    return;
  }

  try {
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
    const gitWarning = cliDeps.checkGitState();
    if (gitWarning) {
      console.log(gitWarning);
    }
    await cliDeps.maybeEnterWorktree(opts);
    const task = await cliDeps.resolveTask(opts);
    await cliDeps.runLoop(task, opts);
  } finally {
    await Promise.all([closeAppServer(), closeClaudeSdk()]);
  }
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
