import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ServerWebSocket, serve } from "bun";
import { runCli } from "../../src/cli";
import { appendBridgeMessage } from "../../src/loop/bridge-store";
import {
  CODEX_TMUX_PROXY_SUBCOMMAND,
  waitForCodexTmuxProxy,
} from "../../src/loop/codex-tmux-proxy";
import { findFreePort } from "../../src/loop/ports";
import {
  createRunManifest,
  updateRunManifest,
  writeRunManifest,
} from "../../src/loop/run-state";

const TEST_PORT_RANGE = 200;
const TEST_PORT_RETRY_LIMIT = 5;
const TEST_PORT_START = 24_000;
const TEST_PORT_WINDOW = 20_000;

interface JsonFrame {
  error?: unknown;
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
}

const bridgeMessage = {
  message: "Please review the latest diff.",
  source: "claude" as const,
  target: "codex" as const,
};

const makeTempDir = (): string => mkdtempSync(join(tmpdir(), "loop-proxy-"));

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const asRecord = (value: unknown): Record<string, unknown> =>
  (isRecord(value) ? value : {}) as Record<string, unknown>;

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

const startCliProxyWithRetries = async (
  runDir: string,
  remoteUrl: string,
  threadId: string
): Promise<{ proxyTask: Promise<void>; proxyUrl: string }> => {
  let lastError: unknown;
  for (let attempt = 0; attempt < TEST_PORT_RETRY_LIMIT; attempt += 1) {
    const port = await findTestPort();
    const proxyTask = runCli([
      CODEX_TMUX_PROXY_SUBCOMMAND,
      runDir,
      remoteUrl,
      threadId,
      String(port),
    ]);
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

test("runCli reconnects the codex tmux proxy subcommand without dropping the tui socket", async () => {
  const root = makeTempDir();
  const manifestPath = join(root, "manifest.json");
  const bridgeMethods: string[] = [];
  const bridgeThreadIds: string[] = [];
  const tuiTurnIds: string[] = [];
  const upstreamSockets: ServerWebSocket<{ initialized: boolean }>[] = [];
  const tuiMessages: JsonFrame[] = [];
  let proxyTask: Promise<void> | undefined;
  let upstreamInitializeCount = 0;
  let upstreamConnections = 0;
  let tuiClosed = false;

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
              const threadId = asString(asRecord(frame.params).threadId);
              const turnId = isBridgeRequestId(frame.id)
                ? "bridge-turn-after-reconnect"
                : `tui-turn-${tuiTurnIds.length + 1}`;
              if (isBridgeRequestId(frame.id)) {
                bridgeMethods.push(frame.method);
                if (threadId) {
                  bridgeThreadIds.push(threadId);
                }
              } else {
                tuiTurnIds.push(turnId);
              }
              ws.send(
                JSON.stringify({
                  id: frame.id,
                  result: { turn: { id: turnId } },
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
      runId: "proxy-cli-e2e",
      state: "working",
      status: "running",
    })
  );

  let tui: WebSocket | undefined;
  try {
    const proxyStart = await startCliProxyWithRetries(
      root,
      upstreamUrl,
      "thread-1"
    );
    proxyTask = proxyStart.proxyTask;
    tui = new WebSocket(proxyStart.proxyUrl);
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
    updateRunManifest(manifestPath, (manifest) =>
      manifest
        ? {
            ...manifest,
            codexThreadId: "thread-2",
          }
        : manifest
    );

    appendBridgeMessage(
      root,
      bridgeMessage.source,
      bridgeMessage.target,
      bridgeMessage.message
    );
    await waitFor(() => bridgeMethods.length > 0, 5000);
    expect(bridgeMethods).toEqual(["turn/start"]);
    expect(bridgeThreadIds).toEqual(["thread-2"]);

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
          threadId: "thread-2",
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
    upstreamServer.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
});
