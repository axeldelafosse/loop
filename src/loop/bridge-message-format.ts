import type { Agent } from "./types";

const BRIDGE_PREFIX_RE =
  /^(?:Message from (?:Claude|Codex) via the loop bridge:|(?:Claude|Codex):)\s*/i;

export const formatCodexBridgeMessage = (
  source: Agent,
  message: string
): string => {
  const trimmed = message.trim();
  if (!trimmed) {
    return "";
  }
  return source === "claude" ? `Claude: ${trimmed}` : trimmed;
};

export const normalizeBridgeMessage = (message: string): string =>
  message.trim().replace(BRIDGE_PREFIX_RE, "").replace(/\s+/g, " ").trim();
