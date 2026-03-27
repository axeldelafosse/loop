import { join } from "node:path";
import { spawnSync } from "bun";
import { BRIDGE_SERVER, CLAUDE_CHANNEL_USER } from "./bridge-constants";
import {
  acknowledgeBridgeDelivery,
  bridgeChatId,
  readNextPendingBridgeMessageForTarget,
} from "./bridge-dispatch";
import {
  type BridgeMessage,
  readBridgeInbox,
  readBridgeStatus,
} from "./bridge-store";
import { injectCodexMessage } from "./codex-app-server";
import { sanitizeBase } from "./git";
import {
  isActiveRunState,
  parseRunLifecycleState,
  touchRunManifest,
  updateRunManifest,
} from "./run-state";

const CLAUDE_CHANNEL_METHOD = "notifications/claude/channel";
const CLAUDE_CHANNEL_SOURCE_TYPE = "codex";
const CLAUDE_CHANNEL_USER_ID = "codex";
const CODEX_TMUX_PANE = "0.1";
const CODEX_TMUX_READY_DELAY_MS = 250;
const CODEX_TMUX_READY_POLLS = 20;
const CODEX_TMUX_SEND_FOOTER = "Ctrl+J newline";

export const bridgeRuntimeCommandDeps = { spawnSync };

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
  const result = bridgeRuntimeCommandDeps.spawnSync(
    ["tmux", "has-session", "-t", session],
    {
      stderr: "ignore",
      stdout: "ignore",
    }
  );
  return result.exitCode === 0;
};

export const hasLiveCodexTmuxSession = (runDir: string): boolean => {
  const { tmuxSession } = readBridgeStatus(runDir);
  return Boolean(tmuxSession && tmuxSessionExists(tmuxSession));
};

export const claudeChannelServerName = (runId: string): string =>
  `${BRIDGE_SERVER}-${sanitizeBase(runId)}`;

const logClaudeChannelServerRemovalFailure = (
  serverName: string,
  detail: string
): void => {
  console.error(
    `[loop] failed to remove Claude channel server "${serverName}": ${detail}`
  );
};

const removeClaudeChannelServer = (runId: string): void => {
  if (!runId) {
    return;
  }
  const serverName = claudeChannelServerName(runId);
  try {
    const result = bridgeRuntimeCommandDeps.spawnSync(
      ["claude", "mcp", "remove", "--scope", "local", serverName],
      {
        stderr: "pipe",
        stdout: "ignore",
      }
    );
    if (result.exitCode === 0) {
      return;
    }
    const stderr = result.stderr ? decodeOutput(result.stderr).trim() : "";
    logClaudeChannelServerRemovalFailure(
      serverName,
      stderr || `exit code ${result.exitCode ?? "unknown"}`
    );
  } catch (error: unknown) {
    // Cleanup should not fail the bridge flow.
    logClaudeChannelServerRemovalFailure(
      serverName,
      error instanceof Error ? error.message : String(error)
    );
  }
};

export const clearStaleTmuxBridgeState = (runDir: string): boolean => {
  let removedRunId = "";
  const next = updateRunManifest(join(runDir, "manifest.json"), (manifest) => {
    if (!manifest?.tmuxSession) {
      return manifest;
    }
    removedRunId = manifest.runId;
    return touchRunManifest(
      {
        ...manifest,
        tmuxSession: undefined,
      },
      new Date().toISOString()
    );
  });
  if (!(next && removedRunId)) {
    return false;
  }
  removeClaudeChannelServer(removedRunId);
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
  const status = readBridgeStatus(runDir);
  if (status.tmuxSession) {
    if (tmuxSessionExists(status.tmuxSession)) {
      return false;
    }
    clearStaleTmuxBridgeState(runDir);
  }
  if (!(status.codexRemoteUrl && status.codexThreadId)) {
    return false;
  }
  try {
    const delivered = await injectCodexMessage(
      status.codexRemoteUrl,
      status.codexThreadId,
      message.message
    );
    if (delivered) {
      acknowledgeBridgeDelivery(runDir, message, "sent to codex app-server");
    }
    return delivered;
  } catch {
    return false;
  }
};

export const drainCodexTmuxMessages = async (
  runDir: string
): Promise<boolean> => {
  const { tmuxSession } = readBridgeStatus(runDir);
  if (!tmuxSession) {
    return false;
  }
  if (!tmuxSessionExists(tmuxSession)) {
    clearStaleTmuxBridgeState(runDir);
    return false;
  }
  const message = readNextPendingBridgeMessageForTarget(runDir, "codex");
  if (!message) {
    return false;
  }
  const delivered = await injectCodexTmuxMessage(tmuxSession, message.message);
  if (!delivered) {
    return false;
  }
  acknowledgeBridgeDelivery(runDir, message, "sent to codex tmux pane");
  return true;
};

export const runBridgeWorker = async (runDir: string): Promise<void> => {
  while (true) {
    const status = readBridgeStatus(runDir);
    const state = parseRunLifecycleState(status.state);
    if (!(state && isActiveRunState(state))) {
      return;
    }
    if (!status.tmuxSession) {
      return;
    }
    if (!tmuxSessionExists(status.tmuxSession)) {
      clearStaleTmuxBridgeState(runDir);
      return;
    }
    const delivered = await drainCodexTmuxMessages(runDir);
    await wait(delivered ? 100 : CODEX_TMUX_READY_DELAY_MS);
  }
};
