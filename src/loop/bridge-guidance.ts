import { BRIDGE_SERVER, CLAUDE_CHANNEL_USER } from "./bridge-constants";
import type { Agent } from "./types";

const bridgeTargetLiteral = (agent: Agent): string => `target: "${agent}"`;

export const bridgeStatusStuckGuidance =
  'Use "bridge_status" only when direct delivery appears stuck.';

export const receiveMessagesStuckGuidance =
  'Use "bridge_status" or "receive_messages" only if delivery looks stuck.';

export const sendToClaudeGuidance = (): string =>
  `Use "send_to_agent" with ${bridgeTargetLiteral("claude")} for Claude-facing messages, not a human-facing message.`;

export const sendProactiveCodexGuidance = (): string =>
  `Use "send_to_agent" with ${bridgeTargetLiteral("codex")} for Codex-facing messages, including replies to inbound Codex channel messages; do not send Codex-facing responses as a human-facing message.`;

export const claudeChannelInstructions = (): string =>
  [
    `Messages from the Codex agent arrive as <channel source="${BRIDGE_SERVER}" chat_id="..." user="${CLAUDE_CHANNEL_USER}" ...>. The chat_id is informational only.`,
    sendProactiveCodexGuidance(),
    "Never answer the human when the inbound message came from Codex. Send the response back through the bridge tools instead.",
    bridgeStatusStuckGuidance,
  ].join("\n");
