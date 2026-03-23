import { afterEach, expect, mock, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const loadBridge = () => {
  mock.restore();
  mock.module("../../src/loop/launch", () => ({
    buildLaunchArgv: mock(() => ["/opt/bun", "src/loop/main.ts"]),
  }));
  return import("../../src/loop/bridge");
};

const makeTempDir = (): string => mkdtempSync(join(tmpdir(), "loop-bridge-"));
const encodeFrame = (payload: unknown): string => {
  const body = JSON.stringify(payload);
  return `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`;
};

const runBridgeProcess = async (
  runDir: string,
  source: "claude" | "codex",
  frames: string
): Promise<{ code: number | null; stderr: string; stdout: string }> => {
  const cli = join(process.cwd(), "src", "cli.ts");
  const child = spawn("bun", [cli, "__bridge-mcp", runDir, source], {
    cwd: process.cwd(),
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  child.stdin.end(frames);
  const code = await new Promise<number | null>((resolve) => {
    child.on("close", resolve);
  });
  return { code, stderr, stdout };
};

afterEach(() => {
  mock.restore();
});

test("bridge message parsing ignores malformed lines and acked entries", async () => {
  const bridge = await loadBridge();
  const root = makeTempDir();
  const runDir = join(root, "run");
  const bridgeFile = bridge.bridgeInternals.bridgePath(runDir);
  mkdirSync(runDir, { recursive: true });

  writeFileSync(
    bridgeFile,
    [
      "not-json",
      JSON.stringify({
        at: "2026-03-22T10:00:00.000Z",
        id: "msg-1",
        kind: "message",
        message: "hello codex",
        source: "claude",
        target: "codex",
      }),
      JSON.stringify({
        at: "2026-03-22T10:01:00.000Z",
        id: "msg-2",
        kind: "message",
        message: "hello claude",
        source: "codex",
        target: "claude",
      }),
      JSON.stringify({
        at: "2026-03-22T10:02:00.000Z",
        id: "msg-1",
        kind: "delivered",
        source: "claude",
        target: "codex",
      }),
      JSON.stringify({
        at: "2026-03-22T10:03:00.000Z",
        id: "msg-2",
        kind: "blocked",
        reason: "busy",
        source: "codex",
        target: "claude",
      }),
    ].join("\n"),
    "utf8"
  );

  expect(bridge.bridgeInternals.readBridgeEvents(runDir)).toHaveLength(4);
  expect(bridge.readPendingBridgeMessages(runDir)).toEqual([]);
  rmSync(root, { recursive: true, force: true });
});

test("markBridgeMessage records acknowledgements and clears pending entries", async () => {
  const bridge = await loadBridge();
  const root = makeTempDir();
  const runDir = join(root, "run");
  mkdirSync(runDir, { recursive: true });
  const bridgeFile = bridge.bridgeInternals.bridgePath(runDir);
  const message = {
    at: "2026-03-22T10:00:00.000Z",
    id: "msg-1",
    kind: "message" as const,
    message: "ship it",
    source: "claude" as const,
    target: "codex" as const,
  };

  writeFileSync(bridgeFile, `${JSON.stringify(message)}\n`, "utf8");
  expect(bridge.readPendingBridgeMessages(runDir)).toEqual([
    expect.objectContaining(message),
  ]);

  bridge.markBridgeMessage(runDir, message, "delivered", "sent");

  expect(bridge.readPendingBridgeMessages(runDir)).toEqual([]);
  expect(bridge.bridgeInternals.readBridgeEvents(runDir)).toEqual([
    expect.objectContaining(message),
    expect.objectContaining({
      id: "msg-1",
      kind: "delivered",
      reason: "sent",
      source: "claude",
      target: "codex",
    }),
  ]);

  rmSync(root, { recursive: true, force: true });
});

test("readPendingBridgeMessages keeps repeated messages until each is acknowledged", async () => {
  const bridge = await loadBridge();
  const root = makeTempDir();
  const runDir = join(root, "run");
  mkdirSync(runDir, { recursive: true });
  const bridgeFile = bridge.bridgeInternals.bridgePath(runDir);

  writeFileSync(
    bridgeFile,
    `${[
      {
        at: "2026-03-22T10:00:00.000Z",
        id: "msg-1",
        kind: "message",
        message: "same",
        source: "claude",
        target: "codex",
      },
      {
        at: "2026-03-22T10:01:00.000Z",
        id: "msg-2",
        kind: "message",
        message: "same",
        source: "claude",
        target: "codex",
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n")}\n`,
    "utf8"
  );

  expect(bridge.readPendingBridgeMessages(runDir)).toHaveLength(2);
  expect(bridge.readPendingBridgeMessages(runDir)).toEqual([
    expect.objectContaining({ id: "msg-1", message: "same" }),
    expect.objectContaining({ id: "msg-2", message: "same" }),
  ]);

  bridge.markBridgeMessage(
    runDir,
    {
      at: "2026-03-22T10:00:00.000Z",
      id: "msg-1",
      kind: "message",
      message: "same",
      source: "claude",
      target: "codex",
    },
    "delivered",
    "sent"
  );

  expect(bridge.readPendingBridgeMessages(runDir)).toEqual([
    expect.objectContaining({ id: "msg-2", message: "same" }),
  ]);

  rmSync(root, { recursive: true, force: true });
});

test("bridge MCP send_to_agent queues a direct message through the CLI path", async () => {
  const bridge = await loadBridge();
  const root = makeTempDir();
  const runDir = join(root, "run");
  mkdirSync(runDir, { recursive: true });

  const result = await runBridgeProcess(
    runDir,
    "claude",
    [
      encodeFrame({
        id: 1,
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          arguments: {
            message: "ship it",
            target: "codex",
          },
          name: "send_to_agent",
        },
      }),
      "\n",
    ].join("")
  );

  expect(result.code).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout).toContain("queued");
  expect(bridge.readPendingBridgeMessages(runDir)).toEqual([
    expect.objectContaining({
      message: "ship it",
      source: "claude",
      target: "codex",
    }),
  ]);
  expect(
    bridge.bridgeInternals
      .readBridgeEvents(runDir)
      .filter((event) => event.kind === "message")
  ).toHaveLength(1);
  rmSync(root, { recursive: true, force: true });
});

test("bridge MCP blocks an immediate bounce from the paired agent", async () => {
  const bridge = await loadBridge();
  const root = makeTempDir();
  const runDir = join(root, "run");
  mkdirSync(runDir, { recursive: true });

  writeFileSync(
    bridge.bridgeInternals.bridgePath(runDir),
    `${[
      {
        at: "2026-03-22T10:00:00.000Z",
        id: "msg-1",
        kind: "message",
        message: "ship it",
        source: "claude",
        target: "codex",
      },
      {
        at: "2026-03-22T10:00:01.000Z",
        id: "msg-1",
        kind: "delivered",
        source: "claude",
        target: "codex",
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n")}\n`,
    "utf8"
  );

  const result = await runBridgeProcess(
    runDir,
    "codex",
    [
      encodeFrame({
        id: 1,
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          arguments: {
            message: "ship it",
            target: "claude",
          },
          name: "send_to_agent",
        },
      }),
      "\n",
    ].join("")
  );

  expect(result.code).toBe(0);
  expect(result.stdout).toContain("suppressed duplicate bridge message");
  expect(bridge.readPendingBridgeMessages(runDir)).toEqual([]);
  expect(
    bridge.bridgeInternals
      .readBridgeEvents(runDir)
      .filter((event) => event.kind === "message")
  ).toHaveLength(1);
  expect(
    bridge.bridgeInternals
      .readBridgeEvents(runDir)
      .filter((event) => event.kind === "delivered")
  ).toHaveLength(1);
  expect(
    bridge.bridgeInternals
      .readBridgeEvents(runDir)
      .filter((event) => event.kind === "blocked")
  ).toHaveLength(1);
  rmSync(root, { recursive: true, force: true });
});

test("bridge MCP allows the same message later after unrelated traffic", async () => {
  const bridge = await loadBridge();
  const root = makeTempDir();
  const runDir = join(root, "run");
  mkdirSync(runDir, { recursive: true });

  writeFileSync(
    bridge.bridgeInternals.bridgePath(runDir),
    `${[
      {
        at: "2026-03-22T10:00:00.000Z",
        id: "msg-1",
        kind: "message",
        message: "ship it",
        source: "claude",
        target: "codex",
      },
      {
        at: "2026-03-22T10:00:01.000Z",
        id: "msg-1",
        kind: "delivered",
        source: "claude",
        target: "codex",
      },
      {
        at: "2026-03-22T10:01:00.000Z",
        id: "msg-2",
        kind: "message",
        message: "other traffic",
        source: "codex",
        target: "claude",
      },
      {
        at: "2026-03-22T10:01:01.000Z",
        id: "msg-2",
        kind: "delivered",
        source: "codex",
        target: "claude",
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n")}\n`,
    "utf8"
  );

  const result = await runBridgeProcess(
    runDir,
    "codex",
    [
      encodeFrame({
        id: 1,
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          arguments: {
            message: "ship it",
            target: "claude",
          },
          name: "send_to_agent",
        },
      }),
      "\n",
    ].join("")
  );

  expect(result.code).toBe(0);
  expect(result.stdout).toContain("queued");
  expect(result.stdout).not.toContain("suppressed duplicate bridge message");
  expect(
    bridge.bridgeInternals
      .readBridgeEvents(runDir)
      .filter((event) => event.kind === "blocked")
  ).toHaveLength(0);
  expect(
    bridge.bridgeInternals
      .readBridgeEvents(runDir)
      .filter((event) => event.kind === "message")
  ).toHaveLength(3);
  rmSync(root, { recursive: true, force: true });
});

test("bridge MCP allows repeating the same message in the original direction", async () => {
  const bridge = await loadBridge();
  const root = makeTempDir();
  const runDir = join(root, "run");
  mkdirSync(runDir, { recursive: true });

  writeFileSync(
    bridge.bridgeInternals.bridgePath(runDir),
    `${[
      {
        at: "2026-03-22T10:00:00.000Z",
        id: "msg-1",
        kind: "message",
        message: "ship it",
        source: "claude",
        target: "codex",
      },
      {
        at: "2026-03-22T10:00:01.000Z",
        id: "msg-1",
        kind: "delivered",
        source: "claude",
        target: "codex",
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n")}\n`,
    "utf8"
  );

  const result = await runBridgeProcess(
    runDir,
    "claude",
    [
      encodeFrame({
        id: 1,
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          arguments: {
            message: "ship it",
            target: "codex",
          },
          name: "send_to_agent",
        },
      }),
      "\n",
    ].join("")
  );

  expect(result.code).toBe(0);
  expect(result.stdout).toContain("queued");
  expect(bridge.readPendingBridgeMessages(runDir)).toEqual([
    expect.objectContaining({
      message: "ship it",
      source: "claude",
      target: "codex",
    }),
  ]);
  expect(
    bridge.bridgeInternals
      .readBridgeEvents(runDir)
      .filter((event) => event.kind === "message")
  ).toHaveLength(2);
  expect(
    bridge.bridgeInternals
      .readBridgeEvents(runDir)
      .filter((event) => event.kind === "blocked")
  ).toHaveLength(0);
  rmSync(root, { recursive: true, force: true });
});

test("bridge config helper builds the bridge MCP entry point for Codex", async () => {
  const bridge = await loadBridge();
  const root = makeTempDir();
  const runDir = join(root, "run");

  const codexArgs = bridge.buildCodexBridgeConfigArgs(runDir, "codex");
  expect(codexArgs).toEqual([
    "-c",
    'mcp_servers.loop-bridge.command="/opt/bun"',
    "-c",
    `mcp_servers.loop-bridge.args=${JSON.stringify([
      "src/loop/main.ts",
      bridge.BRIDGE_SUBCOMMAND,
      runDir,
      "codex",
    ])}`,
  ]);

  rmSync(root, { recursive: true, force: true });
});
