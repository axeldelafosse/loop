#!/usr/bin/env bun
import { runBridgeMcpServer } from "./loop/bridge";
import {
  BRIDGE_SUBCOMMAND,
  BRIDGE_WORKER_SUBCOMMAND,
} from "./loop/bridge-constants";
import { runBridgeWorker } from "./loop/bridge-runtime";
import { closeClaudeSdk } from "./loop/claude-sdk-server";
import { closeAppServer } from "./loop/codex-app-server";
import {
  CODEX_TMUX_PROXY_SUBCOMMAND,
  runCodexTmuxProxy,
} from "./loop/codex-tmux-proxy";
import { cliDeps } from "./loop/deps";
import type { Agent, Options } from "./loop/types";
import { updateDeps } from "./loop/update-deps";

const TMUX_DETACH_HINT = "[loop] detach with Ctrl-b d";
const DASHBOARD_COMMAND = "dashboard";
const DEFAULT_TMUX_ARGV = ["--tmux"];
const INTERACTIVE_TMUX_ERROR =
  "[loop] interactive paired tmux mode must be started outside tmux.";

const isPromptlessPairedTmuxLaunch = (opts: Options): boolean =>
  opts.tmux &&
  opts.pairedMode &&
  !opts.promptInput?.trim() &&
  !opts.proof.trim();

const shouldAwaitAutoUpdate = (opts: Options): boolean =>
  !process.env.TMUX && isPromptlessPairedTmuxLaunch(opts);

const parseBridgeArgs = (argv: string[]): { runDir: string; source: Agent } => {
  const [runDir, source] = argv;
  if (!runDir || (source !== "claude" && source !== "codex")) {
    throw new Error("Usage: loop __bridge-mcp <run-dir> <claude|codex>");
  }
  return { runDir, source };
};

const parseBridgeWorkerArgs = (argv: string[]): { runDir: string } => {
  const [runDir] = argv;
  if (!runDir) {
    throw new Error("Usage: loop __bridge-worker <run-dir>");
  }
  return { runDir };
};

const parseCodexTmuxProxyArgs = (
  argv: string[]
): { port: number; remoteUrl: string; runDir: string; threadId: string } => {
  const [runDir, remoteUrl, threadId, rawPort] = argv;
  const port = Number.parseInt(rawPort ?? "", 10);
  if (
    !(runDir && remoteUrl && threadId && Number.isInteger(port) && port > 0)
  ) {
    throw new Error(
      "Usage: loop __codex-tmux-proxy <run-dir> <remote-url> <thread-id> <port>"
    );
  }
  return { port, remoteUrl, runDir, threadId };
};

export const runCli = async (argv: string[]): Promise<void> => {
  if (argv[0] === BRIDGE_SUBCOMMAND) {
    const { runDir, source } = parseBridgeArgs(argv.slice(1));
    await runBridgeMcpServer(runDir, source);
    return;
  }
  if (argv[0] === BRIDGE_WORKER_SUBCOMMAND) {
    const { runDir } = parseBridgeWorkerArgs(argv.slice(1));
    await runBridgeWorker(runDir);
    return;
  }
  if (argv[0] === CODEX_TMUX_PROXY_SUBCOMMAND) {
    const { port, remoteUrl, runDir, threadId } = parseCodexTmuxProxyArgs(
      argv.slice(1)
    );
    await runCodexTmuxProxy(runDir, remoteUrl, threadId, port);
    return;
  }

  let shouldCloseAgents = true;
  try {
    const normalizedArgv = argv.length === 0 ? DEFAULT_TMUX_ARGV : argv;
    await updateDeps.applyStagedUpdateOnStartup();
    if (await updateDeps.handleManualUpdateCommand(normalizedArgv)) {
      return;
    }

    if (process.env.TMUX) {
      console.log(TMUX_DETACH_HINT);
    }
    if (normalizedArgv[0]?.toLowerCase() === DASHBOARD_COMMAND) {
      updateDeps.startAutoUpdateCheck();
      await cliDeps.runPanel();
      return;
    }
    const opts = cliDeps.parseArgs(normalizedArgv);
    const awaitAutoUpdate = shouldAwaitAutoUpdate(opts);
    if (!awaitAutoUpdate) {
      updateDeps.startAutoUpdateCheck();
    }
    if (
      opts.tmux &&
      !opts.pairedMode &&
      (await cliDeps.runInTmux(normalizedArgv))
    ) {
      shouldCloseAgents = false;
      return;
    }
    const gitWarning = cliDeps.checkGitState();
    if (gitWarning) {
      console.log(gitWarning);
    }
    await cliDeps.maybeEnterWorktree(opts);
    if (awaitAutoUpdate) {
      await updateDeps.awaitAutoUpdateCheck();
    }
    if (isPromptlessPairedTmuxLaunch(opts)) {
      if (await cliDeps.runInTmux(normalizedArgv, undefined, { opts })) {
        shouldCloseAgents = false;
        return;
      }
      throw new Error(INTERACTIVE_TMUX_ERROR);
    }
    const task = await cliDeps.resolveTask(opts);
    if (
      opts.tmux &&
      opts.pairedMode &&
      (await cliDeps.runInTmux(normalizedArgv, undefined, { opts, task }))
    ) {
      shouldCloseAgents = false;
      return;
    }
    await cliDeps.runLoop(task, opts);
  } finally {
    if (shouldCloseAgents) {
      await Promise.all([closeAppServer(), closeClaudeSdk()]);
    }
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
