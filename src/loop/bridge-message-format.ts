import type { Agent } from "./types";

const BRIDGE_TAG_RE = /<\/?loop-bridge(?:\s+[^>]*)?>/gi;
const BRIDGE_PREFIX_RE =
  /^(?:Message from (?:Claude|Codex) via the loop bridge:|(?:Claude|Codex):)\s*/i;

const bridgeSourceLabel = (source: Agent): string =>
  source === "claude" ? "Claude" : "Codex";

export const formatCodexBridgeMessage = (
  source: Agent,
  message: string,
  messageId?: string
): string => {
  const trimmed = message.trim();
  if (!trimmed) {
    return "";
  }
  const messageIdAttr = messageId ? ` message_id="${messageId}"` : "";
  return [
    `<loop-bridge source="${source}"${messageIdAttr}>`,
    `${bridgeSourceLabel(source)}: ${trimmed}`,
    "</loop-bridge>",
  ].join("\n");
};

export const normalizeBridgeMessage = (message: string): string =>
  message
    .trim()
    .replace(BRIDGE_TAG_RE, " ")
    .trim()
    .replace(BRIDGE_PREFIX_RE, "")
    .replace(/\s+/g, " ")
    .trim();
