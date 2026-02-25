import type { Format } from "./types";

interface AppServerEvent {
  method?: unknown;
  params?: unknown;
}

interface CodexRenderState {
  activeItemHasDelta: boolean;
  activeItemId: string;
  lastCompleted: string;
  parsed: string;
  pendingMessageBreak: boolean;
  wrotePretty: boolean;
}

interface CodexRendererConfig {
  format: Format;
  write: (text: string) => void;
}

interface CodexRenderer {
  getParsed: () => string;
  onRawLine: (text: string) => void;
  wrotePretty: () => boolean;
}

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};

const asString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

const parseJsonLine = (line: string): Record<string, unknown> | undefined => {
  if (!line.trim().startsWith("{")) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(line);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
};

const collectText = (
  value: unknown,
  out: string[],
  primaryField: string,
  secondaryField: string
): void => {
  if (typeof value === "string") {
    out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectText(item, out, primaryField, secondaryField);
    }
    return;
  }
  if (!value || typeof value !== "object") {
    return;
  }
  const record = asRecord(value);
  const direct =
    asString(record[primaryField]) ?? asString(record[secondaryField]);
  if (direct !== undefined) {
    out.push(direct);
  }
  collectText(record.content, out, primaryField, secondaryField);
  collectText(record.item, out, primaryField, secondaryField);
  collectText(record.payload, out, primaryField, secondaryField);
};

const parseDeltaText = (value: unknown): string => {
  const parts: string[] = [];
  collectText(value, parts, "delta", "text");
  return parts.join("");
};

const parseCompletedMessage = (value: unknown): string => {
  const parts: string[] = [];
  collectText(value, parts, "text", "delta");
  // Keep completed-message concatenation aligned with delta concatenation.
  return parts.join("");
};

const parseItemId = (value: unknown): string => {
  const record = asRecord(value);
  return (
    asString(record.itemId) ??
    asString(record.item_id) ??
    asString(record.id) ??
    asString(asRecord(record.item).id) ??
    ""
  );
};

const appendChunk = (
  state: CodexRenderState,
  format: Format,
  write: (text: string) => void,
  text: string
): void => {
  if (!text) {
    return;
  }
  const needsMessageBreak =
    state.pendingMessageBreak &&
    state.parsed &&
    !state.parsed.endsWith("\n") &&
    !text.startsWith("\n");
  const parsedChunk = needsMessageBreak ? `\n${text}` : text;
  const prettyChunk = needsMessageBreak ? `\n\n${text}` : text;
  state.pendingMessageBreak = false;
  state.parsed += parsedChunk;
  if (format === "pretty") {
    write(prettyChunk);
    state.wrotePretty = true;
  }
};

const markMessageBoundary = (state: CodexRenderState): void => {
  state.pendingMessageBreak = true;
  state.activeItemHasDelta = false;
  state.activeItemId = "";
};

const handleDeltaLine = (
  params: Record<string, unknown>,
  state: CodexRenderState,
  format: Format,
  write: (text: string) => void
): void => {
  const itemId = parseItemId(params);
  const itemChanged =
    Boolean(state.activeItemId) &&
    Boolean(itemId) &&
    itemId !== state.activeItemId;
  if (itemChanged) {
    markMessageBoundary(state);
  }
  if (itemId) {
    state.activeItemId = itemId;
  }
  const chunk = parseDeltaText(params.delta ?? params);
  if (!chunk) {
    return;
  }
  state.activeItemHasDelta = true;
  appendChunk(state, format, write, chunk);
};

const handleCompletedLine = (
  params: Record<string, unknown>,
  state: CodexRenderState,
  format: Format,
  write: (text: string) => void
): void => {
  const item = asRecord(params.item);
  const itemType = asString(item.type);
  if (itemType !== "agentMessage" && itemType !== "agent_message") {
    return;
  }
  const completedId = parseItemId(params);
  const sameActive =
    Boolean(completedId) &&
    Boolean(state.activeItemId) &&
    completedId === state.activeItemId;
  const candidate = parseCompletedMessage(item).trim();
  if (
    candidate &&
    candidate !== state.lastCompleted &&
    !(sameActive && state.activeItemHasDelta)
  ) {
    state.lastCompleted = candidate;
    appendChunk(state, format, write, candidate);
  }
  // Skip boundary when this completed event matches the item already streamed
  // via deltas. The delta handler detects item changes and sets boundaries when
  // a genuinely new item arrives, preventing spurious line breaks mid-stream.
  if (!(sameActive && state.activeItemHasDelta)) {
    markMessageBoundary(state);
  }
};

export const createCodexRenderer = (
  config: CodexRendererConfig
): CodexRenderer => {
  const state: CodexRenderState = {
    activeItemHasDelta: false,
    activeItemId: "",
    lastCompleted: "",
    parsed: "",
    pendingMessageBreak: false,
    wrotePretty: false,
  };

  const onRawLine = (text: string): void => {
    if (config.format === "raw") {
      config.write(`${text}\n`);
    }

    const parsedLine = parseJsonLine(text) as AppServerEvent | undefined;
    if (!parsedLine) {
      return;
    }
    const method = asString(parsedLine.method);
    const params = asRecord(parsedLine.params);

    if (method === "item/agentMessage/delta") {
      handleDeltaLine(params, state, config.format, config.write);
      return;
    }

    if (method === "item/completed") {
      handleCompletedLine(params, state, config.format, config.write);
    }
  };

  return {
    getParsed: () => state.parsed,
    onRawLine,
    wrotePretty: () => state.wrotePretty,
  };
};
