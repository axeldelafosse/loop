import {
  BRIDGE_SERVER as BRIDGE_SERVER_VALUE,
  CLAUDE_CHANNEL_USER,
} from "./bridge-constants";
import {
  bridgeRuntimeCommandDeps,
  claudeChannelServerName,
  clearStaleTmuxBridgeState,
  consumeBridgeInbox,
  deliverCodexBridgeMessage,
  dispatchBridgeMessage,
  drainCodexTmuxMessages,
  flushClaudeChannelMessages,
  formatDispatchResult,
} from "./bridge-runtime";
import {
  appendBlockedBridgeMessage,
  appendBridgeEvent,
  blocksBridgeBounce,
  bridgePath,
  formatBridgeInbox,
  normalizeAgent,
  readBridgeEvents,
  readBridgeStatus,
} from "./bridge-store";
import { LOOP_VERSION } from "./constants";
import type { Agent } from "./types";

const CHANNEL_POLL_DELAY_MS = 500;
const CLAUDE_CHANNEL_CAPABILITY = "claude/channel";
const CONTENT_LENGTH_RE = /Content-Length:\s*(\d+)/i;
const CONTENT_LENGTH_PREFIX = "content-length:";
const DEFAULT_PROTOCOL_VERSION = "2024-11-05";
const HEADER_SEPARATOR = "\r\n\r\n";
const MCP_INVALID_PARAMS = -32_602;
const MCP_METHOD_NOT_FOUND = -32_601;
const MUTATING_TOOL_ANNOTATIONS = {
  destructiveHint: false,
  openWorldHint: false,
  readOnlyHint: false,
};
const RECEIVE_MESSAGES_TOOL_ANNOTATIONS = {
  destructiveHint: true,
  openWorldHint: false,
  readOnlyHint: false,
};
const READ_ONLY_TOOL_ANNOTATIONS = {
  destructiveHint: false,
  openWorldHint: false,
  readOnlyHint: true,
};

interface BridgeCallParams {
  arguments?: Record<string, unknown>;
  name?: string;
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

const normalizeLowerString = (value: unknown): string | undefined => {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  return normalized || undefined;
};

const claudeChannelInstructions = (): string =>
  [
    `Messages from the Codex agent arrive as <channel source="${BRIDGE_SERVER_VALUE}" chat_id="..." user="${CLAUDE_CHANNEL_USER}" ...>.`,
    'When you are replying to an inbound channel message, use the "reply" tool and pass back the same chat_id.',
    "Never answer the human when the inbound message came from Codex. Send the response back through the bridge tools instead.",
    'Use the "send_to_agent" tool with target: "codex" for proactive messages that are not direct replies to a channel message.',
    'Use "bridge_status" only when direct delivery appears stuck.',
  ].join("\n");

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

const emptyResult = (id: JsonRpcRequest["id"], key: string): void => {
  writeJsonRpc({
    id,
    jsonrpc: "2.0",
    result: { [key]: [] },
  });
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
  const messages = consumeBridgeInbox(
    runDir,
    source,
    "read via receive_messages"
  );
  writeJsonRpc({
    id,
    jsonrpc: "2.0",
    result: toolContent(
      messages.length === 0 ? "[]" : formatBridgeInbox(messages)
    ),
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
  const { delivered, entry } = await dispatchBridgeMessage(
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
  const normalizedTarget = normalizeLowerString(args.target);
  const message = asString(args.message);
  if (!normalizedTarget) {
    writeError(
      id,
      MCP_INVALID_PARAMS,
      "send_to_agent requires a non-empty target"
    );
    return;
  }
  const target = normalizeAgent(normalizedTarget);
  if (!target) {
    writeError(
      id,
      MCP_INVALID_PARAMS,
      `Unknown target "${normalizedTarget}" - expected "claude" or "codex"`
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
    appendBlockedBridgeMessage(
      runDir,
      source,
      target,
      message,
      "duplicate bridge message"
    );
    writeJsonRpc({
      id,
      jsonrpc: "2.0",
      result: toolContent("suppressed duplicate bridge message"),
    });
    return;
  }

  const { delivered, entry } = await dispatchBridgeMessage(
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
            name: BRIDGE_SERVER_VALUE,
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
                    annotations: MUTATING_TOOL_ANNOTATIONS,
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
              annotations: MUTATING_TOOL_ANNOTATIONS,
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
              annotations: READ_ONLY_TOOL_ANNOTATIONS,
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
              annotations: RECEIVE_MESSAGES_TOOL_ANNOTATIONS,
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
    const next = (): void => {
      flushClaudeChannelMessages(runDir, writeJsonRpc);
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

export const bridgeInternals = {
  appendBridgeEvent,
  bridgePath,
  clearStaleTmuxBridgeState,
  claudeChannelServerName,
  commandDeps: bridgeRuntimeCommandDeps,
  drainCodexTmuxMessages,
  deliverCodexBridgeMessage,
  readBridgeEvents,
};
