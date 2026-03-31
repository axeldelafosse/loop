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
const PROXY_PORT_BASE = 26_000;
const PROXY_PORT_RANGE = 500;
const SESSION_PREFIX = "loop-proxy-e2e";
const TURN_TIMEOUT_MS = 60_000;

const makeTempDir = (): string => mkdtempSync(join(tmpdir(), "loop-proxy-"));

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

const sendTurn = async (
  socket: WebSocket,
  messages: JsonFrame[],
  id: number,
  text: string,
  threadId: string
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
  await waitFor(
    () =>
      messages.some(
        (frame) =>
          frame.id === id &&
          (frame.result as { turn?: { id?: string } } | undefined)?.turn?.id
      ),
    TURN_TIMEOUT_MS,
    `[manual e2e] turn ${id} was not accepted`
  );
};

const main = async (): Promise<void> => {
  const model = parseModel(process.argv.slice(2));
  requireCommand(["tmux", "-V"], "tmux");
  requireCommand(["codex", "--version"], "codex");

  const runDir = makeTempDir();
  const manifestPath = join(runDir, "manifest.json");
  const tmuxSession = `${SESSION_PREFIX}-${Date.now()}`;
  const proxyPort = await findFreePort(PROXY_PORT_BASE, PROXY_PORT_RANGE);
  const cliPath = join(process.cwd(), "src", "cli.ts");
  let proxyTask: Promise<void> | undefined;
  let proxyProcess: ReturnType<typeof spawn> | undefined;
  let tui: WebSocket | undefined;
  const tuiMessages: JsonFrame[] = [];

  console.log(`[manual e2e] using model: ${model}`);
  console.log(`[manual e2e] run dir: ${runDir}`);
  console.log(`[manual e2e] tmux session: ${tmuxSession}`);
  createTmuxSession(tmuxSession);

  try {
    await startAppServer({
      persistentThread: true,
      threadModel: model,
    });
    const initialRemoteUrl = getCodexAppServerUrl();
    const threadId = getLastCodexThreadId();
    if (!(initialRemoteUrl && threadId)) {
      throw new Error("[manual e2e] failed to start the real Codex app-server");
    }

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

    proxyProcess = spawn(
      process.execPath,
      [
        cliPath,
        CODEX_TMUX_PROXY_SUBCOMMAND,
        runDir,
        initialRemoteUrl,
        threadId,
        String(proxyPort),
      ],
      {
        cwd: process.cwd(),
        stdio: ["ignore", "inherit", "inherit"],
      }
    );
    proxyTask = new Promise<void>((resolve, reject) => {
      proxyProcess.on("close", (code) => {
        if (code === 0) {
          resolve();
          return;
        }
        reject(new Error(`[manual e2e] proxy exited with code ${code}`));
      });
      proxyProcess.on("error", reject);
    });
    const proxyUrl = await waitForCodexTmuxProxy(proxyPort);
    tui = new WebSocket(proxyUrl);
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

    tui.send(JSON.stringify({ id: 1, method: "initialize", params: {} }));
    await waitFor(
      () => tuiMessages.some((frame) => frame.id === 1 && frame.result),
      TURN_TIMEOUT_MS,
      "[manual e2e] initialize did not complete"
    );
    console.log("[manual e2e] proxy initialized");

    await sendTurn(
      tui,
      tuiMessages,
      2,
      "Reply with exactly: before-reconnect",
      threadId
    );
    console.log("[manual e2e] first turn accepted");

    await closeAppServer();
    console.log("[manual e2e] closed app-server to force reconnect");

    await startAppServer({
      persistentThread: true,
      resumeThreadId: threadId,
      threadModel: model,
    });
    const resumedRemoteUrl = getCodexAppServerUrl();
    const resumedThreadId = getLastCodexThreadId() || threadId;
    if (!resumedRemoteUrl) {
      throw new Error("[manual e2e] failed to restart the Codex app-server");
    }
    updateRunManifest(manifestPath, (manifest) =>
      manifest
        ? {
            ...manifest,
            codexRemoteUrl: resumedRemoteUrl,
            codexThreadId: resumedThreadId,
          }
        : manifest
    );

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
      resumedThreadId
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
