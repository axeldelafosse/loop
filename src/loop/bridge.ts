import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "bun";
import { injectCodexMessage } from "./codex-app-server";
import { LOOP_VERSION } from "./constants";
import { buildLaunchArgv } from "./launch";
import {
  appendRunTranscriptEntry,
  buildTranscriptPath,
  isActiveRunState,
  parseRunLifecycleState,
  readRunManifest,
} from "./run-state";
import type { Agent } from "./types";

const BRIDGE_FILE = "bridge.jsonl";
const CHANNEL_POLL_DELAY_MS = 500;
const CLAUDE_CHANNEL_CAPABILITY = "claude/channel";
const CLAUDE_CHANNEL_METHOD = "notifications/claude/channel";
const CLAUDE_CHANNEL_SOURCE_TYPE = "codex";
const CLAUDE_CHANNEL_USER = "Codex";
const CLAUDE_CHANNEL_USER_ID = "codex";
const CONTENT_LENGTH_RE = /Content-Length:\s*(\d+)/i;
const CONTENT_LENGTH_PREFIX = "content-length:";
const DEFAULT_PROTOCOL_VERSION = "2024-11-05";
const HEADER_SEPARATOR = "\r\n\r\n";
const LINE_SPLIT_RE = /\r?\n/;
const CODEX_TMUX_PANE = "0.1";
const CODEX_TMUX_READY_DELAY_MS = 250;
const CODEX_TMUX_READY_POLLS = 20;
const CODEX_TMUX_SEND_FOOTER = "Ctrl+J newline";
const MAX_STATUS_MESSAGES = 100;
const MCP_INVALID_PARAMS = -32_602;
const MCP_METHOD_NOT_FOUND = -32_601;

export const BRIDGE_SUBCOMMAND = "__bridge-mcp";
export const BRIDGE_WORKER_SUBCOMMAND = "__bridge-worker";
export const BRIDGE_SERVER = "loop-bridge";

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

type BridgeEvent = BridgeAck | BridgeMessage;

interface BridgeCallParams {
  arguments?: Record<string, unknown>;
  name?: string;
}

interface BridgeStatus {
  claudeSessionId: string;
  codexRemoteUrl: string;
  codexThreadId: string;
  pending: { claude: number; codex: number };
  runId: string;
  state: string;
  status: string;
  tmuxSession: string;
}

interface JsonRpcRequest {
  id?: number | string;
  method?: string;
  params?: unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value : undefined;

const normalizeAgent = (value: unknown): Agent | undefined => {
  if (value === "claude" || value === "codex") {
    return value;
  }
  return undefined;
};

const BRIDGE_PREFIX_RE =
  /^Message from (Claude|Codex) via the loop bridge:\s*/i;

const normalizeBridgeMessage = (message: string): string =>
  message.trim().replace(BRIDGE_PREFIX_RE, "").replace(/\s+/g, " ");

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

const bridgePath = (runDir: string): string => join(runDir, BRIDGE_FILE);

const ensureParentDir = (path: string): void => {
  mkdirSync(dirname(path), { recursive: true });
};

const appendBridgeEvent = (runDir: string, event: BridgeEvent): void => {
  const path = bridgePath(runDir);
  ensureParentDir(path);
  appendFileSync(path, `${JSON.stringify(event)}\n`, "utf8");
};

const readBridgeEvents = (runDir: string): BridgeEvent[] => {
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

const blocksBridgeBounce = (
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

const readBridgeStatus = (runDir: string): BridgeStatus => {
  const manifest = readRunManifest(join(runDir, "manifest.json"));
  return {
    claudeSessionId: manifest?.claudeSessionId ?? "",
    codexRemoteUrl: manifest?.codexRemoteUrl ?? "",
    codexThreadId: manifest?.codexThreadId ?? "",
    pending: countPendingMessages(runDir),
    runId: manifest?.runId ?? "",
    state: manifest?.state ?? "unknown",
    status: manifest?.status ?? "unknown",
    tmuxSession: manifest?.tmuxSession ?? "",
  };
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
  const result = spawnSync(["tmux", "capture-pane", "-p", "-t", pane], {
    stderr: "ignore",
    stdout: "pipe",
  });
  if (result.exitCode !== 0) {
    return "";
  }
  return decodeOutput(result.stdout);
};

const sendPaneKeys = (pane: string, keys: string[]): void => {
  spawnSync(["tmux", "send-keys", "-t", pane, ...keys], { stderr: "ignore" });
};

const sendPaneText = (pane: string, text: string): void => {
  spawnSync(["tmux", "send-keys", "-t", pane, "-l", "--", text], {
    stderr: "ignore",
  });
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
  const result = spawnSync(["tmux", "has-session", "-t", session], {
    stderr: "ignore",
    stdout: "ignore",
  });
  return result.exitCode === 0;
};

const claudeChannelInstructions = (): string =>
  [
    `Messages from the Codex agent arrive as <channel source="${BRIDGE_SERVER}" chat_id="..." user="${CLAUDE_CHANNEL_USER}" ...>.`,
    'When you are replying to an inbound channel message, use the "reply" tool and pass back the same chat_id.',
    'Use the "send_to_agent" tool for proactive messages to Codex that are not direct replies to a channel message.',
    'Use "bridge_status" only when direct delivery appears stuck.',
  ].join("\n");

const claudeChannelSessionId = (runDir: string): string => {
  const runId = readBridgeStatus(runDir).runId || "bridge";
  return `codex_${runId}`;
};

const writeChannelNotification = (
  runDir: string,
  message: BridgeMessage
): void => {
  writeJsonRpc({
    jsonrpc: "2.0",
    method: CLAUDE_CHANNEL_METHOD,
    params: {
      content: message.message,
      meta: {
        chat_id: claudeChannelSessionId(runDir),
        message_id: message.id,
        source_type: CLAUDE_CHANNEL_SOURCE_TYPE,
        ts: new Date(message.at).toISOString(),
        user: CLAUDE_CHANNEL_USER,
        user_id: CLAUDE_CHANNEL_USER_ID,
      },
    },
  });
};

const flushClaudeChannelMessages = (runDir: string): void => {
  for (const message of readPendingBridgeMessages(runDir)) {
    if (message.target !== "claude") {
      continue;
    }
    writeChannelNotification(runDir, message);
    markBridgeMessage(runDir, message, "delivered");
  }
};

// This bridge is launched under the agent CLIs' stdio MCP hooks, but those
// runtimes expect newline-delimited JSON here so async channel notifications can
// be pushed without Content-Length framing.
const writeJsonRpc = (payload: unknown): void => {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
};

const writeError = (
  id: JsonRpcRequest["id"],
  code: number,
  message: string
): void => {
  writeJsonRpc({
    error: { code, message },
    id,
    jsonrpc: "2.0",
  });
};

const toolContent = (
  text: string
): { content: Array<{ text: string; type: string }> } => ({
  content: [{ text, type: "text" }],
});

const inboxMessages = (runDir: string, target: Agent): BridgeMessage[] =>
  readPendingBridgeMessages(runDir)
    .filter((message) => message.target === target)
    .slice(0, MAX_STATUS_MESSAGES);

const formatInbox = (messages: BridgeMessage[]): string =>
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

const emptyResult = (id: JsonRpcRequest["id"], key: string): void => {
  writeJsonRpc({
    id,
    jsonrpc: "2.0",
    result: { [key]: [] },
  });
};

const appendBridgeMessage = (
  runDir: string,
  source: Agent,
  target: Agent,
  message: string
): BridgeMessage => {
  const signature = bridgeSignature(source, target, message);
  const entry: BridgeMessage = {
    at: new Date().toISOString(),
    id: crypto.randomUUID(),
    kind: "message",
    message,
    signature,
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

const deliverCodexBridgeMessage = async (
  runDir: string,
  message: BridgeMessage
): Promise<boolean> => {
  const status = readBridgeStatus(runDir);
  // A stale tmux session entry should not block direct app-server delivery on a
  // later non-tmux resume.
  if (status.tmuxSession && tmuxSessionExists(status.tmuxSession)) {
    return false;
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
      markBridgeMessage(
        runDir,
        message,
        "delivered",
        "sent to codex app-server"
      );
    }
    return delivered;
  } catch {
    return false;
  }
};

const drainCodexTmuxMessages = async (runDir: string): Promise<boolean> => {
  const { tmuxSession } = readBridgeStatus(runDir);
  if (!tmuxSession) {
    return false;
  }
  const message = readPendingBridgeMessages(runDir).find(
    (entry) => entry.target === "codex"
  );
  if (!message) {
    return false;
  }
  const delivered = await injectCodexTmuxMessage(tmuxSession, message.message);
  if (!delivered) {
    return false;
  }
  markBridgeMessage(runDir, message, "delivered", "sent to codex tmux pane");
  return true;
};

const queueBridgeMessage = async (
  runDir: string,
  source: Agent,
  target: Agent,
  message: string
): Promise<{ delivered: boolean; entry: BridgeMessage }> => {
  const entry = appendBridgeMessage(runDir, source, target, message);
  const delivered =
    target === "codex" ? await deliverCodexBridgeMessage(runDir, entry) : false;
  return { delivered, entry };
};

const formatDispatchResult = (
  runDir: string,
  target: Agent,
  delivered: boolean,
  entry: BridgeMessage
): string => {
  if (delivered) {
    return `delivered ${entry.id} to ${target}`;
  }
  const status = readBridgeStatus(runDir);
  if (
    target === "codex" &&
    status.tmuxSession &&
    tmuxSessionExists(status.tmuxSession)
  ) {
    return `accepted ${entry.id} for codex delivery`;
  }
  return `queued ${entry.id} for ${target}`;
};

const handleBridgeStatusTool = (
  id: JsonRpcRequest["id"],
  runDir: string
): void => {
  writeJsonRpc({
    id,
    jsonrpc: "2.0",
    result: toolContent(JSON.stringify(readBridgeStatus(runDir), null, 2)),
  });
};

const handleReceiveMessagesTool = (
  id: JsonRpcRequest["id"],
  runDir: string,
  source: Agent
): void => {
  const messages = inboxMessages(runDir, source);
  for (const message of messages) {
    markBridgeMessage(
      runDir,
      message,
      "delivered",
      "read via receive_messages"
    );
  }
  writeJsonRpc({
    id,
    jsonrpc: "2.0",
    result: toolContent(messages.length === 0 ? "[]" : formatInbox(messages)),
  });
};

const handleReplyTool = async (
  id: JsonRpcRequest["id"],
  runDir: string,
  source: Agent,
  args: Record<string, unknown>
): Promise<void> => {
  const chatId = asString(args.chat_id);
  const text = asString(args.text);
  if (!chatId) {
    writeError(id, MCP_INVALID_PARAMS, "reply requires a chat_id");
    return;
  }
  if (!text) {
    writeError(id, MCP_INVALID_PARAMS, "reply requires a non-empty text");
    return;
  }
  const { delivered, entry } = await queueBridgeMessage(
    runDir,
    source,
    "codex",
    text
  );
  writeJsonRpc({
    id,
    jsonrpc: "2.0",
    result: toolContent(
      formatDispatchResult(runDir, "codex", delivered, entry)
    ),
  });
};

const handleSendToAgentTool = async (
  id: JsonRpcRequest["id"],
  runDir: string,
  source: Agent,
  args: Record<string, unknown>
): Promise<void> => {
  const target = normalizeAgent(args.target);
  const message = asString(args.message);
  if (!target) {
    writeError(
      id,
      MCP_INVALID_PARAMS,
      "send_to_agent requires target=claude|codex"
    );
    return;
  }
  if (!message) {
    writeError(
      id,
      MCP_INVALID_PARAMS,
      "send_to_agent requires a non-empty message"
    );
    return;
  }
  if (target === source) {
    writeError(
      id,
      MCP_INVALID_PARAMS,
      "send_to_agent cannot target the current agent"
    );
    return;
  }

  if (blocksBridgeBounce(runDir, source, target, message)) {
    appendBridgeEvent(runDir, {
      at: new Date().toISOString(),
      id: crypto.randomUUID(),
      kind: "blocked",
      reason: "duplicate bridge message",
      signature: bridgeSignature(source, target, message),
      source,
      target,
    });
    writeJsonRpc({
      id,
      jsonrpc: "2.0",
      result: toolContent("suppressed duplicate bridge message"),
    });
    return;
  }

  const { delivered, entry } = await queueBridgeMessage(
    runDir,
    source,
    target,
    message
  );
  writeJsonRpc({
    id,
    jsonrpc: "2.0",
    result: toolContent(formatDispatchResult(runDir, target, delivered, entry)),
  });
};

const handleToolCall = async (
  id: JsonRpcRequest["id"],
  runDir: string,
  source: Agent,
  params: unknown
): Promise<void> => {
  const call = isRecord(params) ? (params as BridgeCallParams) : undefined;
  const name = call?.name;
  const args = isRecord(call?.arguments) ? call.arguments : {};

  if (name === "bridge_status") {
    handleBridgeStatusTool(id, runDir);
    return;
  }

  if (name === "receive_messages") {
    handleReceiveMessagesTool(id, runDir, source);
    return;
  }

  if (source === "claude" && name === "reply") {
    await handleReplyTool(id, runDir, source, args);
    return;
  }

  if (name !== "send_to_agent") {
    writeError(id, MCP_INVALID_PARAMS, `Unknown tool: ${name}`);
    return;
  }

  await handleSendToAgentTool(id, runDir, source, args);
};

const requestedProtocolVersion = (request: JsonRpcRequest): string =>
  asString((request.params as Record<string, unknown>)?.protocolVersion) ??
  DEFAULT_PROTOCOL_VERSION;

const handleBridgeRequest = async (
  runDir: string,
  source: Agent,
  request: JsonRpcRequest
): Promise<void> => {
  switch (request.method) {
    case "initialize":
      writeJsonRpc({
        id: request.id,
        jsonrpc: "2.0",
        result: {
          capabilities:
            source === "claude"
              ? {
                  experimental: { [CLAUDE_CHANNEL_CAPABILITY]: {} },
                  tools: {},
                }
              : { tools: {} },
          ...(source === "claude"
            ? { instructions: claudeChannelInstructions() }
            : {}),
          protocolVersion: requestedProtocolVersion(request),
          serverInfo: {
            name: BRIDGE_SERVER,
            version: LOOP_VERSION,
          },
        },
      });
      return;
    case "ping":
      writeJsonRpc({
        id: request.id,
        jsonrpc: "2.0",
        result: {},
      });
      return;
    case "notifications/initialized":
    case "notifications/cancelled":
      return;
    case "prompts/list":
      emptyResult(request.id, "prompts");
      return;
    case "resources/list":
      emptyResult(request.id, "resources");
      return;
    case "resources/templates/list":
      emptyResult(request.id, "resourceTemplates");
      return;
    case "tools/list":
      writeJsonRpc({
        id: request.id,
        jsonrpc: "2.0",
        result: {
          tools: [
            ...(source === "claude"
              ? [
                  {
                    description:
                      "Reply to the active Codex channel conversation and deliver the response back to Codex.",
                    inputSchema: {
                      additionalProperties: false,
                      properties: {
                        chat_id: { type: "string" },
                        text: { type: "string" },
                      },
                      required: ["chat_id", "text"],
                      type: "object",
                    },
                    name: "reply",
                  },
                ]
              : []),
            {
              description: "Send an explicit message to the paired agent.",
              inputSchema: {
                additionalProperties: false,
                properties: {
                  message: { type: "string" },
                  target: {
                    enum: ["claude", "codex"],
                    type: "string",
                  },
                },
                required: ["target", "message"],
                type: "object",
              },
              name: "send_to_agent",
            },
            {
              description:
                "Inspect the current paired run and pending bridge messages.",
              inputSchema: {
                additionalProperties: false,
                properties: {},
                type: "object",
              },
              name: "bridge_status",
            },
            {
              description:
                "Read and clear pending bridge messages addressed to you.",
              inputSchema: {
                additionalProperties: false,
                properties: {},
                type: "object",
              },
              name: "receive_messages",
            },
          ],
        },
      });
      return;
    case "tools/call":
      await handleToolCall(request.id, runDir, source, request.params);
      return;
    default:
      if (request.method?.startsWith("notifications/")) {
        return;
      }
      writeError(
        request.id,
        MCP_METHOD_NOT_FOUND,
        `Unsupported method: ${request.method}`
      );
  }
};

const readContentLength = (
  buffer: Buffer
): { bodyStart: number; length: number } | undefined => {
  const headerEnd = buffer.indexOf(HEADER_SEPARATOR);
  if (headerEnd < 0) {
    return undefined;
  }
  const header = buffer.subarray(0, headerEnd).toString("utf8");
  const length = Number.parseInt(
    header.match(CONTENT_LENGTH_RE)?.[1] ?? "",
    10
  );
  if (!Number.isInteger(length) || length < 0) {
    throw new Error("Invalid MCP frame header");
  }
  return {
    bodyStart: headerEnd + HEADER_SEPARATOR.length,
    length,
  };
};

const shiftContentLengthFrame = (
  buffer: Buffer
): [JsonRpcRequest | undefined, Buffer] => {
  const frame = readContentLength(buffer);
  if (!frame) {
    return [undefined, buffer];
  }
  const bodyEnd = frame.bodyStart + frame.length;
  if (buffer.length < bodyEnd) {
    return [undefined, buffer];
  }
  const body = buffer.subarray(frame.bodyStart, bodyEnd).toString("utf8");
  return [JSON.parse(body) as JsonRpcRequest, buffer.subarray(bodyEnd)];
};

const shiftLineFrame = (
  buffer: Buffer
): [JsonRpcRequest | undefined, Buffer] => {
  const newlineIndex = buffer.indexOf("\n");
  if (newlineIndex < 0) {
    return [undefined, buffer];
  }
  const next = buffer.subarray(newlineIndex + 1);
  const line = buffer.subarray(0, newlineIndex).toString("utf8").trim();
  if (!line) {
    return [undefined, next];
  }
  return [JSON.parse(line) as JsonRpcRequest, next];
};

const isContentLengthFrame = (buffer: Buffer): boolean => {
  const header = buffer
    .subarray(0, Math.min(buffer.length, CONTENT_LENGTH_PREFIX.length))
    .toString("utf8")
    .toLowerCase();
  return header === CONTENT_LENGTH_PREFIX;
};

const shiftFrame = (buffer: Buffer): [JsonRpcRequest | undefined, Buffer] => {
  if (isContentLengthFrame(buffer)) {
    return shiftContentLengthFrame(buffer);
  }
  return shiftLineFrame(buffer);
};

const asBuffer = (chunk: Buffer | string): Buffer =>
  Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");

const drainBufferedFrames = (
  input: Buffer,
  onMessage: (request: JsonRpcRequest) => void
): Buffer => {
  let buffer = input;
  while (true) {
    const current = buffer;
    const [message, next] = shiftFrame(buffer);
    if (!message && next === current) {
      return buffer;
    }
    buffer = next;
    if (message) {
      onMessage(message);
    }
  }
};

const consumeFrames = (
  onMessage: (request: JsonRpcRequest) => void,
  onEnd?: () => void
): Promise<void> =>
  new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);

    const onData = (chunk: Buffer | string): void => {
      try {
        buffer = drainBufferedFrames(
          Buffer.concat([buffer, asBuffer(chunk)]),
          onMessage
        );
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    };

    process.stdin.on("data", onData);
    process.stdin.on("end", () => {
      onEnd?.();
      resolve();
    });
    process.stdin.on("error", reject);
  });

export const runBridgeMcpServer = async (
  runDir: string,
  source: Agent
): Promise<void> => {
  let channelReady = false;
  let closed = false;
  let flushQueue: Promise<void> = Promise.resolve();
  let requestQueue: Promise<void> = Promise.resolve();
  const queueClaudeFlush = (): Promise<void> => {
    if (!(source === "claude" && channelReady)) {
      return Promise.resolve();
    }
    const next = () => {
      flushClaudeChannelMessages(runDir);
    };
    flushQueue = flushQueue.then(next, next);
    return flushQueue;
  };
  const pollClaudeChannel = async (): Promise<void> => {
    while (!closed) {
      await queueClaudeFlush();
      if (closed) {
        return;
      }
      await new Promise((resolve) => {
        setTimeout(resolve, CHANNEL_POLL_DELAY_MS);
      });
    }
  };

  process.stdin.resume();
  const poller = source === "claude" ? pollClaudeChannel() : Promise.resolve();
  await consumeFrames(
    (request) => {
      const handleRequest = async (): Promise<void> => {
        if (request.method === "notifications/initialized") {
          channelReady = true;
        }
        await handleBridgeRequest(runDir, source, request);
        await queueClaudeFlush();
      };
      requestQueue = requestQueue.then(handleRequest, handleRequest);
    },
    () => {
      closed = true;
    }
  );
  closed = true;
  await requestQueue;
  await queueClaudeFlush();
  await poller;
};

export const runBridgeWorker = async (runDir: string): Promise<void> => {
  while (true) {
    const status = readBridgeStatus(runDir);
    const state = parseRunLifecycleState(status.state);
    if (!(state && isActiveRunState(state))) {
      return;
    }
    if (!(status.tmuxSession && tmuxSessionExists(status.tmuxSession))) {
      return;
    }
    const delivered = await drainCodexTmuxMessages(runDir);
    await wait(delivered ? 100 : CODEX_TMUX_READY_DELAY_MS);
  }
};

const stringifyToml = (value: string): string => JSON.stringify(value);

export const buildCodexBridgeConfigArgs = (
  runDir: string,
  source: Agent
): string[] => {
  const [command, ...baseArgs] = buildLaunchArgv();
  const args = [...baseArgs, BRIDGE_SUBCOMMAND, runDir, source];
  return [
    "-c",
    `mcp_servers.${BRIDGE_SERVER}.command=${stringifyToml(command)}`,
    "-c",
    `mcp_servers.${BRIDGE_SERVER}.args=${JSON.stringify(args)}`,
  ];
};

export const ensureClaudeBridgeConfig = (
  runDir: string,
  source: Agent
): string => {
  const [command, ...baseArgs] = buildLaunchArgv();
  const path = join(runDir, `${source}-mcp.json`);
  ensureParentDir(path);
  writeFileSync(
    path,
    `${JSON.stringify(
      {
        mcpServers: {
          [BRIDGE_SERVER]: {
            args: [...baseArgs, BRIDGE_SUBCOMMAND, runDir, source],
            command,
            type: "stdio",
          },
        },
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  return path;
};

export const bridgeInternals = {
  appendBridgeEvent,
  bridgePath,
  drainCodexTmuxMessages,
  deliverCodexBridgeMessage,
  readBridgeEvents,
};
