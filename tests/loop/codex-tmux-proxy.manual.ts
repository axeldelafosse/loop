import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "bun";
import {
  appendBridgeMessage,
  readPendingBridgeMessages,
} from "../../src/loop/bridge-store";
import {
  closeAppServer,
  getCodexAppServerUrl,
  getLastCodexThreadId,
  startAppServer,
} from "../../src/loop/codex-app-server";
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

interface JsonFrame {
  error?: unknown;
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
}

const DEFAULT_MODEL = "gpt-5.4-mini";
const APP_SERVER_RETRY_DELAY_MS = 500;
const APP_SERVER_RETRY_LIMIT = 3;
const PROXY_PORT_RANGE = 500;
const PROXY_PORT_RETRY_LIMIT = 5;
const PROXY_PORT_START = 26_000;
const PROXY_PORT_WINDOW = 20_000;
const SESSION_PREFIX = "loop-proxy-e2e";
const TUI_INITIALIZE_PARAMS = {
  capabilities: { experimentalApi: true },
  clientInfo: {
    name: "loop-proxy-manual-e2e",
    title: "loop-proxy-manual-e2e",
    version: "1.0.0",
  },
};
const TURN_TIMEOUT_MS = 60_000;

const makeTempDir = (): string => mkdtempSync(join(tmpdir(), "loop-proxy-"));

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const extractTurnId = (value: unknown): string | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }
  const turn = isRecord(value.turn) ? value.turn : undefined;
  return asString(value.turnId) ?? asString(turn?.id);
};

const randomProxyPortBase = (): number =>
  PROXY_PORT_START + Math.floor(Math.random() * PROXY_PORT_WINDOW);

const findProxyPort = (): Promise<number> =>
  findFreePort(randomProxyPortBase(), PROXY_PORT_RANGE);

const waitFor = async (
  predicate: () => boolean,
  timeoutMs: number,
  errorMessage: string
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(errorMessage);
};

const describeFrameError = (value: unknown): string => {
  if (typeof value === "string" && value) {
    return value;
  }
  if (isRecord(value) && typeof value.message === "string" && value.message) {
    return value.message;
  }
  return JSON.stringify(value);
};

const waitForResponseFrame = async (
  messages: JsonFrame[],
  id: number,
  label: string,
  isClosed: () => boolean
): Promise<JsonFrame> => {
  await waitFor(
    () => isClosed() || messages.some((frame) => frame.id === id),
    TURN_TIMEOUT_MS,
    `[manual e2e] ${label} did not complete`
  );
  if (isClosed()) {
    throw new Error(
      `[manual e2e] ${label} failed because the tui socket closed`
    );
  }
  const frame = messages.find((entry) => entry.id === id);
  if (!frame) {
    throw new Error(`[manual e2e] ${label} did not complete`);
  }
  if (frame.error) {
    throw new Error(
      `[manual e2e] ${label} failed: ${describeFrameError(frame.error)}`
    );
  }
  return frame;
};

const parseModel = (argv: string[]): string => {
  const modelIndex = argv.indexOf("--model");
  if (modelIndex === -1) {
    return process.env.LOOP_E2E_CODEX_MODEL ?? DEFAULT_MODEL;
  }
  const value = argv[modelIndex + 1];
  if (!value) {
    throw new Error(
      "Usage: bun tests/loop/codex-tmux-proxy.manual.ts --model <model>"
    );
  }
  return value;
};

const requireCommand = (args: string[], label: string): void => {
  const result = spawnSync(args, {
    stderr: "ignore",
    stdout: "ignore",
  });
  if (result.exitCode !== 0) {
    throw new Error(`[manual e2e] missing prerequisite: ${label}`);
  }
};

const createTmuxSession = (name: string): void => {
  const result = spawnSync([
    "tmux",
    "new-session",
    "-d",
    "-s",
    name,
    "sleep 600",
  ]);
  if (result.exitCode !== 0) {
    throw new Error(`[manual e2e] failed to create tmux session "${name}"`);
  }
};

const killTmuxSession = (name: string): void => {
  spawnSync(["tmux", "kill-session", "-t", name], {
    stderr: "ignore",
    stdout: "ignore",
  });
};

const startProxyWithRetries = async (
  runDir: string,
  remoteUrl: string,
  threadId: string
): Promise<{
  proxyProcess: ReturnType<typeof spawn>;
  proxyTask: Promise<void>;
  proxyUrl: string;
}> => {
  let lastError: unknown;
  for (let attempt = 0; attempt < PROXY_PORT_RETRY_LIMIT; attempt += 1) {
    const port = await findProxyPort();
    const proxyProcess = spawn(
      [
        process.execPath,
        join(process.cwd(), "src", "cli.ts"),
        CODEX_TMUX_PROXY_SUBCOMMAND,
        runDir,
        remoteUrl,
        threadId,
        String(port),
      ],
      {
        cwd: process.cwd(),
        env: process.env,
        stderr: "inherit",
        stdin: "ignore",
        stdout: "inherit",
      }
    );
    const proxyTask = proxyProcess.exited.then((code) => {
      if (code === 0) {
        return;
      }
      throw new Error(`[manual e2e] proxy exited with code ${code}`);
    });
    try {
      const proxyUrl = await Promise.race([
        waitForCodexTmuxProxy(port),
        proxyTask.then(() => {
          throw new Error(
            "[manual e2e] codex tmux proxy stopped before becoming ready"
          );
        }),
      ]);
      return { proxyProcess, proxyTask, proxyUrl };
    } catch (error) {
      proxyProcess.kill();
      await Promise.race([
        proxyTask.catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, 1000)),
      ]);
      lastError = error;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("[manual e2e] failed to start the codex tmux proxy");
};

const startManualAppServer = async (
  options: Parameters<typeof startAppServer>[0],
  errorMessage: string
): Promise<{ remoteUrl: string; threadId: string }> => {
  let lastError: unknown = new Error(errorMessage);
  for (let attempt = 0; attempt < APP_SERVER_RETRY_LIMIT; attempt += 1) {
    try {
      await startAppServer(options);
      await waitFor(
        () =>
          Boolean(getCodexAppServerUrl()) && Boolean(getLastCodexThreadId()),
        TURN_TIMEOUT_MS,
        errorMessage
      );
      const remoteUrl = getCodexAppServerUrl();
      const threadId = getLastCodexThreadId();
      if (remoteUrl && threadId) {
        return { remoteUrl, threadId };
      }
      lastError = new Error(errorMessage);
    } catch (error) {
      lastError = error;
    }
    await closeAppServer();
    if (attempt + 1 < APP_SERVER_RETRY_LIMIT) {
      await new Promise((resolve) =>
        setTimeout(resolve, APP_SERVER_RETRY_DELAY_MS)
      );
    }
  }
  throw lastError instanceof Error ? lastError : new Error(errorMessage);
};

const waitForProxyReady = async (proxyUrl: string): Promise<void> => {
  const readyUrl = new URL(proxyUrl);
  readyUrl.pathname = "/readyz";
  readyUrl.protocol = readyUrl.protocol === "wss:" ? "https:" : "http:";
  const deadline = Date.now() + TURN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(readyUrl);
      if (response.ok) {
        return;
      }
    } catch {
      // keep polling
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("[manual e2e] codex tmux proxy did not reconnect");
};

const sendTurn = async (
  socket: WebSocket,
  messages: JsonFrame[],
  id: number,
  text: string,
  threadId: string,
  isClosed: () => boolean
): Promise<void> => {
  socket.send(
    JSON.stringify({
      id,
      method: "turn/start",
      params: {
        input: [
          {
            text,
            text_elements: [],
            type: "text",
          },
        ],
        threadId,
      },
    })
  );
  const frame = await waitForResponseFrame(
    messages,
    id,
    `turn ${id}`,
    isClosed
  );
  const turnId = extractTurnId(frame.result);
  if (!turnId) {
    throw new Error(`[manual e2e] turn ${id} did not return a turn id`);
  }
};

const main = async (): Promise<void> => {
  const model = parseModel(process.argv.slice(2));
  requireCommand(["tmux", "-V"], "tmux");
  requireCommand(["codex", "--version"], "codex");

  const runDir = makeTempDir();
  const manifestPath = join(runDir, "manifest.json");
  const tmuxSession = `${SESSION_PREFIX}-${Date.now()}`;
  let proxyTask: Promise<void> | undefined;
  let proxyProcess: ReturnType<typeof spawn> | undefined;
  let tui: WebSocket | undefined;
  let tuiClosed = false;
  const tuiMessages: JsonFrame[] = [];

  console.log(`[manual e2e] using model: ${model}`);
  console.log(`[manual e2e] run dir: ${runDir}`);
  console.log(`[manual e2e] tmux session: ${tmuxSession}`);
  createTmuxSession(tmuxSession);

  try {
    const initialAppServer = await startManualAppServer(
      {
        persistentThread: true,
        threadModel: model,
      },
      "[manual e2e] failed to start the real Codex app-server"
    );
    const initialRemoteUrl = initialAppServer.remoteUrl;
    const threadId = initialAppServer.threadId;

    writeRunManifest(
      manifestPath,
      createRunManifest({
        claudeSessionId: "manual-e2e",
        codexRemoteUrl: initialRemoteUrl,
        codexThreadId: threadId,
        cwd: process.cwd(),
        mode: "paired",
        pid: process.pid,
        repoId: "manual-e2e",
        runId: "manual-e2e",
        state: "working",
        status: "running",
        tmuxSession,
      })
    );

    const proxyStart = await startProxyWithRetries(
      runDir,
      initialRemoteUrl,
      threadId
    );
    proxyProcess = proxyStart.proxyProcess;
    proxyTask = proxyStart.proxyTask;
    const proxyUrl = proxyStart.proxyUrl;
    tui = new WebSocket(proxyUrl);
    tui.onclose = () => {
      tuiClosed = true;
    };
    tui.onmessage = (event) => {
      tuiMessages.push(JSON.parse(String(event.data)) as JsonFrame);
    };

    await new Promise<void>((resolve, reject) => {
      if (!tui) {
        reject(new Error("[manual e2e] missing tui websocket"));
        return;
      }
      tui.onopen = () => resolve();
      tui.onerror = () =>
        reject(new Error("[manual e2e] failed to open tui websocket"));
    });

    tui.send(
      JSON.stringify({
        id: 1,
        method: "initialize",
        params: TUI_INITIALIZE_PARAMS,
      })
    );
    const initializeFrame = await waitForResponseFrame(
      tuiMessages,
      1,
      "initialize",
      () => tuiClosed
    );
    if (!initializeFrame.result) {
      throw new Error("[manual e2e] initialize did not return a result");
    }
    console.log("[manual e2e] proxy initialized");

    await sendTurn(
      tui,
      tuiMessages,
      2,
      "Reply with exactly: before-reconnect",
      threadId,
      () => tuiClosed
    );
    console.log("[manual e2e] first turn accepted");

    await closeAppServer();
    console.log("[manual e2e] closed app-server to force reconnect");

    const resumedAppServer = await startManualAppServer(
      {
        persistentThread: true,
        resumeThreadId: threadId,
        threadModel: model,
      },
      "[manual e2e] failed to restart the Codex app-server"
    );
    const resumedRemoteUrl = resumedAppServer.remoteUrl;
    const resumedThreadId = resumedAppServer.threadId;
    updateRunManifest(manifestPath, (manifest) =>
      manifest
        ? {
            ...manifest,
            codexRemoteUrl: resumedRemoteUrl,
            codexThreadId: resumedThreadId,
          }
        : manifest
    );
    await waitForProxyReady(proxyUrl);
    console.log("[manual e2e] proxy reconnected");

    appendBridgeMessage(
      runDir,
      "claude",
      "codex",
      "Reply with exactly: bridge-after-reconnect"
    );
    await waitFor(
      () => readPendingBridgeMessages(runDir).length === 0,
      TURN_TIMEOUT_MS,
      "[manual e2e] bridge message was not delivered after reconnect"
    );
    console.log("[manual e2e] bridge delivery survived reconnect");

    await sendTurn(
      tui,
      tuiMessages,
      3,
      "Reply with exactly: after-reconnect",
      resumedThreadId,
      () => tuiClosed
    );
    console.log("[manual e2e] second turn accepted");
    console.log("[manual e2e] success");
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
    proxyProcess?.kill();
    await closeAppServer();
    killTmuxSession(tmuxSession);
    rmSync(runDir, { force: true, recursive: true });
  }
};

if (import.meta.main) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exit(1);
  });
}
