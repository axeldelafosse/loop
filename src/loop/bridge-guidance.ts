import { BRIDGE_SERVER, CLAUDE_CHANNEL_USER } from "./bridge-constants";
import type { Agent } from "./types";

const bridgeTargetLiteral = (agent: Agent): string => `target: "${agent}"`;

export const claudeReplyGuidance =
  'When you are replying to an inbound channel message, use the "reply" tool and pass back the same chat_id.';

export const claudeTmuxReplyGuidance =
  'Reply to inbound Codex channel messages with the "reply" tool and the same chat_id.';

export const bridgeStatusStuckGuidance =
  'Use "bridge_status" only when direct delivery appears stuck.';

export const receiveMessagesStuckGuidance =
  'Use "bridge_status" or "receive_messages" only if delivery looks stuck.';

export const sendToClaudeGuidance = (): string =>
  `Use "send_to_agent" with ${bridgeTargetLiteral("claude")} for Claude-facing messages, not a human-facing message.`;

export const sendProactiveCodexGuidance = (): string =>
  `Use "send_to_agent" with ${bridgeTargetLiteral("codex")} only for new proactive messages to Codex; do not send Codex-facing responses as a human-facing message.`;

export const claudeChannelInstructions = (): string =>
  [
    `Messages from the Codex agent arrive as <channel source="${BRIDGE_SERVER}" chat_id="..." user="${CLAUDE_CHANNEL_USER}" ...>.`,
    claudeReplyGuidance,
    "Never answer the human when the inbound message came from Codex. Send the response back through the bridge tools instead.",
    sendProactiveCodexGuidance(),
    bridgeStatusStuckGuidance,
  ].join("\n");
