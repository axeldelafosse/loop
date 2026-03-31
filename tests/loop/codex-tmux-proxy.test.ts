import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ServerWebSocket, serve } from "bun";
import {
  appendBridgeMessage,
  readPendingBridgeMessages,
} from "../../src/loop/bridge-store";
import {
  codexTmuxProxyInternals,
  runCodexTmuxProxy,
  waitForCodexTmuxProxy,
} from "../../src/loop/codex-tmux-proxy";
import { findFreePort } from "../../src/loop/ports";
import {
  createRunManifest,
  readRunManifest,
  updateRunManifest,
  writeRunManifest,
} from "../../src/loop/run-state";

const bridgeMessage = {
  at: "2026-03-29T00:00:00.000Z",
  id: "msg-1",
  kind: "message" as const,
  message: "Please review the latest diff.",
  source: "claude" as const,
  target: "codex" as const,
};

const TEST_PORT_RANGE = 200;
const TEST_PORT_RETRY_LIMIT = 5;
const TEST_PORT_START = 20_000;
const TEST_PORT_WINDOW = 20_000;

interface JsonFrame {
  error?: unknown;
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
}

const makeTempDir = (): string => mkdtempSync(join(tmpdir(), "loop-proxy-"));

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const isBridgeRequestId = (value: unknown): boolean =>
  typeof value === "string" && value.startsWith("proxy-bridge-");

const isAddressInUseError = (error: unknown): boolean => {
  if (!isRecord(error)) {
    return false;
  }
  const code = asString(error.code);
  if (code === "EADDRINUSE") {
    return true;
  }
  const message = asString(error.message)?.toLowerCase() ?? "";
  return message.includes("eaddrinuse");
};

const randomTestPortBase = (): number =>
  TEST_PORT_START + Math.floor(Math.random() * TEST_PORT_WINDOW);

const findTestPort = (): Promise<number> =>
  findFreePort(randomTestPortBase(), TEST_PORT_RANGE);

const startServerWithRetries = async (
  createServer: (port: number) => ReturnType<typeof serve>
): Promise<{ port: number; server: ReturnType<typeof serve> }> => {
  let lastError: unknown;
  for (let attempt = 0; attempt < TEST_PORT_RETRY_LIMIT; attempt += 1) {
    const port = await findTestPort();
    try {
      return {
        port,
        server: createServer(port),
      };
    } catch (error) {
      if (!isAddressInUseError(error)) {
        throw error;
      }
      lastError = error;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("failed to start test server");
};

const startProxyWithRetries = async (
  runDir: string,
  remoteUrl: string,
  threadId: string
): Promise<{ proxyTask: Promise<void>; proxyUrl: string }> => {
  let lastError: unknown;
  for (let attempt = 0; attempt < TEST_PORT_RETRY_LIMIT; attempt += 1) {
    const port = await findTestPort();
    const proxyTask = runCodexTmuxProxy(runDir, remoteUrl, threadId, port);
    try {
      const proxyUrl = await Promise.race([
        waitForCodexTmuxProxy(port),
        proxyTask.then(() => {
          throw new Error("codex tmux proxy stopped before becoming ready");
        }),
      ]);
      return { proxyTask, proxyUrl };
    } catch (error) {
      if (!isAddressInUseError(error)) {
        throw error;
      }
      await proxyTask.catch(() => undefined);
      lastError = error;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("failed to start codex tmux proxy");
};

const waitFor = async (
  predicate: () => boolean,
  timeoutMs = 5000
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("timed out waiting for condition");
};

test("codex tmux proxy waits briefly for the tmux session to appear", () => {
  const now = Date.now();

  expect(
    codexTmuxProxyInternals.shouldStopForTmuxSession(
      false,
      false,
      now + 1000,
      now
    )
  ).toBe(false);
});

test("codex tmux proxy stops once the startup grace window is over", () => {
  const now = Date.now();

  expect(
    codexTmuxProxyInternals.shouldStopForTmuxSession(false, false, now - 1, now)
  ).toBe(true);
});

test("codex tmux proxy stops immediately after a seen tmux session disappears", () => {
  const now = Date.now();

  expect(
    codexTmuxProxyInternals.shouldStopForTmuxSession(
      false,
      true,
      now + 1000,
      now
    )
  ).toBe(true);
  expect(
    codexTmuxProxyInternals.shouldStopForTmuxSession(
      true,
      true,
      now + 1000,
      now
    )
  ).toBe(false);
});

test("codex tmux proxy records turn ids from turn/start responses", () => {
  const turnIds = new Set<string>(["turn-1"]);

  codexTmuxProxyInternals.noteStartedTurn(turnIds, {
    turn: { id: "turn-2" },
  });

  expect([...turnIds]).toEqual(["turn-1", "turn-2"]);
  expect(codexTmuxProxyInternals.latestActiveTurnId(turnIds)).toBe("turn-2");
});

test("codex tmux proxy keeps the newest active turn id", () => {
  const activeTurns = new Set(["turn-1", "turn-2"]);

  expect(codexTmuxProxyInternals.latestActiveTurnId(activeTurns)).toBe(
    "turn-2"
  );
  expect(codexTmuxProxyInternals.latestActiveTurnId(new Set())).toBe(undefined);
});

test("codex tmux proxy steers bridge messages into an active turn", () => {
  expect(
    codexTmuxProxyInternals.buildBridgeInjectionFrame(
      -1,
      "thread-1",
      bridgeMessage,
      "turn-active"
    )
  ).toEqual({
    id: -1,
    method: "turn/steer",
    params: {
      expectedTurnId: "turn-active",
      input: [
        {
          text: "Claude: Please review the latest diff.",
          text_elements: [],
          type: "text",
        },
      ],
      threadId: "thread-1",
    },
  });
});

test("codex tmux proxy starts a new turn when no active turn exists", () => {
  expect(
    codexTmuxProxyInternals.buildBridgeInjectionFrame(
      -1,
      "thread-1",
      bridgeMessage
    )
  ).toEqual({
    id: -1,
    method: "turn/start",
    params: {
      input: [
        {
          text: "Claude: Please review the latest diff.",
          text_elements: [],
          type: "text",
        },
      ],
      threadId: "thread-1",
    },
  });
});

test("codex tmux proxy only pauses bridge drain when it cannot steer", () => {
  expect(
    codexTmuxProxyInternals.shouldPauseBridgeDrain(false, undefined, 0)
  ).toBe(false);
  expect(
    codexTmuxProxyInternals.shouldPauseBridgeDrain(true, "turn-active", 0)
  ).toBe(false);
  expect(
    codexTmuxProxyInternals.shouldPauseBridgeDrain(true, undefined, 0)
  ).toBe(true);
  expect(
    codexTmuxProxyInternals.shouldPauseBridgeDrain(false, undefined, 1)
  ).toBe(true);
});

test("codex tmux proxy persists newer live thread ids to the run manifest", () => {
  const root = makeTempDir();
  const manifestPath = join(root, "manifest.json");
  writeRunManifest(
    manifestPath,
    createRunManifest({
      claudeSessionId: "claude-1",
      codexRemoteUrl: "ws://127.0.0.1:4500",
      codexThreadId: "codex-thread-startup",
      cwd: "/repo",
      mode: "paired",
      pid: 1234,
      repoId: "repo-123",
      runId: "7",
      tmuxSession: "loop-loop-7",
    })
  );

  codexTmuxProxyInternals.persistCodexThreadId(root, "codex-thread-live");

  expect(readRunManifest(manifestPath)?.codexThreadId).toBe(
    "codex-thread-live"
  );

  rmSync(root, { recursive: true, force: true });
});

test("codex tmux proxy reconnects to a live upstream without dropping the tui socket", async () => {
  const root = makeTempDir();
  const manifestPath = join(root, "manifest.json");
  const bridgeMethods: string[] = [];
  const tuiTurnIds: string[] = [];
  const upstreamSockets: ServerWebSocket<{ initialized: boolean }>[] = [];
  let upstreamInitializeCount = 0;
  let upstreamConnections = 0;
  let proxyTask: Promise<void> | undefined;
  let upstreamServer: ReturnType<typeof serve> | undefined;
  let upstreamPort = 0;
  let proxyUrl = "";
  const upstreamStart = await startServerWithRetries((port) =>
    serve({
      fetch: (request, server) => {
        if (server.upgrade(request, { data: { initialized: false } })) {
          return undefined;
        }
        return new Response("upstream");
      },
      hostname: "127.0.0.1",
      port,
      websocket: {
        close: (ws) => {
          const index = upstreamSockets.indexOf(ws);
          if (index !== -1) {
            upstreamSockets.splice(index, 1);
          }
        },
        message: (ws, message) => {
          const payload =
            typeof message === "string" ? message : message.toString();
          for (const raw of payload.split("\n")) {
            if (!raw.trim()) {
              continue;
            }
            const frame = JSON.parse(raw) as JsonFrame;
            if (frame.method === "initialize") {
              upstreamInitializeCount += 1;
              if (ws.data.initialized) {
                ws.send(
                  JSON.stringify({
                    error: { message: "already initialized" },
                    id: frame.id,
                  })
                );
              } else {
                ws.data.initialized = true;
                ws.send(JSON.stringify({ id: frame.id, result: {} }));
              }
              continue;
            }
            if (frame.method === "initialized") {
              continue;
            }
            if (frame.method === "thread/read") {
              ws.send(
                JSON.stringify({
                  id: frame.id,
                  result: {
                    thread: {
                      turns: [],
                    },
                  },
                })
              );
              continue;
            }
            if (frame.method === "turn/start") {
              const turnId = isBridgeRequestId(frame.id)
                ? "bridge-turn-after-reconnect"
                : `tui-turn-${tuiTurnIds.length + 1}`;
              if (isBridgeRequestId(frame.id)) {
                bridgeMethods.push(frame.method);
              } else {
                tuiTurnIds.push(turnId);
              }
              ws.send(
                JSON.stringify({
                  id: frame.id,
                  result: { turn: { id: turnId } },
                })
              );
              continue;
            }
            if (isBridgeRequestId(frame.id) && frame.method) {
              bridgeMethods.push(frame.method);
            }
          }
        },
        open: (ws) => {
          upstreamConnections += 1;
          upstreamSockets.push(ws);
        },
      },
    })
  );
  upstreamPort = upstreamStart.port;
  upstreamServer = upstreamStart.server;
  const upstreamUrl = `ws://127.0.0.1:${upstreamPort}/`;
  const tuiMessages: JsonFrame[] = [];
  let tuiClosed = false;

  writeRunManifest(
    manifestPath,
    createRunManifest({
      claudeSessionId: "claude-1",
      codexRemoteUrl: upstreamUrl,
      codexThreadId: "thread-1",
      cwd: "/repo",
      mode: "paired",
      pid: 1234,
      repoId: "repo-123",
      runId: "9",
      state: "working",
      status: "running",
    })
  );

  let tui: WebSocket | undefined;
  try {
    const proxyStart = await startProxyWithRetries(
      root,
      upstreamUrl,
      "thread-1"
    );
    proxyTask = proxyStart.proxyTask;
    proxyUrl = proxyStart.proxyUrl;
    tui = new WebSocket(proxyUrl);
    tui.onclose = () => {
      tuiClosed = true;
    };
    tui.onmessage = (event) => {
      tuiMessages.push(JSON.parse(String(event.data)) as JsonFrame);
    };

    await new Promise<void>((resolve, reject) => {
      if (!tui) {
        reject(new Error("missing tui websocket"));
        return;
      }
      tui.onopen = () => resolve();
      tui.onerror = () => reject(new Error("failed to open tui websocket"));
    });

    tui.send(JSON.stringify({ id: 1, method: "initialize", params: {} }));
    await waitFor(
      () => tuiMessages.some((frame) => frame.id === 1 && frame.result),
      5000
    );
    expect(upstreamInitializeCount).toBe(1);

    tui.send(
      JSON.stringify({
        id: 2,
        method: "turn/start",
        params: {
          input: [
            {
              text: "hello before reconnect",
              text_elements: [],
              type: "text",
            },
          ],
          threadId: "thread-1",
        },
      })
    );
    await waitFor(
      () =>
        tuiMessages.some(
          (frame) =>
            frame.id === 2 &&
            (frame.result as { turn?: { id?: string } } | undefined)?.turn?.id
        ),
      5000
    );

    upstreamSockets[0]?.close();
    await waitFor(() => upstreamConnections >= 2, 5000);
    expect(tuiClosed).toBe(false);
    expect(upstreamInitializeCount).toBe(2);

    appendBridgeMessage(
      root,
      bridgeMessage.source,
      bridgeMessage.target,
      bridgeMessage.message
    );
    await waitFor(() => bridgeMethods.length > 0, 5000);
    expect(bridgeMethods).toEqual(["turn/start"]);

    tui.send(
      JSON.stringify({
        id: 3,
        method: "turn/start",
        params: {
          input: [
            {
              text: "hello after reconnect",
              text_elements: [],
              type: "text",
            },
          ],
          threadId: "thread-1",
        },
      })
    );

    await waitFor(
      () =>
        tuiMessages.some(
          (frame) =>
            frame.id === 3 &&
            (frame.result as { turn?: { id?: string } } | undefined)?.turn?.id
        ),
      5000
    );
    expect(tuiClosed).toBe(false);
  } finally {
    tui?.close();
    updateRunManifest(manifestPath, (manifest) =>
      manifest
        ? {
            ...manifest,
            state: "completed",
            status: "completed",
          }
        : manifest
    );
    await Promise.race([
      proxyTask ?? Promise.resolve(),
      new Promise((resolve) => setTimeout(resolve, 2000)),
    ]);
    upstreamServer?.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
});

test("codex tmux proxy steers bridge messages into the resumed active turn after reconnect", async () => {
  const root = makeTempDir();
  const manifestPath = join(root, "manifest.json");
  const bridgeMethods: string[] = [];
  const upstreamSockets: ServerWebSocket<{ initialized: boolean }>[] = [];
  let activeTurnId = "";
  let proxyTask: Promise<void> | undefined;
  let threadReadCount = 0;
  let upstreamConnections = 0;

  const upstreamStart = await startServerWithRetries((port) =>
    serve({
      fetch: (request, server) => {
        if (server.upgrade(request, { data: { initialized: false } })) {
          return undefined;
        }
        return new Response("upstream");
      },
      hostname: "127.0.0.1",
      port,
      websocket: {
        close: (ws) => {
          const index = upstreamSockets.indexOf(ws);
          if (index !== -1) {
            upstreamSockets.splice(index, 1);
          }
        },
        message: (ws, message) => {
          const payload =
            typeof message === "string" ? message : message.toString();
          for (const raw of payload.split("\n")) {
            if (!raw.trim()) {
              continue;
            }
            const frame = JSON.parse(raw) as JsonFrame;
            if (frame.method === "initialize") {
              if (ws.data.initialized) {
                ws.send(
                  JSON.stringify({
                    error: { message: "already initialized" },
                    id: frame.id,
                  })
                );
              } else {
                ws.data.initialized = true;
                ws.send(JSON.stringify({ id: frame.id, result: {} }));
              }
              continue;
            }
            if (frame.method === "initialized") {
              continue;
            }
            if (frame.method === "thread/read") {
              threadReadCount += 1;
              ws.send(
                JSON.stringify({
                  id: frame.id,
                  result: {
                    thread: {
                      turns: activeTurnId
                        ? [{ id: activeTurnId, status: "inProgress" }]
                        : [],
                    },
                  },
                })
              );
              continue;
            }
            if (frame.method === "turn/start") {
              if (isBridgeRequestId(frame.id)) {
                bridgeMethods.push(frame.method);
                ws.send(
                  JSON.stringify({
                    error: { message: "turn still active" },
                    id: frame.id,
                  })
                );
                continue;
              }
              activeTurnId = "tui-turn-1";
              ws.send(
                JSON.stringify({
                  id: frame.id,
                  result: { turn: { id: activeTurnId } },
                })
              );
              continue;
            }
            if (frame.method === "turn/steer") {
              bridgeMethods.push(frame.method);
              ws.send(
                JSON.stringify({
                  id: frame.id,
                  result: { turn: { id: activeTurnId } },
                })
              );
            }
          }
        },
        open: (ws) => {
          upstreamConnections += 1;
          upstreamSockets.push(ws);
        },
      },
    })
  );
  const upstreamServer = upstreamStart.server;
  const upstreamUrl = `ws://127.0.0.1:${upstreamStart.port}/`;
  const tuiMessages: JsonFrame[] = [];

  writeRunManifest(
    manifestPath,
    createRunManifest({
      claudeSessionId: "claude-1",
      codexRemoteUrl: upstreamUrl,
      codexThreadId: "thread-1",
      cwd: "/repo",
      mode: "paired",
      pid: 1234,
      repoId: "repo-123",
      runId: "10",
      state: "working",
      status: "running",
    })
  );

  let tui: WebSocket | undefined;
  try {
    const proxyStart = await startProxyWithRetries(
      root,
      upstreamUrl,
      "thread-1"
    );
    proxyTask = proxyStart.proxyTask;
    tui = new WebSocket(proxyStart.proxyUrl);
    tui.onmessage = (event) => {
      tuiMessages.push(JSON.parse(String(event.data)) as JsonFrame);
    };

    await new Promise<void>((resolve, reject) => {
      if (!tui) {
        reject(new Error("missing tui websocket"));
        return;
      }
      tui.onopen = () => resolve();
      tui.onerror = () => reject(new Error("failed to open tui websocket"));
    });

    tui.send(JSON.stringify({ id: 1, method: "initialize", params: {} }));
    await waitFor(
      () => tuiMessages.some((frame) => frame.id === 1 && frame.result),
      5000
    );

    tui.send(
      JSON.stringify({
        id: 2,
        method: "turn/start",
        params: {
          input: [
            {
              text: "hello before reconnect",
              text_elements: [],
              type: "text",
            },
          ],
          threadId: "thread-1",
        },
      })
    );
    await waitFor(
      () =>
        tuiMessages.some(
          (frame) =>
            frame.id === 2 &&
            (frame.result as { turn?: { id?: string } } | undefined)?.turn?.id
        ),
      5000
    );

    upstreamSockets[0]?.close();
    await waitFor(() => upstreamConnections >= 2, 5000);
    await waitFor(() => threadReadCount >= 2, 5000);

    appendBridgeMessage(
      root,
      bridgeMessage.source,
      bridgeMessage.target,
      bridgeMessage.message
    );
    await waitFor(
      () =>
        bridgeMethods.length > 0 &&
        readPendingBridgeMessages(root).length === 0,
      5000
    );
    expect(bridgeMethods).toEqual(["turn/steer"]);
  } finally {
    tui?.close();
    updateRunManifest(manifestPath, (manifest) =>
      manifest
        ? {
            ...manifest,
            state: "completed",
            status: "completed",
          }
        : manifest
    );
    await Promise.race([
      proxyTask ?? Promise.resolve(),
      new Promise((resolve) => setTimeout(resolve, 2000)),
    ]);
    upstreamServer.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
});

test("codex tmux proxy falls back to a fresh bridge turn when steer fails after reconnect", async () => {
  const root = makeTempDir();
  const manifestPath = join(root, "manifest.json");
  const bridgeMethods: string[] = [];
  const upstreamSockets: ServerWebSocket<{ initialized: boolean }>[] = [];
  let activeTurnId = "";
  let proxyTask: Promise<void> | undefined;
  let threadReadCount = 0;
  let upstreamConnections = 0;
  let steerAttempts = 0;

  const upstreamStart = await startServerWithRetries((port) =>
    serve({
      fetch: (request, server) => {
        if (server.upgrade(request, { data: { initialized: false } })) {
          return undefined;
        }
        return new Response("upstream");
      },
      hostname: "127.0.0.1",
      port,
      websocket: {
        close: (ws) => {
          const index = upstreamSockets.indexOf(ws);
          if (index !== -1) {
            upstreamSockets.splice(index, 1);
          }
        },
        message: (ws, message) => {
          const payload =
            typeof message === "string" ? message : message.toString();
          for (const raw of payload.split("\n")) {
            if (!raw.trim()) {
              continue;
            }
            const frame = JSON.parse(raw) as JsonFrame;
            if (frame.method === "initialize") {
              if (ws.data.initialized) {
                ws.send(
                  JSON.stringify({
                    error: { message: "already initialized" },
                    id: frame.id,
                  })
                );
              } else {
                ws.data.initialized = true;
                ws.send(JSON.stringify({ id: frame.id, result: {} }));
              }
              continue;
            }
            if (frame.method === "initialized") {
              continue;
            }
            if (frame.method === "thread/read") {
              threadReadCount += 1;
              ws.send(
                JSON.stringify({
                  id: frame.id,
                  result: {
                    thread: {
                      turns: activeTurnId
                        ? [{ id: activeTurnId, status: "inProgress" }]
                        : [],
                    },
                  },
                })
              );
              continue;
            }
            if (frame.method === "turn/start") {
              if (isBridgeRequestId(frame.id)) {
                bridgeMethods.push(frame.method);
                activeTurnId = "bridge-turn-after-reconnect";
                ws.send(
                  JSON.stringify({
                    id: frame.id,
                    result: { turn: { id: activeTurnId } },
                  })
                );
                continue;
              }
              activeTurnId = "tui-turn-1";
              ws.send(
                JSON.stringify({
                  id: frame.id,
                  result: { turn: { id: activeTurnId } },
                })
              );
              continue;
            }
            if (frame.method === "turn/steer") {
              bridgeMethods.push(frame.method);
              steerAttempts += 1;
              if (steerAttempts === 1) {
                ws.send(
                  JSON.stringify({
                    error: { message: "cannot steer resumed turn" },
                    id: frame.id,
                  })
                );
                continue;
              }
              ws.send(
                JSON.stringify({
                  id: frame.id,
                  result: { turn: { id: activeTurnId } },
                })
              );
            }
          }
        },
        open: (ws) => {
          upstreamConnections += 1;
          upstreamSockets.push(ws);
        },
      },
    })
  );
  const upstreamServer = upstreamStart.server;
  const upstreamUrl = `ws://127.0.0.1:${upstreamStart.port}/`;
  const tuiMessages: JsonFrame[] = [];

  writeRunManifest(
    manifestPath,
    createRunManifest({
      claudeSessionId: "claude-1",
      codexRemoteUrl: upstreamUrl,
      codexThreadId: "thread-1",
      cwd: "/repo",
      mode: "paired",
      pid: 1234,
      repoId: "repo-123",
      runId: "11",
      state: "working",
      status: "running",
    })
  );

  let tui: WebSocket | undefined;
  try {
    const proxyStart = await startProxyWithRetries(
      root,
      upstreamUrl,
      "thread-1"
    );
    proxyTask = proxyStart.proxyTask;
    tui = new WebSocket(proxyStart.proxyUrl);
    tui.onmessage = (event) => {
      tuiMessages.push(JSON.parse(String(event.data)) as JsonFrame);
    };

    await new Promise<void>((resolve, reject) => {
      if (!tui) {
        reject(new Error("missing tui websocket"));
        return;
      }
      tui.onopen = () => resolve();
      tui.onerror = () => reject(new Error("failed to open tui websocket"));
    });

    tui.send(JSON.stringify({ id: 1, method: "initialize", params: {} }));
    await waitFor(
      () => tuiMessages.some((frame) => frame.id === 1 && frame.result),
      5000
    );

    tui.send(
      JSON.stringify({
        id: 2,
        method: "turn/start",
        params: {
          input: [
            {
              text: "hello before reconnect",
              text_elements: [],
              type: "text",
            },
          ],
          threadId: "thread-1",
        },
      })
    );
    await waitFor(
      () =>
        tuiMessages.some(
          (frame) =>
            frame.id === 2 &&
            (frame.result as { turn?: { id?: string } } | undefined)?.turn?.id
        ),
      5000
    );

    upstreamSockets[0]?.close();
    await waitFor(() => upstreamConnections >= 2, 5000);
    await waitFor(() => threadReadCount >= 2, 5000);

    appendBridgeMessage(
      root,
      bridgeMessage.source,
      bridgeMessage.target,
      bridgeMessage.message
    );
    await waitFor(
      () =>
        bridgeMethods.length > 1 &&
        readPendingBridgeMessages(root).length === 0,
      5000
    );
    expect(bridgeMethods).toEqual(["turn/steer", "turn/start"]);
  } finally {
    tui?.close();
    updateRunManifest(manifestPath, (manifest) =>
      manifest
        ? {
            ...manifest,
            state: "completed",
            status: "completed",
          }
        : manifest
    );
    await Promise.race([
      proxyTask ?? Promise.resolve(),
      new Promise((resolve) => setTimeout(resolve, 2000)),
    ]);
    upstreamServer.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
});
