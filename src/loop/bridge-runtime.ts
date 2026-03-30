import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn, spawnSync } from "bun";
import { removeClaudeChannelServer } from "./bridge-claude-registration";
import {
  claudeChannelServerName,
  legacyClaudeChannelServerName,
} from "./bridge-config";
import {
  BRIDGE_WORKER_SUBCOMMAND,
  CLAUDE_CHANNEL_USER,
} from "./bridge-constants";
import {
  acknowledgeBridgeDelivery,
  bridgeChatId,
  readNextPendingBridgeMessageForTarget,
} from "./bridge-dispatch";
import { formatCodexBridgeMessage } from "./bridge-message-format";
import {
  type BridgeMessage,
  type BridgeStatus,
  readBridgeInbox,
  readBridgeStatus,
} from "./bridge-store";
import { injectCodexMessage } from "./codex-app-server";
import { buildLaunchArgv } from "./launch";
import { DETACH_CHILD_PROCESS } from "./process";
import {
  isActiveRunState,
  parseRunLifecycleState,
  readRunManifest,
  touchRunManifest,
  updateRunManifest,
} from "./run-state";

const CLAUDE_CHANNEL_METHOD = "notifications/claude/channel";
const CLAUDE_CHANNEL_SOURCE_TYPE = "codex";
const CLAUDE_CHANNEL_USER_ID = "codex";
const BRIDGE_WORKER_FILE = "bridge-worker.json";
const BRIDGE_WORKER_IDLE_DELAY_MS = 250;
const BRIDGE_WORKER_SUCCESS_DELAY_MS = 100;
const CODEX_TMUX_PANE = "0.1";
const CODEX_TMUX_READY_DELAY_MS = 250;
const CODEX_TMUX_READY_POLLS = 20;
const CODEX_TMUX_SEND_FOOTER = "Ctrl+J newline";

export const bridgeRuntimeCommandDeps = { spawn, spawnSync };

const bridgeWorkerPath = (runDir: string): string =>
  join(runDir, BRIDGE_WORKER_FILE);

const readBridgeWorkerPid = (runDir: string): number | undefined => {
  const path = bridgeWorkerPath(runDir);
  if (!existsSync(path)) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as { pid?: unknown }).pid === "number" &&
      Number.isInteger((parsed as { pid: number }).pid) &&
      (parsed as { pid: number }).pid > 0
    ) {
      return (parsed as { pid: number }).pid;
    }
  } catch {
    // ignore malformed worker state
  }
  return undefined;
};

const writeBridgeWorkerPid = (runDir: string, pid: number): void => {
  writeFileSync(
    bridgeWorkerPath(runDir),
    `${JSON.stringify({ pid })}\n`,
    "utf8"
  );
};

const clearBridgeWorkerPid = (runDir: string, pid?: number): void => {
  const current = readBridgeWorkerPid(runDir);
  if (pid !== undefined && current !== pid) {
    return;
  }
  rmSync(bridgeWorkerPath(runDir), { force: true });
};

const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const wait = async (ms: number): Promise<void> => {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
};

const decodeOutput = (value: Uint8Array): string =>
  new TextDecoder().decode(value);

const codexPane = (session: string): string => `${session}:${CODEX_TMUX_PANE}`;

const capturePane = (pane: string): string => {
  const result = bridgeRuntimeCommandDeps.spawnSync(
    ["tmux", "capture-pane", "-p", "-t", pane],
    {
      stderr: "ignore",
      stdout: "pipe",
    }
  );
  if (result.exitCode !== 0) {
    return "";
  }
  return decodeOutput(result.stdout);
};

const sendPaneKeys = (pane: string, keys: string[]): void => {
  bridgeRuntimeCommandDeps.spawnSync(
    ["tmux", "send-keys", "-t", pane, ...keys],
    {
      stderr: "ignore",
    }
  );
};

const sendPaneText = (pane: string, text: string): void => {
  bridgeRuntimeCommandDeps.spawnSync(
    ["tmux", "send-keys", "-t", pane, "-l", "--", text],
    {
      stderr: "ignore",
    }
  );
};

const waitForCodexPane = async (session: string): Promise<boolean> => {
  const pane = codexPane(session);
  for (let attempt = 0; attempt < CODEX_TMUX_READY_POLLS; attempt += 1) {
    if (capturePane(pane).includes(CODEX_TMUX_SEND_FOOTER)) {
      return true;
    }
    await wait(CODEX_TMUX_READY_DELAY_MS);
  }
  return false;
};

const injectCodexTmuxMessage = async (
  session: string,
  message: string
): Promise<boolean> => {
  if (!(session && (await waitForCodexPane(session)))) {
    return false;
  }
  const pane = codexPane(session);
  const lines = message.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    sendPaneText(pane, lines[index] ?? "");
    if (index < lines.length - 1) {
      sendPaneKeys(pane, ["C-j"]);
    }
  }
  await wait(100);
  sendPaneKeys(pane, ["Enter"]);
  return true;
};

const tmuxSessionExists = (session: string): boolean => {
  try {
    const result = bridgeRuntimeCommandDeps.spawnSync(
      ["tmux", "has-session", "-t", session],
      {
        stderr: "ignore",
        stdout: "ignore",
      }
    );
    return result.exitCode === 0;
  } catch {
    return false;
  }
};

export interface BridgeRuntimeStatus extends BridgeStatus {
  codexDeliveryMode: "app-server" | "none" | "tmux";
  hasLiveTmuxSession: boolean;
}

export const readBridgeRuntimeStatus = (
  runDir: string
): BridgeRuntimeStatus => {
  const status = readBridgeStatus(runDir);
  const hasLiveTmuxSession = Boolean(
    status.tmuxSession && tmuxSessionExists(status.tmuxSession)
  );
  let codexDeliveryMode: BridgeRuntimeStatus["codexDeliveryMode"] = "none";
  if (status.hasCodexRemote) {
    codexDeliveryMode = "app-server";
  } else if (hasLiveTmuxSession) {
    codexDeliveryMode = "tmux";
  }
  return {
    ...status,
    codexDeliveryMode,
    hasLiveTmuxSession,
  };
};

export const ensureBridgeWorker = (runDir: string): boolean => {
  const status = readBridgeRuntimeStatus(runDir);
  const state = parseRunLifecycleState(status.state);
  if (!(status.hasCodexRemote && state && isActiveRunState(state))) {
    return false;
  }
  const currentPid = readBridgeWorkerPid(runDir);
  if (currentPid && isProcessAlive(currentPid)) {
    return true;
  }
  clearBridgeWorkerPid(runDir);
  try {
    const child = bridgeRuntimeCommandDeps.spawn(
      [...buildLaunchArgv(), BRIDGE_WORKER_SUBCOMMAND, runDir],
      {
        detached: DETACH_CHILD_PROCESS,
        env: process.env,
        stderr: "ignore",
        stdin: "ignore",
        stdout: "ignore",
      }
    );
    if (!(typeof child.pid === "number" && child.pid > 0)) {
      return false;
    }
    writeBridgeWorkerPid(runDir, child.pid);
    child.unref?.();
    return true;
  } catch {
    return false;
  }
};

export const hasLiveCodexTmuxSession = (runDir: string): boolean => {
  const manifest = readRunManifest(join(runDir, "manifest.json"));
  return Boolean(
    manifest?.tmuxSession && tmuxSessionExists(manifest.tmuxSession)
  );
};

export const clearStaleTmuxBridgeState = (runDir: string): boolean => {
  let removedServerNames: string[] = [];
  const next = updateRunManifest(join(runDir, "manifest.json"), (manifest) => {
    if (!manifest?.tmuxSession) {
      return manifest;
    }
    removedServerNames = [
      claudeChannelServerName(manifest.runId, manifest.repoId),
      legacyClaudeChannelServerName(manifest.runId),
    ];
    return touchRunManifest(
      {
        ...manifest,
        tmuxSession: undefined,
      },
      new Date().toISOString()
    );
  });
  if (!(next && removedServerNames.length > 0)) {
    return false;
  }
  for (const serverName of new Set(removedServerNames)) {
    removeClaudeChannelServer(
      serverName,
      (args) =>
        bridgeRuntimeCommandDeps.spawnSync(args, {
          stderr: "pipe",
          stdout: "ignore",
        }),
      console.error
    );
  }
  return true;
};

const writeChannelNotification = (
  runDir: string,
  message: BridgeMessage,
  writeJsonRpc: (payload: unknown) => void
): void => {
  writeJsonRpc({
    jsonrpc: "2.0",
    method: CLAUDE_CHANNEL_METHOD,
    params: {
      content: message.message,
      meta: {
        chat_id: bridgeChatId(runDir),
        message_id: message.id,
        source_type: CLAUDE_CHANNEL_SOURCE_TYPE,
        ts: new Date(message.at).toISOString(),
        user: CLAUDE_CHANNEL_USER,
        user_id: CLAUDE_CHANNEL_USER_ID,
      },
    },
  });
};

export const flushClaudeChannelMessages = (
  runDir: string,
  writeJsonRpc: (payload: unknown) => void
): void => {
  for (const message of readBridgeInbox(runDir, "claude")) {
    writeChannelNotification(runDir, message, writeJsonRpc);
    acknowledgeBridgeDelivery(runDir, message);
  }
};

export const deliverCodexBridgeMessage = async (
  runDir: string,
  message: BridgeMessage
): Promise<boolean> => {
  const status = readBridgeRuntimeStatus(runDir);
  if (status.tmuxSession && !status.hasLiveTmuxSession) {
    clearStaleTmuxBridgeState(runDir);
  }
  if (!status.hasCodexRemote) {
    return false;
  }
  try {
    const delivered = await injectCodexMessage(
      status.codexRemoteUrl,
      status.codexThreadId,
      formatCodexBridgeMessage(message.source, message.message)
    );
    if (delivered) {
      acknowledgeBridgeDelivery(
        runDir,
        message,
        "accepted by codex app-server"
      );
    }
    return delivered;
  } catch {
    return false;
  }
};

export const drainCodexTmuxMessages = async (
  runDir: string
): Promise<boolean> => {
  const status = readBridgeRuntimeStatus(runDir);
  if (!status.tmuxSession) {
    return false;
  }
  if (!status.hasLiveTmuxSession) {
    clearStaleTmuxBridgeState(runDir);
    return false;
  }
  const message = readNextPendingBridgeMessageForTarget(runDir, "codex");
  if (!message) {
    return false;
  }
  const delivered = await injectCodexTmuxMessage(
    status.tmuxSession,
    formatCodexBridgeMessage(message.source, message.message)
  );
  if (!delivered) {
    return false;
  }
  acknowledgeBridgeDelivery(runDir, message, "sent to codex tmux pane");
  return true;
};

export const drainCodexAppServerMessages = (
  runDir: string
): Promise<boolean> => {
  const status = readBridgeRuntimeStatus(runDir);
  if (!status.hasCodexRemote) {
    return Promise.resolve(false);
  }
  const message = readNextPendingBridgeMessageForTarget(runDir, "codex");
  if (!message) {
    return Promise.resolve(false);
  }
  return deliverCodexBridgeMessage(runDir, message);
};

export const runBridgeWorker = async (runDir: string): Promise<void> => {
  try {
    while (true) {
      const claimedPid = readBridgeWorkerPid(runDir);
      if (claimedPid && claimedPid !== process.pid) {
        return;
      }
      const status = readBridgeRuntimeStatus(runDir);
      const state = parseRunLifecycleState(status.state);
      if (!(state && isActiveRunState(state))) {
        return;
      }
      if (status.tmuxSession && !status.hasLiveTmuxSession) {
        clearStaleTmuxBridgeState(runDir);
        return;
      }
      const delivered = status.hasCodexRemote
        ? await drainCodexAppServerMessages(runDir)
        : await drainCodexTmuxMessages(runDir);
      if (!(status.hasCodexRemote || status.hasLiveTmuxSession)) {
        return;
      }
      await wait(
        delivered ? BRIDGE_WORKER_SUCCESS_DELAY_MS : BRIDGE_WORKER_IDLE_DELAY_MS
      );
    }
  } finally {
    clearBridgeWorkerPid(runDir, process.pid);
  }
};
