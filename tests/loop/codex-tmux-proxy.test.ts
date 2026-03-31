import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ServerWebSocket, serve } from "bun";
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

interface JsonFrame {
  error?: unknown;
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
}

const makeTempDir = (): string => mkdtempSync(join(tmpdir(), "loop-proxy-"));

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
  const upstreamPort = await findFreePort(4700, 100);
  const proxyPort = await findFreePort(4800, 100);
  const upstreamUrl = `ws://127.0.0.1:${upstreamPort}/`;
  const upstreamSockets: ServerWebSocket<{ initialized: boolean }>[] = [];
  const tuiMessages: JsonFrame[] = [];
  let tuiClosed = false;
  let upstreamConnections = 0;

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

  const upstreamServer = serve({
    fetch: (request, server) => {
      if (server.upgrade(request, { data: { initialized: false } })) {
        return undefined;
      }
      return new Response("upstream");
    },
    hostname: "127.0.0.1",
    port: upstreamPort,
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
          if (frame.method === "turn/start") {
            ws.send(
              JSON.stringify({
                id: frame.id,
                result: { turn: { id: "turn-after-reconnect" } },
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
  });

  const proxyTask = runCodexTmuxProxy(root, upstreamUrl, "thread-1", proxyPort);

  let tui: WebSocket | undefined;
  try {
    const proxyUrl = await waitForCodexTmuxProxy(proxyPort);
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

    upstreamSockets[0]?.close();
    await waitFor(() => upstreamConnections >= 2, 5000);
    expect(tuiClosed).toBe(false);

    tui.send(
      JSON.stringify({
        id: 2,
        method: "turn/start",
        params: {
          input: [
            {
              text: "hello",
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
            (frame.result as { turn?: { id?: string } } | undefined)?.turn
              ?.id === "turn-after-reconnect"
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
      proxyTask,
      new Promise((resolve) => setTimeout(resolve, 2000)),
    ]);
    upstreamServer.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
});
