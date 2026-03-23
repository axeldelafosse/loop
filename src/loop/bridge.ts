import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { LOOP_VERSION } from "./constants";
import { buildLaunchArgv } from "./launch";
import {
  appendRunTranscriptEntry,
  buildTranscriptPath,
  readRunManifest,
} from "./run-state";
import type { Agent } from "./types";

const BRIDGE_FILE = "bridge.jsonl";
const BRIDGE_SERVER = "loop-bridge";
const CONTENT_LENGTH_RE = /Content-Length:\s*(\d+)/i;
const DEFAULT_PROTOCOL_VERSION = "2024-11-05";
const HEADER_SEPARATOR = "\r\n\r\n";
const LINE_SPLIT_RE = /\r?\n/;
const MAX_STATUS_MESSAGES = 100;
const MCP_INVALID_PARAMS = -32_602;
const MCP_METHOD_NOT_FOUND = -32_601;

export const BRIDGE_SUBCOMMAND = "__bridge-mcp";

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
  codexThreadId: string;
  pending: { claude: number; codex: number };
  runId: string;
  status: string;
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
    codexThreadId: manifest?.codexThreadId ?? "",
    pending: countPendingMessages(runDir),
    runId: manifest?.runId ?? "",
    status: manifest?.status ?? "unknown",
  };
};

const writeJsonRpc = (payload: unknown): void => {
  const body = JSON.stringify(payload);
  const header = `Content-Length: ${Buffer.byteLength(body, "utf8")}${HEADER_SEPARATOR}`;
  process.stdout.write(`${header}${body}`);
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

const handleToolCall = (
  id: JsonRpcRequest["id"],
  runDir: string,
  source: Agent,
  params: unknown
): void => {
  const call = isRecord(params) ? (params as BridgeCallParams) : undefined;
  const name = call?.name;
  const args = isRecord(call?.arguments) ? call.arguments : {};

  if (name === "bridge_status") {
    writeJsonRpc({
      id,
      jsonrpc: "2.0",
      result: toolContent(JSON.stringify(readBridgeStatus(runDir), null, 2)),
    });
    return;
  }

  if (name !== "send_to_agent") {
    writeError(id, MCP_INVALID_PARAMS, `Unknown tool: ${name}`);
    return;
  }

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

  const entry = appendBridgeMessage(runDir, source, target, message);
  writeJsonRpc({
    id,
    jsonrpc: "2.0",
    result: toolContent(`queued ${entry.id} for ${target}`),
  });
};

const requestedProtocolVersion = (request: JsonRpcRequest): string =>
  asString((request.params as Record<string, unknown>)?.protocolVersion) ??
  DEFAULT_PROTOCOL_VERSION;

const handleBridgeRequest = (
  runDir: string,
  source: Agent,
  request: JsonRpcRequest
): void => {
  switch (request.method) {
    case "initialize":
      writeJsonRpc({
        id: request.id,
        jsonrpc: "2.0",
        result: {
          capabilities: { tools: {} },
          protocolVersion: requestedProtocolVersion(request),
          serverInfo: {
            name: BRIDGE_SERVER,
            version: LOOP_VERSION,
          },
        },
      });
      return;
    case "notifications/initialized":
      return;
    case "tools/list":
      writeJsonRpc({
        id: request.id,
        jsonrpc: "2.0",
        result: {
          tools: [
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
          ],
        },
      });
      return;
    case "tools/call":
      handleToolCall(request.id, runDir, source, request.params);
      return;
    default:
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

const shiftFrame = (buffer: Buffer): [JsonRpcRequest | undefined, Buffer] => {
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

const asBuffer = (chunk: Buffer | string): Buffer =>
  Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");

const drainBufferedFrames = (
  input: Buffer,
  onMessage: (request: JsonRpcRequest) => void
): Buffer => {
  let buffer = input;
  while (true) {
    const [message, next] = shiftFrame(buffer);
    buffer = next;
    if (!message) {
      return buffer;
    }
    onMessage(message);
  }
};

const consumeFrames = (
  onMessage: (request: JsonRpcRequest) => void
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
    process.stdin.on("end", () => resolve());
    process.stdin.on("error", reject);
  });

export const runBridgeMcpServer = async (
  runDir: string,
  source: Agent
): Promise<void> => {
  process.stdin.resume();
  await consumeFrames((request) => {
    handleBridgeRequest(runDir, source, request);
  });
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
  readBridgeEvents,
};
