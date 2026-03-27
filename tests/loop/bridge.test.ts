import { afterEach, expect, mock, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readRunManifest } from "../../src/loop/run-state";

const loadBridge = (
  overrides: {
    injectCodexMessage?: (...args: string[]) => Promise<boolean>;
  } = {}
) => {
  mock.restore();
  mock.module("../../src/loop/launch", () => ({
    buildLaunchArgv: mock(() => ["/opt/bun", "src/loop/main.ts"]),
  }));
  if (overrides.injectCodexMessage) {
    mock.module("../../src/loop/codex-app-server", () => ({
      injectCodexMessage: overrides.injectCodexMessage,
    }));
  }
  return import(`../../src/loop/bridge?test=${Date.now()}`);
};

const makeTempDir = (): string => mkdtempSync(join(tmpdir(), "loop-bridge-"));
const encodeFrame = (payload: unknown): string => {
  const body = JSON.stringify(payload);
  return `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`;
};
const encodeLine = (payload: unknown): string => `${JSON.stringify(payload)}\n`;

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

test("bridge MCP send_to_agent normalizes target case and whitespace", async () => {
  const bridge = await loadBridge();
  const root = makeTempDir();
  const runDir = join(root, "run");
  mkdirSync(runDir, { recursive: true });

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
            target: "  CLAUDE  ",
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
      source: "codex",
      target: "claude",
    }),
  ]);
  rmSync(root, { recursive: true, force: true });
});

test("bridge MCP send_to_agent rejects an empty target after trimming", async () => {
  const root = makeTempDir();
  const runDir = join(root, "run");
  mkdirSync(runDir, { recursive: true });

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
            target: "   ",
          },
          name: "send_to_agent",
        },
      }),
      "\n",
    ].join("")
  );

  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({
    error: {
      code: -32_602,
      message: "send_to_agent requires a non-empty target",
    },
    id: 1,
    jsonrpc: "2.0",
  });
  rmSync(root, { recursive: true, force: true });
});

test("bridge MCP send_to_agent rejects an unknown normalized target", async () => {
  const root = makeTempDir();
  const runDir = join(root, "run");
  mkdirSync(runDir, { recursive: true });

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
            target: "  FOO  ",
          },
          name: "send_to_agent",
        },
      }),
      "\n",
    ].join("")
  );

  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({
    error: {
      code: -32_602,
      message: 'Unknown target "foo" - expected "claude" or "codex"',
    },
    id: 1,
    jsonrpc: "2.0",
  });
  rmSync(root, { recursive: true, force: true });
});

test("bridge MCP handles standard empty-list and ping requests through the CLI path", async () => {
  const root = makeTempDir();
  const runDir = join(root, "run");
  mkdirSync(runDir, { recursive: true });

  const result = await runBridgeProcess(
    runDir,
    "claude",
    [
      encodeLine({
        id: 1,
        jsonrpc: "2.0",
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
        },
      }),
      encodeLine({
        id: 2,
        jsonrpc: "2.0",
        method: "ping",
        params: {},
      }),
      encodeLine({
        id: 3,
        jsonrpc: "2.0",
        method: "prompts/list",
        params: {},
      }),
      encodeLine({
        id: 4,
        jsonrpc: "2.0",
        method: "resources/list",
        params: {},
      }),
      encodeLine({
        id: 5,
        jsonrpc: "2.0",
        method: "resources/templates/list",
        params: {},
      }),
      encodeLine({
        id: 6,
        jsonrpc: "2.0",
        method: "tools/list",
        params: {},
      }),
    ].join("")
  );

  expect(result.code).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout).toContain('"claude/channel":{}');
  expect(result.stdout).toContain(
    '\\"reply\\" tool and pass back the same chat_id'
  );
  expect(result.stdout).toContain(
    "Never answer the human when the inbound message came from Codex"
  );
  expect(result.stdout).toContain('"id":2');
  expect(result.stdout).toContain('"result":{}');
  expect(result.stdout).toContain('"id":3');
  expect(result.stdout).toContain('"prompts":[]');
  expect(result.stdout).toContain('"id":4');
  expect(result.stdout).toContain('"resources":[]');
  expect(result.stdout).toContain('"id":5');
  expect(result.stdout).toContain('"resourceTemplates":[]');
  expect(result.stdout).toContain('"id":6');
  expect(result.stdout).toContain('"name":"reply"');
  expect(result.stdout).toContain('"name":"send_to_agent"');
  expect(result.stdout).toContain('"name":"receive_messages"');
  rmSync(root, { recursive: true, force: true });
});

test("bridge MCP writes line-delimited JSON responses", async () => {
  const root = makeTempDir();
  const runDir = join(root, "run");
  mkdirSync(runDir, { recursive: true });

  const result = await runBridgeProcess(
    runDir,
    "claude",
    encodeLine({
      id: 1,
      jsonrpc: "2.0",
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
      },
    })
  );

  expect(result.code).toBe(0);
  expect(result.stderr).toBe("");
  const line = result.stdout.trim();
  expect(line.startsWith("{")).toBe(true);
  expect(JSON.parse(line)).toMatchObject({
    id: 1,
    jsonrpc: "2.0",
    result: expect.objectContaining({
      capabilities: expect.any(Object),
      protocolVersion: "2024-11-05",
    }),
  });

  rmSync(root, { recursive: true, force: true });
});

test("bridge MCP receive_messages returns and clears queued inbox items", async () => {
  const bridge = await loadBridge();
  const root = makeTempDir();
  const runDir = join(root, "run");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    bridge.bridgeInternals.bridgePath(runDir),
    `${JSON.stringify({
      at: "2026-03-23T10:00:00.000Z",
      id: "msg-1",
      kind: "message",
      message: "Please review the final result.",
      source: "claude",
      target: "codex",
    })}\n`,
    "utf8"
  );

  const result = await runBridgeProcess(
    runDir,
    "codex",
    encodeLine({
      id: 1,
      jsonrpc: "2.0",
      method: "tools/call",
      params: {
        arguments: {},
        name: "receive_messages",
      },
    })
  );

  expect(result.code).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout).toContain("Please review the final result.");
  expect(result.stdout).toContain('\\"from\\": \\"claude\\"');
  expect(bridge.readPendingBridgeMessages(runDir)).toEqual([]);
  expect(
    bridge.bridgeInternals
      .readBridgeEvents(runDir)
      .filter((event) => event.kind === "delivered")
  ).toHaveLength(1);

  rmSync(root, { recursive: true, force: true });
});

test("bridge delivers Claude replies directly to Codex when app-server state is available", async () => {
  const injectCodexMessage = mock(async () => true);
  const bridge = await loadBridge({ injectCodexMessage });
  const root = makeTempDir();
  const runDir = join(root, "run");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, "manifest.json"),
    `${JSON.stringify({
      codexRemoteUrl: "ws://127.0.0.1:4500",
      codexThreadId: "codex-thread-1",
      createdAt: "2026-03-23T10:00:00.000Z",
      cwd: "/repo",
      mode: "paired",
      pid: 1234,
      repoId: "repo-123",
      runId: "7",
      status: "running",
      updatedAt: "2026-03-23T10:00:00.000Z",
    })}\n`,
    "utf8"
  );
  const message = {
    at: "2026-03-23T10:01:00.000Z",
    id: "msg-1",
    kind: "message" as const,
    message: "The files look good to me.",
    source: "claude" as const,
    target: "codex" as const,
  };

  bridge.bridgeInternals.appendBridgeEvent(runDir, message);
  const delivered = await bridge.bridgeInternals.deliverCodexBridgeMessage(
    runDir,
    message
  );

  expect(delivered).toBe(true);
  expect(injectCodexMessage).toHaveBeenCalledWith(
    "ws://127.0.0.1:4500",
    "codex-thread-1",
    "The files look good to me."
  );
  expect(bridge.readPendingBridgeMessages(runDir)).toEqual([]);
  expect(
    bridge.bridgeInternals
      .readBridgeEvents(runDir)
      .filter((event) => event.kind === "delivered")
  ).toHaveLength(1);

  rmSync(root, { recursive: true, force: true });
});

test("bridge falls back to direct Codex delivery when the stored tmux session is stale", async () => {
  const injectCodexMessage = mock(async () => true);
  const spawnSync = mock((args: string[]) => {
    if (args[0] === "tmux" && args[1] === "has-session") {
      return { exitCode: 1 };
    }
    if (args[0] === "claude" && args[1] === "mcp" && args[2] === "remove") {
      return { exitCode: 0 };
    }
    return { exitCode: 0 };
  });
  const bridge = await loadBridge({ injectCodexMessage });
  bridge.bridgeInternals.commandDeps.spawnSync = spawnSync;
  const root = makeTempDir();
  const runDir = join(root, "run");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, "manifest.json"),
    `${JSON.stringify({
      codexRemoteUrl: "ws://127.0.0.1:4500",
      codexThreadId: "codex-thread-1",
      createdAt: "2026-03-23T10:00:00.000Z",
      cwd: "/repo",
      mode: "paired",
      pid: 1234,
      repoId: "repo-123",
      runId: "8",
      status: "running",
      tmuxSession: "repo-loop-8",
      updatedAt: "2026-03-23T10:00:00.000Z",
    })}\n`,
    "utf8"
  );
  const message = {
    at: "2026-03-23T10:01:00.000Z",
    id: "msg-2",
    kind: "message" as const,
    message: "Please review the final state.",
    source: "claude" as const,
    target: "codex" as const,
  };

  bridge.bridgeInternals.appendBridgeEvent(runDir, message);
  const delivered = await bridge.bridgeInternals.deliverCodexBridgeMessage(
    runDir,
    message
  );

  expect(delivered).toBe(true);
  expect(injectCodexMessage).toHaveBeenCalledWith(
    "ws://127.0.0.1:4500",
    "codex-thread-1",
    "Please review the final state."
  );
  expect(readRunManifest(join(runDir, "manifest.json"))?.tmuxSession).toBe(
    undefined
  );
  const removeCall = spawnSync.mock.calls.find(
    (call) => call[0]?.[0] === "claude" && call[0]?.[2] === "remove"
  );
  expect(removeCall).toBeDefined();
  expect(removeCall?.[0]).toEqual([
    "claude",
    "mcp",
    "remove",
    "--scope",
    "local",
    bridge.bridgeInternals.claudeChannelServerName("8"),
  ]);
  expect(removeCall?.[1]).toMatchObject({
    stderr: "pipe",
    stdout: "ignore",
  });
  expect(bridge.readPendingBridgeMessages(runDir)).toEqual([]);

  rmSync(root, { recursive: true, force: true });
});

test("bridge stale tmux cleanup is a no-op when the manifest has no tmux session", async () => {
  const spawnSync = mock(() => ({ exitCode: 0 }));
  const bridge = await loadBridge();
  bridge.bridgeInternals.commandDeps.spawnSync = spawnSync;
  const root = makeTempDir();
  const runDir = join(root, "run");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, "manifest.json"),
    `${JSON.stringify({
      codexRemoteUrl: "ws://127.0.0.1:4500",
      codexThreadId: "codex-thread-1",
      createdAt: "2026-03-23T10:00:00.000Z",
      cwd: "/repo",
      mode: "paired",
      pid: 1234,
      repoId: "repo-123",
      runId: "8",
      status: "running",
      updatedAt: "2026-03-23T10:00:00.000Z",
    })}\n`,
    "utf8"
  );

  expect(bridge.bridgeInternals.clearStaleTmuxBridgeState(runDir)).toBe(false);
  expect(spawnSync).not.toHaveBeenCalled();
  expect(readRunManifest(join(runDir, "manifest.json"))?.tmuxSession).toBe(
    undefined
  );

  rmSync(root, { recursive: true, force: true });
});

test("bridge stale tmux cleanup logs non-zero Claude MCP remove exits", async () => {
  const spawnSync = mock((args: string[]) => {
    if (args[0] === "claude" && args[1] === "mcp" && args[2] === "remove") {
      return {
        exitCode: 1,
        stderr: Buffer.from("command failed", "utf8"),
      };
    }
    return { exitCode: 0, stderr: Buffer.alloc(0) };
  });
  const bridge = await loadBridge();
  bridge.bridgeInternals.commandDeps.spawnSync = spawnSync;
  const errorSpy = mock(() => undefined);
  const originalError = console.error;
  console.error = errorSpy;
  const root = makeTempDir();
  const runDir = join(root, "run");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, "manifest.json"),
    `${JSON.stringify({
      createdAt: "2026-03-23T10:00:00.000Z",
      cwd: "/repo",
      mode: "paired",
      pid: 1234,
      repoId: "repo-123",
      runId: "8",
      status: "running",
      tmuxSession: "repo-loop-8",
      updatedAt: "2026-03-23T10:00:00.000Z",
    })}\n`,
    "utf8"
  );

  try {
    expect(bridge.bridgeInternals.clearStaleTmuxBridgeState(runDir)).toBe(true);
    expect(errorSpy).toHaveBeenCalledWith(
      '[loop] failed to remove Claude channel server "loop-bridge-8": command failed'
    );
    expect(readRunManifest(join(runDir, "manifest.json"))?.tmuxSession).toBe(
      undefined
    );
  } finally {
    console.error = originalError;
    rmSync(root, { recursive: true, force: true });
  }
});

test("bridge stale tmux cleanup logs thrown Claude MCP remove errors", async () => {
  const spawnSync = mock((args: string[]) => {
    if (args[0] === "claude" && args[1] === "mcp" && args[2] === "remove") {
      throw new Error("spawn failed");
    }
    return { exitCode: 0, stderr: Buffer.alloc(0) };
  });
  const bridge = await loadBridge();
  bridge.bridgeInternals.commandDeps.spawnSync = spawnSync;
  const errorSpy = mock(() => undefined);
  const originalError = console.error;
  console.error = errorSpy;
  const root = makeTempDir();
  const runDir = join(root, "run");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, "manifest.json"),
    `${JSON.stringify({
      createdAt: "2026-03-23T10:00:00.000Z",
      cwd: "/repo",
      mode: "paired",
      pid: 1234,
      repoId: "repo-123",
      runId: "8",
      status: "running",
      tmuxSession: "repo-loop-8",
      updatedAt: "2026-03-23T10:00:00.000Z",
    })}\n`,
    "utf8"
  );

  try {
    expect(bridge.bridgeInternals.clearStaleTmuxBridgeState(runDir)).toBe(true);
    expect(errorSpy).toHaveBeenCalledWith(
      '[loop] failed to remove Claude channel server "loop-bridge-8": spawn failed'
    );
    expect(readRunManifest(join(runDir, "manifest.json"))?.tmuxSession).toBe(
      undefined
    );
  } finally {
    console.error = originalError;
    rmSync(root, { recursive: true, force: true });
  }
});

test("bridge MCP delivers pending codex messages to Claude as channel notifications", async () => {
  const bridge = await loadBridge();
  const root = makeTempDir();
  const runDir = join(root, "run");
  mkdirSync(runDir, { recursive: true });

  writeFileSync(
    bridge.bridgeInternals.bridgePath(runDir),
    `${JSON.stringify({
      at: "2026-03-23T10:00:00.000Z",
      id: "msg-1",
      kind: "message",
      message: "Please review the latest Codex output.",
      source: "codex",
      target: "claude",
    })}\n`,
    "utf8"
  );

  const result = await runBridgeProcess(
    runDir,
    "claude",
    [
      encodeLine({
        id: 1,
        jsonrpc: "2.0",
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
        },
      }),
      encodeLine({
        jsonrpc: "2.0",
        method: "notifications/initialized",
        params: {},
      }),
    ].join("")
  );

  expect(result.code).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout).toContain('"method":"notifications/claude/channel"');
  expect(result.stdout).toContain("Please review the latest Codex output.");
  expect(result.stdout).toContain('"user":"Codex"');
  expect(bridge.readPendingBridgeMessages(runDir)).toEqual([]);
  expect(
    bridge.bridgeInternals
      .readBridgeEvents(runDir)
      .filter((event) => event.kind === "delivered")
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
