import { afterEach, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  bridgeInternals,
  readPendingBridgeMessages,
} from "../../src/loop/bridge";
import { readRunManifest, resolveRunStorage } from "../../src/loop/run-state";
import type { Agent, Options, RunResult } from "../../src/loop/types";

type PairedLoopModule = typeof import("../../src/loop/paired-loop");
type RunnerModule = typeof import("../../src/loop/runner");

const projectRoot = process.cwd();
const claudeSdkPath = resolve(projectRoot, "src/loop/claude-sdk-server.ts");
const codexAppServerPath = resolve(projectRoot, "src/loop/codex-app-server.ts");
const runnerPath = resolve(projectRoot, "src/loop/runner.ts");

const makeTempHome = (): string =>
  mkdtempSync(join(tmpdir(), "loop-paired-int-"));
const makeOptions = (): Options => ({
  agent: "codex",
  codexModel: "test-model",
  doneSignal: "<done/>",
  format: "raw",
  maxIterations: 1,
  proof: "verify with tests",
});
const makeResult = (parsed: string): RunResult => ({
  combined: "",
  exitCode: 0,
  parsed,
});

let importNonce = 0;
let realRunnerNonce = 0;
let currentRunDir = "";
let lastClaudeSessionId = "";
let lastCodexThreadId = "";
const calls: Array<{ agent: Agent; prompt: string }> = [];
const observedCodexThreadIdsAtTurnStart: string[] = [];
const startAppServerCalls: Array<{
  resumeThreadId?: string;
  threadModel?: string;
}> = [];
let realRunnerModulePromise: Promise<RunnerModule> | undefined;

const loadRealRunner = (): Promise<RunnerModule> => {
  if (!realRunnerModulePromise) {
    realRunnerNonce += 1;
    realRunnerModulePromise = import(
      `../../src/loop/runner.ts?paired-loop-integration-runner=${realRunnerNonce}`
    );
  }
  return realRunnerModulePromise;
};

const loadPairedLoop = (): Promise<PairedLoopModule> => {
  mock.module(claudeSdkPath, () => ({
    getLastClaudeSessionId: () => lastClaudeSessionId,
    hasClaudeSdkProcess: mock(() => false),
    interruptClaudeSdk: mock(() => undefined),
    runClaudeTurn: mock(
      (prompt: string, _opts: Options): Promise<RunResult> => {
        calls.push({ agent: "claude", prompt });
        return Promise.resolve(
          makeResult("Claude acknowledged the bridge message.\n<done/>")
        );
      }
    ),
    startClaudeSdk: mock((_model: string, sessionId?: string) => {
      lastClaudeSessionId = sessionId ?? "claude-session-1";
      return Promise.resolve();
    }),
  }));

  mock.module(codexAppServerPath, () => ({
    CODEX_TRANSPORT_ENV: "CODEX_TRANSPORT",
    CODEX_TRANSPORT_EXEC: "exec",
    CodexAppServerFallbackError: class extends Error {},
    CodexAppServerUnexpectedExitError: class extends Error {},
    getLastCodexThreadId: () => lastCodexThreadId,
    hasAppServerProcess: mock(() => false),
    interruptAppServer: mock(() => undefined),
    runCodexTurn: mock((prompt: string, _opts: Options): Promise<RunResult> => {
      const manifest = readRunManifest(join(currentRunDir, "manifest.json"));
      observedCodexThreadIdsAtTurnStart.push(manifest?.codexThreadId ?? "");
      calls.push({ agent: "codex", prompt });
      bridgeInternals.appendBridgeEvent(currentRunDir, {
        at: "2026-03-22T10:00:00.000Z",
        id: "bridge-1",
        kind: "message",
        message: "Please review the implementation details.",
        source: "codex",
        target: "claude",
      });
      return Promise.resolve(
        makeResult("Codex finished the first turn.\n<done/>")
      );
    }),
    startAppServer: mock(
      (launchOptions?: { resumeThreadId?: string; threadModel?: string }) => {
        startAppServerCalls.push({
          resumeThreadId: launchOptions?.resumeThreadId,
          threadModel: launchOptions?.threadModel,
        });
        if (launchOptions?.threadModel) {
          lastCodexThreadId = "codex-thread-1";
        }
        return Promise.resolve();
      }
    ),
    useAppServer: () => true,
  }));

  mock.module(runnerPath, () => ({
    runAgent: (...args: Parameters<RunnerModule["runAgent"]>) =>
      loadRealRunner().then((module) => module.runAgent(...args)),
    runReviewerAgent: (...args: Parameters<RunnerModule["runReviewerAgent"]>) =>
      loadRealRunner().then((module) => module.runReviewerAgent(...args)),
    startPersistentAgentSession: (
      ...args: Parameters<RunnerModule["startPersistentAgentSession"]>
    ) =>
      loadRealRunner().then((module) =>
        module.startPersistentAgentSession(...args)
      ),
  }));

  importNonce += 1;
  return import(
    `../../src/loop/paired-loop.ts?paired-loop-integration=${importNonce}`
  );
};

afterEach(() => {
  mock.restore();
  calls.length = 0;
  realRunnerModulePromise = undefined;
  realRunnerNonce = 0;
  currentRunDir = "";
  lastClaudeSessionId = "";
  lastCodexThreadId = "";
  observedCodexThreadIdsAtTurnStart.length = 0;
  startAppServerCalls.length = 0;
});

test("runPairedLoop forwards a real bridge message in default paired mode", async () => {
  const module = await loadPairedLoop();
  const home = makeTempHome();
  const originalHome = process.env.HOME;
  const originalRunId = process.env.LOOP_RUN_ID;
  const runId = "41";
  process.env.HOME = home;
  process.env.LOOP_RUN_ID = runId;
  currentRunDir = resolveRunStorage(runId, process.cwd(), home).runDir;

  try {
    await module.runPairedLoop("Ship feature", makeOptions());

    const storage = resolveRunStorage(runId, process.cwd(), home);
    expect(calls).toHaveLength(2);
    expect(calls.map((call) => call.agent)).toEqual(["codex", "claude"]);
    expect(startAppServerCalls[0]?.threadModel).toBe("test-model");
    expect(observedCodexThreadIdsAtTurnStart[0]).toBe("codex-thread-1");
    expect(calls[1]?.prompt).toContain(
      "Message from Codex via the loop bridge:"
    );
    expect(calls[1]?.prompt).toContain(
      "Please review the implementation details."
    );
    expect(readPendingBridgeMessages(storage.runDir)).toHaveLength(0);
    expect(readRunManifest(storage.manifestPath)?.status).toBe("done");
    expect(lastClaudeSessionId).toBe("claude-session-1");
    expect(lastCodexThreadId).toBe("codex-thread-1");
  } finally {
    if (originalHome === undefined) {
      Reflect.deleteProperty(process.env, "HOME");
    } else {
      process.env.HOME = originalHome;
    }
    if (originalRunId === undefined) {
      Reflect.deleteProperty(process.env, "LOOP_RUN_ID");
    } else {
      process.env.LOOP_RUN_ID = originalRunId;
    }
    rmSync(home, { force: true, recursive: true });
  }
});
