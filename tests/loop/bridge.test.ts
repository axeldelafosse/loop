import { afterEach, expect, mock, test } from "bun:test";
import { spawn } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
  const nonce = Date.now();
  return Promise.all([
    import(`../../src/loop/bridge?test=${nonce}`),
    import(`../../src/loop/bridge-claude-registration?test=${nonce}`),
    import(`../../src/loop/bridge-dispatch?test=${nonce}`),
    import(`../../src/loop/bridge-config?test=${nonce}`),
    import(`../../src/loop/bridge-constants?test=${nonce}`),
    import(`../../src/loop/bridge-runtime?test=${nonce}`),
    import(`../../src/loop/bridge-store?test=${nonce}`),
  ]).then(
    ([bridge, registration, dispatch, config, constants, runtime, store]) => ({
      ...bridge,
      ...registration,
      ...dispatch,
      ...config,
      ...constants,
      ...runtime,
      ...store,
    })
  );
};

const makeTempDir = (): string => mkdtempSync(join(tmpdir(), "loop-bridge-"));
const encodeFrame = (payload: unknown): string => {
  const body = JSON.stringify(payload);
  return `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`;
};
const encodeLine = (payload: unknown): string => `${JSON.stringify(payload)}\n`;
const parseJsonLines = (text: string): Record<string, unknown>[] =>
  text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
const listedTools = (stdout: string): Record<string, unknown>[] => {
  const toolsResponse = parseJsonLines(stdout).find(
    (response) => response.id === 6
  );
  return (
    (toolsResponse?.result as { tools?: Record<string, unknown>[] } | undefined)
      ?.tools ?? []
  );
};
const toolText = (stdout: string, id: number): string => {
  const response = parseJsonLines(stdout).find((entry) => entry.id === id);
  const content = (
    response?.result as { content?: Array<{ text?: string }> } | undefined
  )?.content;
  return content?.[0]?.text ?? "";
};

const runBridgeProcess = async (
  runDir: string,
  source: "claude" | "codex",
  frames: string,
  env?: NodeJS.ProcessEnv
): Promise<{ code: number | null; stderr: string; stdout: string }> => {
  const cli = join(process.cwd(), "src", "cli.ts");
  const child = spawn(process.execPath, [cli, "__bridge-mcp", runDir, source], {
    cwd: process.cwd(),
    env,
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

const startLiveBridgeProcess = (
  runDir: string,
  source: "claude" | "codex",
  env?: NodeJS.ProcessEnv
): {
  close: () => Promise<{ code: number | null; stderr: string; stdout: string }>;
  write: (frame: string) => void;
  waitForStdout: (pattern: string, timeoutMs?: number) => Promise<void>;
} => {
  const cli = join(process.cwd(), "src", "cli.ts");
  const child = spawn(process.execPath, [cli, "__bridge-mcp", runDir, source], {
    cwd: process.cwd(),
    env,
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

  return {
    close: async () => {
      child.stdin.end();
      const code = await new Promise<number | null>((resolve) => {
        child.on("close", resolve);
      });
      return { code, stderr, stdout };
    },
    write: (frame) => {
      child.stdin.write(frame);
    },
    waitForStdout: async (pattern, timeoutMs = 5000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (stdout.includes(pattern)) {
          return;
        }
        await new Promise((resolve) => {
          setTimeout(resolve, 25);
        });
      }
      throw new Error(`timed out waiting for stdout to contain: ${pattern}`);
    },
  };
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

test("readBridgeStatus derives bridge naming and transport fields", async () => {
  const bridge = await loadBridge();
  const root = makeTempDir();
  const runDir = join(root, "run");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, "manifest.json"),
    `${JSON.stringify({
      claudeSessionId: "claude-session-1",
      codexRemoteUrl: "ws://127.0.0.1:4500",
      codexThreadId: "codex-thread-1",
      createdAt: "2026-03-27T10:00:00.000Z",
      cwd: "/repo",
      mode: "paired",
      pid: 1234,
      repoId: "repo-123",
      runId: "7",
      state: "submitted",
      status: "running",
      updatedAt: "2026-03-27T10:00:00.000Z",
    })}\n`,
    "utf8"
  );

  expect(bridge.readBridgeStatus(runDir)).toMatchObject({
    bridgeServer: bridge.BRIDGE_SERVER,
    claudeBridgeMode: "mcp-config",
    claudeChannelServer: bridge.claudeChannelServerName("7", "repo-123"),
    claudeSessionId: "claude-session-1",
    codexRemoteUrl: "ws://127.0.0.1:4500",
    codexThreadId: "codex-thread-1",
    hasCodexRemote: true,
    hasTmuxSession: false,
    pending: { claude: 0, codex: 0 },
    runId: "7",
    state: "submitted",
    status: "running",
    tmuxSession: "",
  });

  rmSync(root, { recursive: true, force: true });
});

test("readBridgeRuntimeStatus distinguishes live and stale tmux delivery", async () => {
  const spawnSync = mock((args: string[]) => {
    if (args[0] === "tmux" && args[1] === "has-session") {
      const session = args[3];
      return {
        exitCode: session === "repo-loop-live" ? 0 : 1,
        stderr: Buffer.alloc(0),
        stdout: Buffer.alloc(0),
      };
    }
    return { exitCode: 0, stderr: Buffer.alloc(0), stdout: Buffer.alloc(0) };
  });
  const bridge = await loadBridge();
  bridge.bridgeRuntimeCommandDeps.spawnSync = spawnSync;
  const root = makeTempDir();
  const liveRunDir = join(root, "live");
  const staleRunDir = join(root, "stale");
  mkdirSync(liveRunDir, { recursive: true });
  mkdirSync(staleRunDir, { recursive: true });

  writeFileSync(
    join(liveRunDir, "manifest.json"),
    `${JSON.stringify({
      codexRemoteUrl: "ws://127.0.0.1:4500",
      codexThreadId: "codex-thread-live",
      createdAt: "2026-03-27T10:00:00.000Z",
      cwd: "/repo",
      mode: "paired",
      pid: 1234,
      repoId: "repo-123",
      runId: "8",
      state: "running",
      status: "running",
      tmuxSession: "repo-loop-live",
      updatedAt: "2026-03-27T10:00:00.000Z",
    })}\n`,
    "utf8"
  );
  writeFileSync(
    join(staleRunDir, "manifest.json"),
    `${JSON.stringify({
      codexRemoteUrl: "ws://127.0.0.1:4500",
      codexThreadId: "codex-thread-stale",
      createdAt: "2026-03-27T10:00:00.000Z",
      cwd: "/repo",
      mode: "paired",
      pid: 1234,
      repoId: "repo-123",
      runId: "9",
      state: "running",
      status: "running",
      tmuxSession: "repo-loop-stale",
      updatedAt: "2026-03-27T10:00:00.000Z",
    })}\n`,
    "utf8"
  );

  expect(bridge.readBridgeRuntimeStatus(liveRunDir)).toMatchObject({
    claudeBridgeMode: "local-registration",
    claudeChannelServer: bridge.claudeChannelServerName("8", "repo-123"),
    codexDeliveryMode: "app-server",
    hasCodexRemote: true,
    hasLiveTmuxSession: true,
    hasTmuxSession: true,
  });
  expect(bridge.readBridgeRuntimeStatus(staleRunDir)).toMatchObject({
    claudeBridgeMode: "local-registration",
    claudeChannelServer: bridge.claudeChannelServerName("9", "repo-123"),
    codexDeliveryMode: "app-server",
    hasCodexRemote: true,
    hasLiveTmuxSession: false,
    hasTmuxSession: true,
  });

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

test("bridge normalization treats short and legacy Claude prefixes as equivalent", async () => {
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
        message:
          "Message from Claude via the loop bridge:\n\nPlease verify the final diff.",
        source: "claude",
        target: "codex",
      },
      {
        at: "2026-03-22T10:01:00.000Z",
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

  expect(
    bridge.blocksBridgeBounce(
      runDir,
      "codex",
      "claude",
      "Claude: Please verify the final diff."
    )
  ).toBe(true);
  rmSync(root, { recursive: true, force: true });
});

test("bridge MCP send_message queues a direct message through the CLI path", async () => {
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
          name: "send_message",
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

test("bridge MCP send_message normalizes target case and whitespace", async () => {
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
          name: "send_message",
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

test("bridge MCP send_message rejects an empty target after trimming", async () => {
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
          name: "send_message",
        },
      }),
      "\n",
    ].join("")
  );

  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({
    error: {
      code: -32_602,
      message: "send_message requires a non-empty target",
    },
    id: 1,
    jsonrpc: "2.0",
  });
  rmSync(root, { recursive: true, force: true });
});

test("bridge MCP send_message rejects an unknown normalized target", async () => {
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
          name: "send_message",
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

test("bridge MCP send_message rejects targeting the current agent", async () => {
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
            target: "claude",
          },
          name: "send_message",
        },
      }),
      "\n",
    ].join("")
  );

  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({
    error: {
      code: -32_602,
      message: "send_message cannot target the current agent",
    },
    id: 1,
    jsonrpc: "2.0",
  });
  rmSync(root, { recursive: true, force: true });
});

test("bridge MCP rejects the old send_to_agent name with rename guidance", async () => {
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
  expect(JSON.parse(result.stdout)).toMatchObject({
    error: {
      code: -32_602,
      message: 'Unknown tool: send_to_agent. Use "send_message" instead.',
    },
    id: 1,
    jsonrpc: "2.0",
  });
  rmSync(root, { recursive: true, force: true });
});

test("bridge MCP handles standard empty-list and ping requests through the Claude CLI path", async () => {
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
    '\\"send_message\\" with target: \\"codex\\" for Codex-facing messages'
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
  const tools = listedTools(result.stdout);
  expect(tools).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        annotations: {
          destructiveHint: false,
          openWorldHint: false,
          readOnlyHint: false,
        },
        name: "send_message",
      }),
      expect.objectContaining({
        annotations: {
          destructiveHint: false,
          openWorldHint: false,
          readOnlyHint: true,
        },
        name: "bridge_status",
      }),
      expect.objectContaining({
        annotations: {
          destructiveHint: true,
          openWorldHint: false,
          readOnlyHint: false,
        },
        name: "receive_messages",
      }),
    ])
  );
  expect(tools).toHaveLength(3);
  expect(tools.some((tool) => tool.name === "reply")).toBe(false);
  rmSync(root, { recursive: true, force: true });
});

test("bridge MCP advertises only the Codex-visible bridge tools", async () => {
  const root = makeTempDir();
  const runDir = join(root, "run");
  mkdirSync(runDir, { recursive: true });

  const result = await runBridgeProcess(
    runDir,
    "codex",
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
        id: 6,
        jsonrpc: "2.0",
        method: "tools/list",
        params: {},
      }),
    ].join("")
  );

  expect(result.code).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout).not.toContain('"claude/channel":{}');
  const tools = listedTools(result.stdout);
  expect(tools).toHaveLength(3);
  expect(tools).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        annotations: {
          destructiveHint: false,
          openWorldHint: false,
          readOnlyHint: false,
        },
        name: "send_message",
      }),
      expect.objectContaining({
        annotations: {
          destructiveHint: false,
          openWorldHint: false,
          readOnlyHint: true,
        },
        name: "bridge_status",
      }),
      expect.objectContaining({
        annotations: {
          destructiveHint: true,
          openWorldHint: false,
          readOnlyHint: false,
        },
        name: "receive_messages",
      }),
    ])
  );
  expect(tools.some((tool) => tool.name === "reply")).toBe(false);
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

test("bridge runtime status reports app-server-backed config-file delivery", async () => {
  const bridge = await loadBridge();
  const root = makeTempDir();
  const runDir = join(root, "run");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, "manifest.json"),
    `${JSON.stringify({
      claudeSessionId: "claude-session-1",
      codexRemoteUrl: "ws://127.0.0.1:4500",
      codexThreadId: "codex-thread-1",
      createdAt: "2026-03-23T10:00:00.000Z",
      cwd: "/repo",
      mode: "paired",
      pid: 1234,
      repoId: "repo-123",
      runId: "7",
      state: "submitted",
      status: "running",
      updatedAt: "2026-03-23T10:00:00.000Z",
    })}\n`,
    "utf8"
  );

  expect(bridge.readBridgeRuntimeStatus(runDir)).toMatchObject({
    claudeBridgeMode: "mcp-config",
    claudeChannelServer: bridge.claudeChannelServerName("7", "repo-123"),
    codexDeliveryMode: "app-server",
    hasCodexRemote: true,
    hasLiveTmuxSession: false,
  });

  rmSync(root, { recursive: true, force: true });
});

test("bridge runtime status reports live tmux delivery with a run-scoped Claude server", async () => {
  const spawnSync = mock((args: string[]) => {
    if (args[0] === "tmux" && args[1] === "has-session") {
      return { exitCode: 0, stderr: Buffer.alloc(0), stdout: Buffer.alloc(0) };
    }
    return { exitCode: 1, stderr: Buffer.alloc(0), stdout: Buffer.alloc(0) };
  });
  const bridge = await loadBridge();
  bridge.bridgeRuntimeCommandDeps.spawnSync = spawnSync;
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
      state: "submitted",
      status: "running",
      tmuxSession: "repo-loop-8",
      updatedAt: "2026-03-23T10:00:00.000Z",
    })}\n`,
    "utf8"
  );

  expect(bridge.readBridgeRuntimeStatus(runDir)).toMatchObject({
    claudeBridgeMode: "local-registration",
    claudeChannelServer: "loop-bridge-repo-123-8",
    codexDeliveryMode: "tmux",
    hasCodexRemote: false,
    hasLiveTmuxSession: true,
  });

  rmSync(root, { recursive: true, force: true });
});

test("bridge MCP bridge_status includes runtime delivery fields", async () => {
  const root = makeTempDir();
  const runDir = join(root, "run");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, "manifest.json"),
    `${JSON.stringify({
      claudeSessionId: "claude-session-1",
      codexRemoteUrl: "ws://127.0.0.1:4500",
      codexThreadId: "codex-thread-1",
      createdAt: "2026-03-23T10:00:00.000Z",
      cwd: "/repo",
      mode: "paired",
      pid: 1234,
      repoId: "repo-123",
      runId: "7",
      state: "submitted",
      status: "running",
      updatedAt: "2026-03-23T10:00:00.000Z",
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
        name: "bridge_status",
      },
    })
  );

  expect(result.code).toBe(0);
  expect(result.stderr).toBe("");
  const status = toolText(result.stdout, 1);
  expect(status).toContain('"claudeBridgeMode": "mcp-config"');
  expect(status).toContain('"claudeChannelServer": "loop-bridge-repo-123-7"');
  expect(status).toContain('"codexDeliveryMode": "app-server"');
  expect(status).toContain('"hasCodexRemote": true');
  expect(status).toContain('"hasLiveTmuxSession": false');

  rmSync(root, { recursive: true, force: true });
});

test("bridge MCP bridge_status tolerates a missing tmux binary", async () => {
  const root = makeTempDir();
  const runDir = join(root, "run");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, "manifest.json"),
    `${JSON.stringify({
      claudeSessionId: "claude-session-1",
      codexRemoteUrl: "ws://127.0.0.1:4500",
      codexThreadId: "codex-thread-1",
      createdAt: "2026-03-23T10:00:00.000Z",
      cwd: "/repo",
      mode: "paired",
      pid: 1234,
      repoId: "repo-123",
      runId: "7",
      state: "submitted",
      status: "running",
      tmuxSession: "repo-loop-7",
      updatedAt: "2026-03-23T10:00:00.000Z",
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
        name: "bridge_status",
      },
    }),
    { ...process.env, PATH: "/definitely-missing" }
  );

  expect(result.code).toBe(0);
  expect(result.stderr).toBe("");
  const status = toolText(result.stdout, 1);
  expect(status).toContain('"claudeChannelServer": "loop-bridge-repo-123-7"');
  expect(status).toContain('"codexDeliveryMode": "app-server"');
  expect(status).toContain('"hasLiveTmuxSession": false');
  expect(status).toContain('"hasTmuxSession": true');

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
  const delivered = await bridge.deliverCodexBridgeMessage(runDir, message);

  expect(delivered).toBe(true);
  expect(injectCodexMessage).toHaveBeenCalledWith(
    "ws://127.0.0.1:4500",
    "codex-thread-1",
    "Claude: The files look good to me."
  );
  expect(bridge.readPendingBridgeMessages(runDir)).toEqual([]);
  expect(
    bridge.bridgeInternals
      .readBridgeEvents(runDir)
      .filter((event) => event.kind === "delivered")
  ).toHaveLength(1);

  rmSync(root, { recursive: true, force: true });
});

test("bridge prefers Codex app-server delivery even when tmux is live", async () => {
  const injectCodexMessage = mock(async () => true);
  const spawnSync = mock((args: string[]) => {
    if (args[0] === "tmux" && args[1] === "has-session") {
      return { exitCode: 0 };
    }
    return { exitCode: 1 };
  });
  const bridge = await loadBridge({ injectCodexMessage });
  bridge.bridgeRuntimeCommandDeps.spawnSync = spawnSync;
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
      tmuxSession: "repo-loop-7",
      updatedAt: "2026-03-23T10:00:00.000Z",
    })}\n`,
    "utf8"
  );
  const message = {
    at: "2026-03-23T10:01:00.000Z",
    id: "msg-live",
    kind: "message" as const,
    message: "Please steer this into the active turn.",
    source: "claude" as const,
    target: "codex" as const,
  };

  bridge.bridgeInternals.appendBridgeEvent(runDir, message);
  const delivered = await bridge.deliverCodexBridgeMessage(runDir, message);

  expect(delivered).toBe(true);
  expect(injectCodexMessage).toHaveBeenCalledWith(
    "ws://127.0.0.1:4500",
    "codex-thread-1",
    "Claude: Please steer this into the active turn."
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
  bridge.bridgeRuntimeCommandDeps.spawnSync = spawnSync;
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
  const delivered = await bridge.deliverCodexBridgeMessage(runDir, message);

  expect(delivered).toBe(true);
  expect(injectCodexMessage).toHaveBeenCalledWith(
    "ws://127.0.0.1:4500",
    "codex-thread-1",
    "Claude: Please review the final state."
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
    bridge.claudeChannelServerName("8", "repo-123"),
  ]);
  expect(removeCall?.[1]).toMatchObject({
    stderr: "pipe",
    stdout: "ignore",
  });
  expect(bridge.readPendingBridgeMessages(runDir)).toEqual([]);

  rmSync(root, { recursive: true, force: true });
});

test("bridge drains pending codex tmux messages through the injected command deps", async () => {
  const spawnSync = mock((args: string[]) => {
    if (args[0] === "tmux" && args[1] === "has-session") {
      return { exitCode: 0, stderr: Buffer.alloc(0), stdout: Buffer.alloc(0) };
    }
    if (args[0] === "tmux" && args[1] === "capture-pane") {
      return {
        exitCode: 0,
        stderr: Buffer.alloc(0),
        stdout: Buffer.from("Ctrl+J newline", "utf8"),
      };
    }
    if (args[0] === "tmux" && args[1] === "send-keys") {
      return { exitCode: 0, stderr: Buffer.alloc(0), stdout: Buffer.alloc(0) };
    }
    return { exitCode: 0, stderr: Buffer.alloc(0), stdout: Buffer.alloc(0) };
  });
  const bridge = await loadBridge();
  bridge.bridgeRuntimeCommandDeps.spawnSync = spawnSync;
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
  bridge.bridgeInternals.appendBridgeEvent(runDir, {
    at: "2026-03-23T10:01:00.000Z",
    id: "msg-3",
    kind: "message",
    message: "Please check the tmux path.",
    source: "claude",
    target: "codex",
  });

  const delivered = await bridge.drainCodexTmuxMessages(runDir);

  expect(delivered).toBe(true);
  expect(bridge.readPendingBridgeMessages(runDir)).toEqual([]);
  expect(spawnSync.mock.calls).toEqual([
    [
      ["tmux", "has-session", "-t", "repo-loop-8"],
      { stderr: "ignore", stdout: "ignore" },
    ],
    [
      ["tmux", "capture-pane", "-p", "-t", "repo-loop-8:0.1"],
      { stderr: "ignore", stdout: "pipe" },
    ],
    [
      [
        "tmux",
        "send-keys",
        "-t",
        "repo-loop-8:0.1",
        "-l",
        "--",
        "Claude: Please check the tmux path.",
      ],
      { stderr: "ignore" },
    ],
    [
      ["tmux", "send-keys", "-t", "repo-loop-8:0.1", "Enter"],
      { stderr: "ignore" },
    ],
  ]);

  rmSync(root, { recursive: true, force: true });
});

test("bridge stale tmux cleanup is a no-op when the manifest has no tmux session", async () => {
  const spawnSync = mock(() => ({ exitCode: 0 }));
  const bridge = await loadBridge();
  bridge.bridgeRuntimeCommandDeps.spawnSync = spawnSync;
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

  expect(bridge.clearStaleTmuxBridgeState(runDir)).toBe(false);
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
  bridge.bridgeRuntimeCommandDeps.spawnSync = spawnSync;
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
    expect(bridge.clearStaleTmuxBridgeState(runDir)).toBe(true);
    expect(errorSpy).toHaveBeenCalledWith(
      '[loop] failed to remove Claude channel server "loop-bridge-repo-123-8": command failed'
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
  bridge.bridgeRuntimeCommandDeps.spawnSync = spawnSync;
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
    expect(bridge.clearStaleTmuxBridgeState(runDir)).toBe(true);
    expect(errorSpy).toHaveBeenCalledWith(
      '[loop] failed to remove Claude channel server "loop-bridge-repo-123-8": spawn failed'
    );
    expect(readRunManifest(join(runDir, "manifest.json"))?.tmuxSession).toBe(
      undefined
    );
  } finally {
    console.error = originalError;
    rmSync(root, { recursive: true, force: true });
  }
});

test("bridge stale tmux cleanup removes a persisted Claude server name", async () => {
  const spawnSync = mock((args: string[]) => {
    if (args[0] === "claude" && args[1] === "mcp" && args[2] === "remove") {
      return { exitCode: 0, stderr: Buffer.alloc(0), stdout: Buffer.alloc(0) };
    }
    return { exitCode: 0, stderr: Buffer.alloc(0), stdout: Buffer.alloc(0) };
  });
  const bridge = await loadBridge();
  bridge.bridgeRuntimeCommandDeps.spawnSync = spawnSync;
  const root = makeTempDir();
  const runDir = join(root, "run");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, "manifest.json"),
    `${JSON.stringify({
      claudeChannelServer: "loop-bridge-custom-8",
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

  expect(bridge.clearStaleTmuxBridgeState(runDir)).toBe(true);
  expect(
    spawnSync.mock.calls.filter(
      (call) => call[0]?.[0] === "claude" && call[0]?.[2] === "remove"
    )
  ).toEqual(
    expect.arrayContaining([
      [
        ["claude", "mcp", "remove", "--scope", "local", "loop-bridge-custom-8"],
        expect.objectContaining({ stderr: "pipe", stdout: "ignore" }),
      ],
    ])
  );

  rmSync(root, { recursive: true, force: true });
});

test("runBridgeWorker clears stale tmux routing and exits", async () => {
  const spawnSync = mock((args: string[]) => {
    if (args[0] === "tmux" && args[1] === "has-session") {
      return { exitCode: 1, stderr: Buffer.alloc(0), stdout: Buffer.alloc(0) };
    }
    if (args[0] === "claude" && args[1] === "mcp" && args[2] === "remove") {
      return { exitCode: 0, stderr: Buffer.alloc(0), stdout: Buffer.alloc(0) };
    }
    return { exitCode: 0, stderr: Buffer.alloc(0), stdout: Buffer.alloc(0) };
  });
  const bridge = await loadBridge();
  bridge.bridgeRuntimeCommandDeps.spawnSync = spawnSync;
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
      state: "working",
      status: "running",
      tmuxSession: "repo-loop-8",
      updatedAt: "2026-03-23T10:00:00.000Z",
    })}\n`,
    "utf8"
  );

  await bridge.runBridgeWorker(runDir);

  expect(readRunManifest(join(runDir, "manifest.json"))?.tmuxSession).toBe(
    undefined
  );
  expect(spawnSync.mock.calls).toEqual(
    expect.arrayContaining([
      [
        ["tmux", "has-session", "-t", "repo-loop-8"],
        expect.objectContaining({ stderr: "ignore", stdout: "ignore" }),
      ],
      [
        [
          "claude",
          "mcp",
          "remove",
          "--scope",
          "local",
          bridge.claudeChannelServerName("8", "repo-123"),
        ],
        expect.objectContaining({ stderr: "pipe", stdout: "ignore" }),
      ],
    ])
  );

  rmSync(root, { recursive: true, force: true });
});

test("runBridgeWorker falls back to app-server delivery after stale tmux cleanup", async () => {
  let runDir = "";
  const injectCodexMessage = mock(() => {
    const manifestPath = join(runDir, "manifest.json");
    const manifest = readRunManifest(manifestPath);
    writeFileSync(
      manifestPath,
      `${JSON.stringify({
        ...manifest,
        state: "completed",
        status: "completed",
      })}\n`,
      "utf8"
    );
    return true;
  });
  const spawnSync = mock((args: string[]) => {
    if (args[0] === "tmux" && args[1] === "has-session") {
      return { exitCode: 1, stderr: Buffer.alloc(0), stdout: Buffer.alloc(0) };
    }
    if (args[0] === "claude" && args[1] === "mcp" && args[2] === "remove") {
      return { exitCode: 0, stderr: Buffer.alloc(0), stdout: Buffer.alloc(0) };
    }
    return { exitCode: 0, stderr: Buffer.alloc(0), stdout: Buffer.alloc(0) };
  });
  const bridge = await loadBridge({ injectCodexMessage });
  bridge.bridgeRuntimeCommandDeps.spawnSync = spawnSync;
  const root = makeTempDir();
  runDir = join(root, "run");
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
      state: "working",
      status: "running",
      tmuxSession: "repo-loop-8",
      updatedAt: "2026-03-23T10:00:00.000Z",
    })}\n`,
    "utf8"
  );
  bridge.bridgeInternals.appendBridgeEvent(runDir, {
    at: "2026-03-23T10:01:00.000Z",
    id: "msg-stale-fallback",
    kind: "message",
    message: "Please deliver this after tmux cleanup.",
    source: "claude",
    target: "codex",
  });

  await bridge.runBridgeWorker(runDir);

  expect(injectCodexMessage).toHaveBeenCalledWith(
    "ws://127.0.0.1:4500",
    "codex-thread-1",
    "Claude: Please deliver this after tmux cleanup."
  );
  expect(readRunManifest(join(runDir, "manifest.json"))?.tmuxSession).toBe(
    undefined
  );
  expect(bridge.readPendingBridgeMessages(runDir)).toEqual([]);

  rmSync(root, { recursive: true, force: true });
});

test("ensureBridgeWorker launches one app-server worker per active run", async () => {
  const bridge = await loadBridge();
  const spawn = mock(() => ({
    pid: process.pid,
    unref: mock(() => undefined),
  }));
  bridge.bridgeRuntimeCommandDeps.spawn = spawn;
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
      state: "working",
      status: "running",
      updatedAt: "2026-03-23T10:00:00.000Z",
    })}\n`,
    "utf8"
  );

  expect(bridge.ensureBridgeWorker(runDir)).toBe(true);
  expect(bridge.ensureBridgeWorker(runDir)).toBe(true);
  expect(spawn).toHaveBeenCalledTimes(1);
  expect(spawn.mock.calls[0]?.[0]).toEqual([
    "/opt/bun",
    "src/loop/main.ts",
    bridge.BRIDGE_WORKER_SUBCOMMAND,
    runDir,
  ]);
  expect(spawn.mock.calls[0]?.[1]).toMatchObject({
    stderr: "ignore",
    stdin: "ignore",
    stdout: "ignore",
  });

  rmSync(root, { recursive: true, force: true });
});

test("runBridgeWorker retries queued codex app-server messages", async () => {
  let runDir = "";
  const injectCodexMessage = mock(() => {
    if (injectCodexMessage.mock.calls.length === 1) {
      throw new Error("turn still active");
    }
    const manifestPath = join(runDir, "manifest.json");
    const manifest = readRunManifest(manifestPath);
    writeFileSync(
      manifestPath,
      `${JSON.stringify({
        ...manifest,
        state: "completed",
        status: "completed",
      })}\n`,
      "utf8"
    );
    return true;
  });
  const bridge = await loadBridge({ injectCodexMessage });
  const root = makeTempDir();
  runDir = join(root, "run");
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
      state: "working",
      status: "running",
      updatedAt: "2026-03-23T10:00:00.000Z",
    })}\n`,
    "utf8"
  );
  bridge.bridgeInternals.appendBridgeEvent(runDir, {
    at: "2026-03-23T10:01:00.000Z",
    id: "msg-4",
    kind: "message",
    message: "Please review the final diff.",
    source: "claude",
    target: "codex",
  });

  await bridge.runBridgeWorker(runDir);

  expect(injectCodexMessage).toHaveBeenCalledTimes(2);
  expect(injectCodexMessage.mock.calls).toEqual([
    [
      "ws://127.0.0.1:4500",
      "codex-thread-1",
      "Claude: Please review the final diff.",
    ],
    [
      "ws://127.0.0.1:4500",
      "codex-thread-1",
      "Claude: Please review the final diff.",
    ],
  ]);
  expect(bridge.readPendingBridgeMessages(runDir)).toEqual([]);
  expect(
    bridge.bridgeInternals
      .readBridgeEvents(runDir)
      .filter((event) => event.kind === "delivered")
  ).toHaveLength(1);

  rmSync(root, { recursive: true, force: true });
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

test("bridge MCP flushes new Claude channel messages after bridge file changes", async () => {
  const bridge = await loadBridge();
  const root = makeTempDir();
  const runDir = join(root, "run");
  mkdirSync(runDir, { recursive: true });
  const process = startLiveBridgeProcess(runDir, "claude");

  process.write(
    encodeLine({
      id: 1,
      jsonrpc: "2.0",
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
      },
    })
  );
  process.write(
    encodeLine({
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {},
    })
  );
  await process.waitForStdout('"id":1');

  writeFileSync(
    bridge.bridgeInternals.bridgePath(runDir),
    `${JSON.stringify({
      at: "2026-03-23T10:00:00.000Z",
      id: "msg-watch-1",
      kind: "message",
      message: "Please review the follow-up change.",
      source: "codex",
      target: "claude",
    })}\n`,
    "utf8"
  );

  await process.waitForStdout("Please review the follow-up change.");
  const result = await process.close();

  expect(result.code).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout).toContain('"method":"notifications/claude/channel"');
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
          name: "send_message",
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
          name: "send_message",
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
          name: "send_message",
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
    "-c",
    'mcp_servers.loop-bridge.tools.send_message.approval_mode="approve"',
    "-c",
    'mcp_servers.loop-bridge.tools.bridge_status.approval_mode="approve"',
    "-c",
    'mcp_servers.loop-bridge.tools.receive_messages.approval_mode="approve"',
  ]);

  rmSync(root, { recursive: true, force: true });
});

test("bridge config helper writes the Claude MCP config file", async () => {
  const bridge = await loadBridge();
  const root = makeTempDir();
  const runDir = join(root, "run");

  const path = bridge.ensureClaudeBridgeConfig(runDir, "claude");
  expect(path).toBe(join(runDir, "claude-mcp.json"));
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
    mcpServers: {
      [bridge.BRIDGE_SERVER]: {
        args: ["src/loop/main.ts", bridge.BRIDGE_SUBCOMMAND, runDir, "claude"],
        command: "/opt/bun",
        type: "stdio",
      },
    },
  });

  rmSync(root, { recursive: true, force: true });
});

test("bridge config helper writes the Claude MCP config file for a custom server", async () => {
  const bridge = await loadBridge();
  const root = makeTempDir();
  const runDir = join(root, "run");
  const serverName = bridge.claudeChannelServerName("1", "repo-123");

  const path = bridge.ensureClaudeBridgeConfig(runDir, "claude", serverName);
  expect(path).toBe(join(runDir, "claude-mcp.json"));
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
    mcpServers: {
      [serverName]: {
        args: ["src/loop/main.ts", bridge.BRIDGE_SUBCOMMAND, runDir, "claude"],
        command: "/opt/bun",
        type: "stdio",
      },
    },
  });

  rmSync(root, { recursive: true, force: true });
});

test("bridge registration helper throws on unexpected Claude MCP add-json failures", async () => {
  const bridge = await loadBridge();

  expect(() =>
    bridge.registerClaudeChannelServer(
      ["/opt/bun", "src/loop/main.ts"],
      bridge.claudeChannelServerName("7", "repo-123"),
      "/tmp/run",
      () => ({ exitCode: 1, stderr: "command failed" })
    )
  ).toThrow("[loop] failed to register Claude channel server: command failed");
});

test("dispatchBridgeMessage reports delivered when direct codex delivery succeeds", async () => {
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

  const result = await bridge.dispatchBridgeMessage(
    runDir,
    "claude",
    "codex",
    "Please review the final diff.",
    (entry) => bridge.deliverCodexBridgeMessage(runDir, entry)
  );

  expect(result.status).toBe("delivered");
  expect(bridge.formatDispatchResult(result)).toContain("delivered");
  expect(injectCodexMessage).toHaveBeenCalledWith(
    "ws://127.0.0.1:4500",
    "codex-thread-1",
    expect.stringContaining("Claude: Please review the final diff.")
  );
  expect(bridge.readPendingBridgeMessages(runDir)).toEqual([]);

  rmSync(root, { recursive: true, force: true });
});

test("dispatchBridgeMessage stays queued when tmux metadata is stale", async () => {
  const bridge = await loadBridge();
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
      tmuxSession: "repo-loop-stale",
      updatedAt: "2026-03-23T10:00:00.000Z",
    })}\n`,
    "utf8"
  );

  const result = await bridge.dispatchBridgeMessage(
    runDir,
    "claude",
    "codex",
    "Please review the final diff.",
    undefined,
    () => bridge.hasLiveCodexTmuxSession(runDir)
  );

  expect(result.status).toBe("queued");
  expect(bridge.formatDispatchResult(result)).toContain("queued");
  expect(bridge.readPendingBridgeMessages(runDir)).toEqual([
    expect.objectContaining({
      message: "Please review the final diff.",
      source: "claude",
      target: "codex",
    }),
  ]);

  rmSync(root, { recursive: true, force: true });
});

test("dispatchBridgeMessage formats accepted status with the target name", async () => {
  const bridge = await loadBridge();
  const root = makeTempDir();
  const runDir = join(root, "run");
  mkdirSync(runDir, { recursive: true });

  const result = await bridge.dispatchBridgeMessage(
    runDir,
    "codex",
    "claude",
    "Please review the diff.",
    undefined,
    () => true
  );

  expect(result.status).toBe("accepted");
  expect(bridge.formatDispatchResult(result)).toBe(
    `accepted ${result.entry.id} for claude delivery`
  );

  rmSync(root, { recursive: true, force: true });
});
