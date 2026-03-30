import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { claudeChannelServerName } from "./bridge-config";
import { BRIDGE_SERVER } from "./bridge-constants";
import { normalizeBridgeMessage } from "./bridge-message-format";
import {
  appendRunTranscriptEntry,
  buildTranscriptPath,
  readRunManifest,
} from "./run-state";
import type { Agent } from "./types";

const BRIDGE_FILE = "bridge.jsonl";
const LINE_SPLIT_RE = /\r?\n/;
const MAX_STATUS_MESSAGES = 100;

interface BridgeBaseEvent {
  at: string;
  id: string;
  signature?: string;
  source: Agent;
  target: Agent;
}

export interface BridgeMessage extends BridgeBaseEvent {
  kind: "message";
  message: string;
}

interface BridgeAck extends BridgeBaseEvent {
  kind: "blocked" | "delivered";
  message?: string;
  reason?: string;
}

export type BridgeEvent = BridgeAck | BridgeMessage;

export interface BridgeStatus {
  bridgeServer: string;
  claudeBridgeMode: "local-registration" | "mcp-config";
  claudeChannelServer: string;
  claudeSessionId: string;
  codexRemoteUrl: string;
  codexThreadId: string;
  hasCodexRemote: boolean;
  hasTmuxSession: boolean;
  pending: { claude: number; codex: number };
  runId: string;
  state: string;
  status: string;
  tmuxSession: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value : undefined;

export const normalizeAgent = (value: unknown): Agent | undefined => {
  if (value === "claude" || value === "codex") {
    return value;
  }
  return undefined;
};

const orderedBridgePairKey = (source: Agent, target: Agent): string =>
  `${source}>${target}`;

const bridgeSignature = (
  source: Agent,
  target: Agent,
  message: string
): string => {
  return createHash("sha256")
    .update(
      `${orderedBridgePairKey(source, target)}\n${normalizeBridgeMessage(message)}`,
      "utf8"
    )
    .digest("hex");
};

const eventSignature = (event: BridgeMessage): string =>
  bridgeSignature(event.source, event.target, event.message);

export const bridgePath = (runDir: string): string => join(runDir, BRIDGE_FILE);

const ensureParentDir = (path: string): void => {
  mkdirSync(dirname(path), { recursive: true });
};

export const appendBridgeEvent = (runDir: string, event: BridgeEvent): void => {
  const path = bridgePath(runDir);
  ensureParentDir(path);
  appendFileSync(path, `${JSON.stringify(event)}\n`, "utf8");
};

export const readBridgeEvents = (runDir: string): BridgeEvent[] => {
  const path = bridgePath(runDir);
  if (!existsSync(path)) {
    return [];
  }

  const events: BridgeEvent[] = [];
  const messageById = new Map<string, string>();
  for (const line of readFileSync(path, "utf8").split(LINE_SPLIT_RE)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (!isRecord(parsed)) {
        continue;
      }
      const kind = asString(parsed.kind);
      const id = asString(parsed.id);
      const at = asString(parsed.at);
      const source = normalizeAgent(parsed.source);
      const target = normalizeAgent(parsed.target);
      const signature = asString(parsed.signature);
      if (!(kind && id && at && source && target)) {
        continue;
      }
      if (kind === "message") {
        const message = asString(parsed.message);
        if (!message) {
          continue;
        }
        messageById.set(id, message);
        events.push({
          at,
          id,
          kind,
          message,
          signature: bridgeSignature(source, target, message),
          source,
          target,
        });
        continue;
      }
      if (kind === "blocked" || kind === "delivered") {
        events.push({
          at,
          id,
          kind,
          message: messageById.get(id),
          reason: asString(parsed.reason),
          signature,
          source,
          target,
        });
      }
    } catch {
      // ignore malformed bridge lines
    }
  }
  return events;
};

export const readPendingBridgeMessages = (runDir: string): BridgeMessage[] => {
  const messages = new Map<string, BridgeMessage>();

  for (const event of readBridgeEvents(runDir)) {
    if (event.kind === "message") {
      messages.set(event.id, event);
      continue;
    }
    const pending = messages.get(event.id);
    if (!pending) {
      continue;
    }
    messages.delete(event.id);
  }

  return [...messages.values()].sort(
    (a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id)
  );
};

export const markBridgeMessage = (
  runDir: string,
  message: BridgeMessage,
  kind: "blocked" | "delivered",
  reason?: string
): void => {
  appendBridgeEvent(runDir, {
    at: new Date().toISOString(),
    id: message.id,
    kind,
    reason,
    signature: eventSignature(message),
    source: message.source,
    target: message.target,
  });
};

export const blocksBridgeBounce = (
  runDir: string,
  source: Agent,
  target: Agent,
  message: string
): boolean => {
  const normalized = normalizeBridgeMessage(message);
  const events = readBridgeEvents(runDir);
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.kind !== "delivered") {
      continue;
    }
    if (!event.message) {
      return false;
    }
    return (
      normalizeBridgeMessage(event.message) === normalized &&
      event.source === target &&
      event.target === source
    );
  }
  return false;
};

const countPendingMessages = (runDir: string): BridgeStatus["pending"] => {
  const pending = { claude: 0, codex: 0 };
  for (const message of readPendingBridgeMessages(runDir).slice(
    0,
    MAX_STATUS_MESSAGES
  )) {
    pending[message.target] += 1;
  }
  return pending;
};

export const readBridgeStatus = (runDir: string): BridgeStatus => {
  const manifest = readRunManifest(join(runDir, "manifest.json"));
  const runId = manifest?.runId ?? "";
  const codexRemoteUrl = manifest?.codexRemoteUrl ?? "";
  const codexThreadId = manifest?.codexThreadId ?? "";
  const tmuxSession = manifest?.tmuxSession ?? "";
  const hasTmuxSession = Boolean(tmuxSession);
  return {
    bridgeServer: BRIDGE_SERVER,
    claudeBridgeMode: hasTmuxSession ? "local-registration" : "mcp-config",
    claudeChannelServer:
      manifest?.claudeChannelServer ??
      (runId
        ? claudeChannelServerName(runId, manifest?.repoId)
        : BRIDGE_SERVER),
    claudeSessionId: manifest?.claudeSessionId ?? "",
    codexRemoteUrl,
    codexThreadId,
    hasCodexRemote: Boolean(codexRemoteUrl && codexThreadId),
    hasTmuxSession,
    pending: countPendingMessages(runDir),
    runId,
    state: manifest?.state ?? "unknown",
    status: manifest?.status ?? "unknown",
    tmuxSession,
  };
};

export const readBridgeInbox = (
  runDir: string,
  target: Agent
): BridgeMessage[] =>
  readPendingBridgeMessages(runDir)
    .filter((message) => message.target === target)
    .slice(0, MAX_STATUS_MESSAGES);

export const formatBridgeInbox = (messages: BridgeMessage[]): string =>
  JSON.stringify(
    messages.map((message) => ({
      at: message.at,
      from: message.source,
      id: message.id,
      message: message.message,
    })),
    null,
    2
  );

export const appendBridgeMessage = (
  runDir: string,
  source: Agent,
  target: Agent,
  message: string
): BridgeMessage => {
  const entry: BridgeMessage = {
    at: new Date().toISOString(),
    id: crypto.randomUUID(),
    kind: "message",
    message,
    signature: bridgeSignature(source, target, message),
    source,
    target,
  };
  appendBridgeEvent(runDir, entry);
  appendRunTranscriptEntry(buildTranscriptPath(runDir), {
    at: entry.at,
    from: source,
    message,
    to: target,
  });
  return entry;
};

export const appendBlockedBridgeMessage = (
  runDir: string,
  source: Agent,
  target: Agent,
  message: string,
  reason: string
): void => {
  appendBridgeEvent(runDir, {
    at: new Date().toISOString(),
    id: crypto.randomUUID(),
    kind: "blocked",
    reason,
    signature: bridgeSignature(source, target, message),
    source,
    target,
  });
};
