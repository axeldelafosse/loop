import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  createRunManifest,
  resolveRunStorage,
  writeRunManifest,
} from "../../src/loop/run-state";
import {
  runInTmux,
  TMUX_MISSING_ERROR,
  tmuxInternals,
} from "../../src/loop/tmux";
import type { Options } from "../../src/loop/types";

const makeTempHome = (): string => mkdtempSync(join(tmpdir(), "loop-tmux-"));

const makePairedOptions = (overrides: Partial<Options> = {}): Options => ({
  agent: "codex",
  codexModel: "test-model",
  doneSignal: "<done/>",
  format: "raw",
  maxIterations: 1,
  pairedMode: true,
  proof: "verify with tests",
  review: "claudex",
  ...overrides,
});

const withTempHomeRunManifest = async (
  runId: string,
  fn: (home: string) => void | Promise<void>,
  manifestOverrides: Partial<Parameters<typeof createRunManifest>[0]> = {}
): Promise<void> => {
  const home = makeTempHome();
  try {
    const storage = resolveRunStorage(runId, process.cwd(), home);
    writeRunManifest(
      storage.manifestPath,
      createRunManifest(
        {
          cwd: process.cwd(),
          mode: "paired",
          pid: 1234,
          repoId: storage.repoId,
          runId,
          status: "running",
          ...manifestOverrides,
        },
        "2026-03-22T10:00:00.000Z"
      )
    );
    await fn(home);
  } finally {
    rmSync(home, { force: true, recursive: true });
  }
};

test("runInTmux returns false when --tmux is not present", async () => {
  const delegated = await runInTmux(["--proof", "verify"], {
    findBinary: () => true,
  });

  expect(delegated).toBe(false);
});

test("runInTmux returns false when already inside tmux", async () => {
  const delegated = await runInTmux(["--tmux", "--proof", "verify"], {
    env: { TMUX: "1" },
  });

  expect(delegated).toBe(false);
});

test("runInTmux throws install message when tmux is missing", async () => {
  await expect(
    runInTmux(["--tmux", "--proof", "verify"], {
      env: {},
      findBinary: () => false,
    })
  ).rejects.toThrow(TMUX_MISSING_ERROR);
});

test("runInTmux starts detached session and strips --tmux", async () => {
  const calls: string[][] = [];
  const attaches: string[] = [];
  const logs: string[] = [];
  const command =
    "'env' 'LOOP_RUN_BASE=repo' 'LOOP_RUN_ID=1' 'bun' '/repo/src/cli.ts' '--proof' 'verify' 'fix bug'";

  const delegated = await runInTmux(
    ["--tmux", "--proof", "verify", "fix bug"],
    {
      attach: (session: string) => {
        attaches.push(session);
      },
      cwd: "/repo",
      env: {},
      findBinary: () => true,
      getTerminalSize: () => undefined,
      isInteractive: () => true,
      launchArgv: ["bun", "/repo/src/cli.ts"],
      log: (line: string) => {
        logs.push(line);
      },
      spawn: (args: string[]) => {
        calls.push(args);
        return { exitCode: 0, stderr: "" };
      },
    }
  );

  expect(delegated).toBe(true);
  expect(calls[0]).toEqual([
    "tmux",
    "new-session",
    "-d",
    "-s",
    "repo-loop-1",
    "-c",
    "/repo",
    command,
  ]);
  expect(calls[1]).toEqual(["tmux", "has-session", "-t", "=repo-loop-1"]);
  expect(calls[2]).toEqual([
    "tmux",
    "set-window-option",
    "-t",
    "repo-loop-1:0",
    "remain-on-exit",
    "on",
  ]);
  expect(logs[0]).toBe("[loop] starting tmux session...");
  expect(logs).toContain('[loop] started tmux session "repo-loop-1"');
  expect(logs).toContain("[loop] attach with: tmux attach -t repo-loop-1");
  expect(attaches).toEqual(["repo-loop-1"]);
});

test("runInTmux keeps explicit run id in single-agent mode", async () => {
  const calls: string[][] = [];
  let sessionStarted = false;

  const delegated = await runInTmux(
    ["--tmux", "--codex-only", "--run-id", "alpha", "--proof", "verify"],
    {
      cwd: "/repo",
      env: {},
      findBinary: () => true,
      isInteractive: () => false,
      launchArgv: ["bun", "/repo/src/cli.ts"],
      log: (): void => undefined,
      spawn: (args: string[]) => {
        calls.push(args);
        if (args[0] === "tmux" && args[1] === "has-session") {
          return sessionStarted
            ? { exitCode: 0, stderr: "" }
            : { exitCode: 1, stderr: "" };
        }
        if (args[0] === "tmux" && args[1] === "new-session") {
          sessionStarted = true;
        }
        return { exitCode: 0, stderr: "" };
      },
    }
  );

  expect(delegated).toBe(true);
  expect(calls[0]).toEqual(["tmux", "has-session", "-t", "=repo-loop-alpha"]);
  expect(calls[1]).toEqual([
    "tmux",
    "new-session",
    "-d",
    "-s",
    "repo-loop-alpha",
    "-c",
    "/repo",
    "'env' 'LOOP_RUN_BASE=repo' 'LOOP_RUN_ID=alpha' 'bun' '/repo/src/cli.ts' '--codex-only' '--run-id' 'alpha' '--proof' 'verify'",
  ]);
  expect(calls[2]).toEqual(["tmux", "has-session", "-t", "=repo-loop-alpha"]);
  expect(calls[3]).toEqual([
    "tmux",
    "set-window-option",
    "-t",
    "repo-loop-alpha:0",
    "remain-on-exit",
    "on",
  ]);
});

test("runInTmux starts paired tmux panes for Claude and Codex", async () => {
  const calls: string[][] = [];
  const logs: string[] = [];
  const proxyCalls: Array<{
    remoteUrl: string;
    runDir: string;
    threadId: string;
  }> = [];
  const typed: Array<{ pane: string; text: string }> = [];
  const startCalls: Array<{
    agent: string;
    kind?: string;
    sessionId?: string;
  }> = [];
  let sessionStarted = false;
  let manifest = createRunManifest({
    cwd: "/repo",
    mode: "paired",
    pid: 1234,
    repoId: "repo-123",
    runId: "1",
    status: "running",
  });
  const opts = makePairedOptions();
  const codexMcpConfigArgs = ["-c", 'mcp_servers.loop-bridge.command="loop"'];
  const codexRemoteUrl = "ws://127.0.0.1:4500";
  const codexProxyUrl = "ws://127.0.0.1:4600/";
  const storage = {
    manifestPath: "/repo/.loop/runs/1/manifest.json",
    repoId: "repo-123",
    runDir: "/repo/.loop/runs/1",
    runId: "1",
    storageRoot: "/repo/.loop/runs",
    transcriptPath: "/repo/.loop/runs/1/transcript.jsonl",
  };

  const delegated = await runInTmux(
    ["--tmux", "--proof", "verify with tests"],
    {
      capturePane: () => "",
      cwd: "/repo",
      env: {},
      findBinary: () => true,
      getCodexAppServerUrl: () => codexRemoteUrl,
      getLastCodexThreadId: () => "codex-thread-1",
      getTerminalSize: () => ({ columns: 160, rows: 48 }),
      isInteractive: () => false,
      launchArgv: ["bun", "/repo/src/cli.ts"],
      log: (line: string) => {
        logs.push(line);
      },
      makeClaudeSessionId: () => "claude-session-1",
      preparePairedRun: (nextOpts) => {
        nextOpts.codexMcpConfigArgs = codexMcpConfigArgs;
        return { manifest, storage };
      },
      sendKeys: (): void => undefined,
      sendText: (pane: string, text: string) => {
        typed.push({ pane, text });
      },
      sleep: () => Promise.resolve(),
      startCodexProxy: (
        runDir: string,
        remoteUrl: string,
        threadId: string
      ) => {
        proxyCalls.push({ remoteUrl, runDir, threadId });
        return Promise.resolve(codexProxyUrl);
      },
      startPersistentAgentSession: (agent, _opts, sessionId, _launch, kind) => {
        startCalls.push({ agent, kind, sessionId });
        return Promise.resolve(undefined);
      },
      spawn: (args: string[]) => {
        calls.push(args);
        if (args[0] === "tmux" && args[1] === "has-session") {
          return sessionStarted
            ? { exitCode: 0, stderr: "" }
            : { exitCode: 1, stderr: "" };
        }
        if (args[0] === "tmux" && args[1] === "new-session") {
          sessionStarted = true;
        }
        return { exitCode: 0, stderr: "" };
      },
      updateRunManifest: (_path, update) => {
        manifest = update(manifest) ?? manifest;
        return manifest;
      },
    },
    { opts, task: "Ship feature" }
  );

  const env = ["LOOP_RUN_BASE=repo", "LOOP_RUN_ID=1"];
  const claudeChannelServer = tmuxInternals.buildClaudeChannelServerName(
    "1",
    storage.repoId
  );
  const claudeChannelConfig = tmuxInternals.buildClaudeChannelServerConfig(
    ["bun", "/repo/src/cli.ts"],
    storage.runDir
  );
  const claudePrompt = tmuxInternals.buildPeerPrompt(
    "Ship feature",
    opts,
    "claude",
    "1",
    claudeChannelServer
  );
  const claudeCommand = tmuxInternals.buildShellCommand([
    "env",
    ...env,
    ...tmuxInternals.buildClaudeCommand(
      "claude-session-1",
      "opus",
      claudeChannelServer,
      false,
      claudePrompt
    ),
  ]);
  const codexCommand = tmuxInternals.buildShellCommand([
    "env",
    ...env,
    ...tmuxInternals.buildCodexCommand(
      codexProxyUrl,
      "test-model",
      codexMcpConfigArgs,
      tmuxInternals.buildPrimaryPrompt(
        "Ship feature",
        opts,
        "1",
        claudeChannelServer
      )
    ),
  ]);

  expect(delegated).toBe(true);
  expect(proxyCalls).toEqual([
    {
      remoteUrl: codexRemoteUrl,
      runDir: storage.runDir,
      threadId: "codex-thread-1",
    },
  ]);
  expect(startCalls).toEqual([
    { agent: "codex", kind: "work", sessionId: undefined },
  ]);
  expect(calls).toEqual([
    ["tmux", "has-session", "-t", "=repo-loop-1"],
    [
      "claude",
      "mcp",
      "add-json",
      "--scope",
      "local",
      claudeChannelServer,
      claudeChannelConfig,
    ],
    [
      "tmux",
      "new-session",
      "-d",
      "-x",
      "160",
      "-y",
      "48",
      "-s",
      "repo-loop-1",
      "-c",
      "/repo",
      claudeCommand,
    ],
    [
      "tmux",
      "split-window",
      "-h",
      "-t",
      "repo-loop-1:0",
      "-c",
      "/repo",
      codexCommand,
    ],
    ["tmux", "select-layout", "-t", "repo-loop-1:0", "even-horizontal"],
    ["tmux", "select-pane", "-t", "repo-loop-1:0.1"],
    ["tmux", "has-session", "-t", "=repo-loop-1"],
    [
      "tmux",
      "set-window-option",
      "-t",
      "repo-loop-1:0",
      "remain-on-exit",
      "on",
    ],
    ["tmux", "has-session", "-t", "=repo-loop-1"],
  ]);
  expect(typed).toEqual([]);
  expect(logs[0]).toBe("[loop] starting paired tmux workspace...");
  expect(logs).toContain('[loop] started tmux session "repo-loop-1"');
  expect(logs).toContain("[loop] attach with: tmux attach -t repo-loop-1");
  expect(manifest.claudeSessionId).toBe("claude-session-1");
  expect(manifest.codexRemoteUrl).toBe(codexRemoteUrl);
  expect(manifest.codexThreadId).toBe("codex-thread-1");
  expect(manifest.tmuxSession).toBe("repo-loop-1");
});

// -- Host-managed startup (LOOP_HOST_MANAGED_STARTUP=1) ------------------------
const runManagedPairedLaunch = async (
  task: string | undefined,
  resume = false
): Promise<{
  calls: string[][];
  runDir: string;
  sendKeyCalls: number;
  session: string;
}> => {
  const calls: string[][] = [];
  const runDir = mkdtempSync(join(tmpdir(), "loop-managed-"));
  let sessionStarted = false;
  let sendKeyCalls = 0;
  let manifest = createRunManifest({
    cwd: "/repo",
    mode: "paired",
    pid: 1234,
    repoId: "repo-123",
    runId: "7",
    status: "running",
  });
  if (resume) {
    // Both vendor identities present => a managed RESUME (no fresh HOLD).
    manifest = {
      ...manifest,
      claudeSessionId: "claude-session-1",
      codexThreadId: "codex-thread-1",
    };
  }
  const opts = makePairedOptions();
  const storage = {
    manifestPath: join(runDir, "manifest.json"),
    repoId: "repo-123",
    runDir,
    runId: "7",
    storageRoot: "/repo/.loop/runs",
    transcriptPath: join(runDir, "transcript.jsonl"),
  };
  const launch = task ? { opts, task } : { opts };
  await runInTmux(
    ["--tmux", "--proof", "verify with tests"],
    {
      capturePane: () => "",
      cwd: "/repo",
      env: { LOOP_HOST_MANAGED_STARTUP: "1" },
      findBinary: () => true,
      getCodexAppServerUrl: () => "ws://127.0.0.1:4500",
      getLastCodexThreadId: () => "codex-thread-1",
      getTerminalSize: () => ({ columns: 160, rows: 48 }),
      isInteractive: () => false,
      launchArgv: ["bun", "/repo/src/cli.ts"],
      log: (): void => undefined,
      makeClaudeSessionId: () => "claude-session-1",
      preparePairedRun: (nextOpts) => {
        nextOpts.codexMcpConfigArgs = [
          "-c",
          'mcp_servers.loop-bridge.command="loop"',
        ];
        return { manifest, storage };
      },
      sendKeys: (): void => {
        sendKeyCalls += 1;
      },
      sendText: (): void => undefined,
      sleep: () => Promise.resolve(),
      startCodexProxy: () => Promise.resolve("ws://127.0.0.1:4600/"),
      startPersistentAgentSession: () => Promise.resolve(undefined),
      spawn: (args: string[]) => {
        calls.push(args);
        if (args[0] === "tmux" && args[1] === "has-session") {
          return sessionStarted
            ? { exitCode: 0, stderr: "" }
            : { exitCode: 1, stderr: "" };
        }
        if (args[0] === "tmux" && args[1] === "new-session") {
          sessionStarted = true;
        }
        return { exitCode: 0, stderr: "" };
      },
      updateRunManifest: (_path, update) => {
        manifest = update(manifest) ?? manifest;
        return manifest;
      },
    },
    launch
  );
  return { calls, runDir, sendKeyCalls, session: "repo-loop-7" };
};

test("host-managed startup holds, captures at creation, and sends no keys", async () => {
  const { calls, runDir, sendKeyCalls } =
    await runManagedPairedLaunch("Ship feature");
  try {
    const verb = (name: string): string[] | undefined =>
      calls.find((c) => c[0] === "tmux" && c[1] === name);
    const idx = (pred: (c: string[]) => boolean): number =>
      calls.findIndex(pred);

    // Behavior 1: NO synthetic consent keystroke, ever.
    expect(sendKeyCalls).toBe(0);
    expect(calls.some((c) => c[0] === "tmux" && c[1] === "send-keys")).toBe(
      false
    );

    // Behavior 2: new-session + split-window are IDLE (no agent command arg), and
    // remain-on-exit + a pipe-pane capture are armed BEFORE the agent respawns.
    const newSession = verb("new-session");
    expect(newSession?.at(-1)).toBe("/repo"); // last arg is -c cwd, not a command
    const remainIdx = idx(
      (c) => c[1] === "set-window-option" && c.includes("remain-on-exit")
    );
    const pipeClaudeIdx = idx(
      (c) => c[1] === "pipe-pane" && c.includes("=repo-loop-7:0.0")
    );
    const pipeCodexIdx = idx(
      (c) => c[1] === "pipe-pane" && c.includes("=repo-loop-7:0.1")
    );
    const respawnClaudeIdx = idx(
      (c) => c[1] === "respawn-pane" && c.includes("repo-loop-7:0.0")
    );
    const respawnCodexIdx = idx(
      (c) => c[1] === "respawn-pane" && c.includes("repo-loop-7:0.1")
    );
    expect(remainIdx).toBeGreaterThanOrEqual(0);
    expect(pipeClaudeIdx).toBeGreaterThan(remainIdx);
    expect(pipeCodexIdx).toBeGreaterThan(remainIdx);
    expect(respawnClaudeIdx).toBeGreaterThan(pipeClaudeIdx); // capture armed before agent
    expect(respawnCodexIdx).toBeGreaterThan(pipeCodexIdx);
    // The pipe sink is a bounded tail with umask 077 and an atomic .part -> final publish.
    const pipeClaude = calls[pipeClaudeIdx].at(-1) ?? "";
    expect(pipeClaude).toContain("umask 077");
    expect(pipeClaude).toContain("tail -c");
    expect(pipeClaude).toContain("claude.pane.log.part");

    // Behavior 3: each agent is launched with the HOLD bootstrap -- no project task,
    // blocking on the shared barrier -- not the task.
    const respawnClaude = calls[respawnClaudeIdx].at(-1) ?? "";
    const respawnCodex = calls[respawnCodexIdx].at(-1) ?? "";
    expect(respawnClaude).toContain("STARTUP HOLD");
    expect(respawnClaude).toContain(join(runDir, ".loop-managed", "task"));
    expect(respawnClaude).not.toContain("Ship feature"); // the task sentinel is absent
    expect(respawnCodex).toContain("STARTUP HOLD");
    expect(respawnCodex).not.toContain("Ship feature");

    // No task payload exists anywhere under .loop-managed pre-release (the host creates the
    // single shared barrier only after it verifies the launch).
    const managed = join(runDir, ".loop-managed");
    const entries = readdirSync(managed);
    expect(entries).not.toContain("task");
    expect(entries.some((e: string) => e.endsWith(".prompt"))).toBe(false);
  } finally {
    rmSync(runDir, { force: true, recursive: true });
  }
});

test("host-managed resume does not arm startup capture (no lifecycle owner) and sends no keys", async () => {
  // A managed RESUME (both vendor identities) has no host finalizer to detach/delete capture, so
  // arming it would leak a raw *.pane.log past any verdict (PRAS-5). Capture must NOT be armed;
  // the ordinary pane startup is used; the consent keystroke is still suppressed.
  const { calls, sendKeyCalls } = await runManagedPairedLaunch(
    "Ship feature",
    true
  );
  expect(calls.some((c) => c[1] === "pipe-pane")).toBe(false); // capture NOT armed on resume
  expect(calls.some((c) => c[1] === "respawn-pane")).toBe(false); // ordinary pane startup
  expect(sendKeyCalls).toBe(0); // no synthetic consent keystroke
  expect(calls.some((c) => c[1] === "send-keys")).toBe(false);
});

test("sessionExists matches exactly so a prefix-sharing session is not adopted or killed", () => {
  // Emulate tmux target resolution: a bare name prefix/fnmatch-matches; `=name` is exact.
  const existing = new Set(["repo-loop-1x"]); // unrelated session sharing the prefix "repo-loop-1"
  const spawn = (args: string[]) => {
    if (args[0] === "tmux" && args[1] === "has-session") {
      const target = args[3] ?? "";
      const exact = target.startsWith("=");
      const name = exact ? target.slice(1) : target;
      const hit = exact
        ? existing.has(name)
        : [...existing].some((s) => s.startsWith(name));
      return { exitCode: hit ? 0 : 1, stderr: "" };
    }
    return { exitCode: 0, stderr: "" };
  };
  // The guard targets exactly, so our (absent) run is reported NOT existing -> it would create
  // its own session and never adopt/kill the unrelated prefix-sharing "repo-loop-1x".
  expect(tmuxInternals.exactTarget("repo-loop-1")).toBe("=repo-loop-1");
  expect(tmuxInternals.sessionExists("repo-loop-1", spawn)).toBe(false);
  // A bare (pre-fix) target WOULD have wrongly matched the unrelated session.
  expect([...existing].some((s) => s.startsWith("repo-loop-1"))).toBe(true);
  // The real session, once present, is found exactly.
  existing.add("repo-loop-1");
  expect(tmuxInternals.sessionExists("repo-loop-1", spawn)).toBe(true);
});

test("host-managed bootstrap carries no project task or source-task pointer", () => {
  const bootstrap = tmuxInternals.buildManagedBootstrapPrompt(
    makePairedOptions(),
    "claude",
    "7",
    "server-7",
    "/runs/7/.loop-managed/task"
  );
  expect(bootstrap).toContain("STARTUP HOLD");
  expect(bootstrap).toContain("/runs/7/.loop-managed/task"); // the delivery barrier only
  expect(bootstrap).not.toContain("Ship feature");
  expect(bootstrap).not.toContain(".prompt"); // no source-task file pointer
  expect(tmuxInternals.managedTaskBarrierPath("/runs/7")).toBe(
    "/runs/7/.loop-managed/task"
  );
});

test("isHostManagedStartup requires exactly LOOP_HOST_MANAGED_STARTUP=1", () => {
  expect(
    tmuxInternals.isHostManagedStartup({ LOOP_HOST_MANAGED_STARTUP: "1" })
  ).toBe(true);
  for (const value of ["0", "true", "yes", "on", " 1", "", undefined]) {
    expect(
      tmuxInternals.isHostManagedStartup({ LOOP_HOST_MANAGED_STARTUP: value })
    ).toBe(false);
  }
});

test("default startup (env unset) still auto-unblocks and is byte-identical", async () => {
  // A trust prompt on the default path IS auto-answered (the behavior managed mode disables).
  const calls: string[][] = [];
  let sessionStarted = false;
  let sendKeyCalls = 0;
  let manifest = createRunManifest({
    cwd: "/repo",
    mode: "paired",
    pid: 1,
    repoId: "r",
    runId: "9",
    status: "running",
  });
  const opts = makePairedOptions();
  const storage = {
    manifestPath: "/repo/.loop/runs/9/manifest.json",
    repoId: "r",
    runDir: "/repo/.loop/runs/9",
    runId: "9",
    storageRoot: "/repo/.loop/runs",
    transcriptPath: "/repo/.loop/runs/9/transcript.jsonl",
  };
  await runInTmux(
    ["--tmux", "--proof", "verify with tests"],
    {
      capturePane: () => "Is this a project you created or one you trust?",
      cwd: "/repo",
      env: {}, // env UNSET -> default path
      findBinary: () => true,
      getCodexAppServerUrl: () => "ws://127.0.0.1:4500",
      getLastCodexThreadId: () => "t1",
      getTerminalSize: () => ({ columns: 80, rows: 24 }),
      isInteractive: () => false,
      launchArgv: ["bun", "/repo/src/cli.ts"],
      log: (): void => undefined,
      makeClaudeSessionId: () => "cs1",
      preparePairedRun: (nextOpts) => {
        nextOpts.codexMcpConfigArgs = ["-c", "x"];
        return { manifest, storage };
      },
      sendKeys: (): void => {
        sendKeyCalls += 1;
      },
      sendText: (): void => undefined,
      sleep: () => Promise.resolve(),
      startCodexProxy: () => Promise.resolve("ws://127.0.0.1:4600/"),
      startPersistentAgentSession: () => Promise.resolve(undefined),
      spawn: (args: string[]) => {
        calls.push(args);
        if (args[0] === "tmux" && args[1] === "has-session") {
          return sessionStarted
            ? { exitCode: 0, stderr: "" }
            : { exitCode: 1, stderr: "" };
        }
        if (args[0] === "tmux" && args[1] === "new-session") {
          sessionStarted = true;
        }
        return { exitCode: 0, stderr: "" };
      },
      updateRunManifest: (_path, update) => {
        manifest = update(manifest) ?? manifest;
        return manifest;
      },
    },
    { opts, task: "Ship feature" }
  );
  // Default path: new-session carries the agent command (not idle), no pipe-pane, and the
  // visible trust prompt IS auto-answered with Enter (send-keys) -- the exact behavior that
  // host-managed mode disables.
  const newSession = calls.find((c) => c[1] === "new-session");
  expect(newSession?.at(-1)).toContain("claude"); // command on new-session, not idle
  expect(calls.some((c) => c[1] === "pipe-pane")).toBe(false);
  expect(sendKeyCalls).toBeGreaterThan(0);
});

test("runInTmux releases local codex app-server handles after paired handoff", async () => {
  const attaches: string[] = [];
  let released = 0;
  let sessionStarted = false;
  let manifest = createRunManifest({
    cwd: "/repo",
    mode: "paired",
    pid: 1234,
    repoId: "repo-123",
    runId: "1",
    status: "running",
  });
  const opts = makePairedOptions();
  const storage = {
    manifestPath: "/repo/.loop/runs/1/manifest.json",
    repoId: "repo-123",
    runDir: "/repo/.loop/runs/1",
    runId: "1",
    storageRoot: "/repo/.loop/runs",
    transcriptPath: "/repo/.loop/runs/1/transcript.jsonl",
  };

  const delegated = await runInTmux(
    ["--tmux", "--proof", "verify with tests"],
    {
      attach: (session: string) => {
        attaches.push(session);
      },
      capturePane: (pane: string) =>
        pane.endsWith(":0.1") ? "Ctrl+J newline" : "",
      cwd: "/repo",
      env: {},
      findBinary: () => true,
      getCodexAppServerUrl: () => "ws://127.0.0.1:4500",
      getLastCodexThreadId: () => "codex-thread-1",
      isInteractive: () => true,
      launchArgv: ["bun", "/repo/src/cli.ts"],
      log: (): void => undefined,
      makeClaudeSessionId: () => "claude-session-1",
      preparePairedRun: (nextOpts) => {
        nextOpts.codexMcpConfigArgs = [
          "-c",
          'mcp_servers.loop-bridge.command="loop"',
        ];
        return { manifest, storage };
      },
      releasePersistentCodexSession: () => {
        released += 1;
      },
      sendKeys: (): void => undefined,
      sendText: (): void => undefined,
      sleep: () => Promise.resolve(),
      startCodexProxy: () => Promise.resolve("ws://127.0.0.1:4600/"),
      startPersistentAgentSession: () => Promise.resolve(undefined),
      spawn: (args: string[]) => {
        if (args[0] === "tmux" && args[1] === "has-session") {
          return sessionStarted
            ? { exitCode: 0, stderr: "" }
            : { exitCode: 1, stderr: "" };
        }
        if (args[0] === "tmux" && args[1] === "new-session") {
          sessionStarted = true;
        }
        return { exitCode: 0, stderr: "" };
      },
      updateRunManifest: (_path, update) => {
        manifest = update(manifest) ?? manifest;
        return manifest;
      },
    },
    { opts, task: "Ship feature" }
  );

  expect(delegated).toBe(true);
  expect(attaches).toEqual(["repo-loop-1"]);
  expect(released).toBe(1);
});

test("runInTmux closes the local codex app-server when the paired session is gone after attach", async () => {
  const attaches: string[] = [];
  let closed = 0;
  let released = 0;
  let sessionStarted = false;
  let sessionAlive = false;
  let manifest = createRunManifest({
    cwd: "/repo",
    mode: "paired",
    pid: 1234,
    repoId: "repo-123",
    runId: "1",
    status: "running",
  });
  const opts = makePairedOptions();
  const storage = {
    manifestPath: "/repo/.loop/runs/1/manifest.json",
    repoId: "repo-123",
    runDir: "/repo/.loop/runs/1",
    runId: "1",
    storageRoot: "/repo/.loop/runs",
    transcriptPath: "/repo/.loop/runs/1/transcript.jsonl",
  };

  const delegated = await runInTmux(
    ["--tmux", "--proof", "verify with tests"],
    {
      attach: (session: string) => {
        attaches.push(session);
        sessionAlive = false;
      },
      capturePane: (pane: string) =>
        pane.endsWith(":0.1") ? "Ctrl+J newline" : "",
      closePersistentCodexSession: () => {
        closed += 1;
        return Promise.resolve();
      },
      cwd: "/repo",
      env: {},
      findBinary: () => true,
      getCodexAppServerUrl: () => "ws://127.0.0.1:4500",
      getLastCodexThreadId: () => "codex-thread-1",
      isInteractive: () => true,
      launchArgv: ["bun", "/repo/src/cli.ts"],
      log: (): void => undefined,
      makeClaudeSessionId: () => "claude-session-1",
      preparePairedRun: (nextOpts) => {
        nextOpts.codexMcpConfigArgs = [
          "-c",
          'mcp_servers.loop-bridge.command="loop"',
        ];
        return { manifest, storage };
      },
      releasePersistentCodexSession: () => {
        released += 1;
      },
      sendKeys: (): void => undefined,
      sendText: (): void => undefined,
      sleep: () => Promise.resolve(),
      startCodexProxy: () => Promise.resolve("ws://127.0.0.1:4600/"),
      startPersistentAgentSession: () => Promise.resolve(undefined),
      spawn: (args: string[]) => {
        if (args[0] === "tmux" && args[1] === "has-session") {
          return sessionAlive
            ? { exitCode: 0, stderr: "" }
            : { exitCode: 1, stderr: "" };
        }
        if (args[0] === "tmux" && args[1] === "new-session") {
          sessionStarted = true;
          sessionAlive = true;
        }
        if (
          !sessionStarted &&
          args[0] === "tmux" &&
          args[1] === "split-window"
        ) {
          throw new Error("split before new-session");
        }
        return { exitCode: 0, stderr: "" };
      },
      updateRunManifest: (_path, update) => {
        manifest = update(manifest) ?? manifest;
        return manifest;
      },
    },
    { opts, task: "Ship feature" }
  );

  expect(delegated).toBe(true);
  expect(attaches).toEqual(["repo-loop-1"]);
  expect(closed).toBe(1);
  expect(released).toBe(0);
});

test("runInTmux starts paired interactive tmux panes without a task", async () => {
  const calls: string[][] = [];
  const typed: Array<{ pane: string; text: string }> = [];
  let sessionStarted = false;
  let manifest = createRunManifest({
    cwd: "/repo",
    mode: "paired",
    pid: 1234,
    repoId: "repo-123",
    runId: "1",
    status: "running",
  });
  const opts = makePairedOptions({ proof: "" });
  const storage = {
    manifestPath: "/repo/.loop/runs/1/manifest.json",
    repoId: "repo-123",
    runDir: "/repo/.loop/runs/1",
    runId: "1",
    storageRoot: "/repo/.loop/runs",
    transcriptPath: "/repo/.loop/runs/1/transcript.jsonl",
  };

  const delegated = await runInTmux(
    ["--tmux"],
    {
      capturePane: () => "",
      cwd: "/repo",
      env: {},
      findBinary: () => true,
      getCodexAppServerUrl: () => "ws://127.0.0.1:4500",
      getLastCodexThreadId: () => "codex-thread-1",
      isInteractive: () => false,
      launchArgv: ["bun", "/repo/src/cli.ts"],
      log: (): void => undefined,
      makeClaudeSessionId: () => "claude-session-1",
      preparePairedRun: (nextOpts) => {
        nextOpts.codexMcpConfigArgs = [
          "-c",
          'mcp_servers.loop-bridge.command="loop"',
        ];
        return { manifest, storage };
      },
      sendKeys: (): void => undefined,
      sendText: (pane: string, text: string) => {
        typed.push({ pane, text });
      },
      sleep: () => Promise.resolve(),
      startCodexProxy: () => Promise.resolve("ws://127.0.0.1:4600/"),
      startPersistentAgentSession: () => Promise.resolve(undefined),
      spawn: (args: string[]) => {
        calls.push(args);
        if (args[0] === "tmux" && args[1] === "has-session") {
          return sessionStarted
            ? { exitCode: 0, stderr: "" }
            : { exitCode: 1, stderr: "" };
        }
        if (args[0] === "tmux" && args[1] === "new-session") {
          sessionStarted = true;
        }
        return { exitCode: 0, stderr: "" };
      },
      updateRunManifest: (_path, update) => {
        manifest = update(manifest) ?? manifest;
        return manifest;
      },
    },
    { opts }
  );

  expect(delegated).toBe(true);
  expect(calls[0]).toEqual(["tmux", "has-session", "-t", "=repo-loop-1"]);
  const env = ["LOOP_RUN_BASE=repo", "LOOP_RUN_ID=1"];
  const claudeChannelServer = tmuxInternals.buildClaudeChannelServerName(
    "1",
    storage.repoId
  );
  const claudePrompt = tmuxInternals.buildInteractivePeerPrompt(
    opts,
    "claude",
    "1",
    claudeChannelServer
  );
  const claudeCommand = tmuxInternals.buildShellCommand([
    "env",
    ...env,
    ...tmuxInternals.buildClaudeCommand(
      "claude-session-1",
      "opus",
      claudeChannelServer,
      false,
      claudePrompt
    ),
  ]);
  expect(calls[2]).toEqual([
    "tmux",
    "new-session",
    "-d",
    "-s",
    "repo-loop-1",
    "-c",
    "/repo",
    claudeCommand,
  ]);
  const codexCommand = tmuxInternals.buildShellCommand([
    "env",
    ...env,
    ...tmuxInternals.buildCodexCommand(
      "ws://127.0.0.1:4600/",
      "test-model",
      ["-c", 'mcp_servers.loop-bridge.command="loop"'],
      tmuxInternals.buildInteractivePrimaryPrompt(
        opts,
        "1",
        claudeChannelServer
      )
    ),
  ]);
  expect(calls[3]).toEqual([
    "tmux",
    "split-window",
    "-h",
    "-t",
    "repo-loop-1:0",
    "-c",
    "/repo",
    codexCommand,
  ]);
  expect(typed).toEqual([]);
  expect(manifest.tmuxSession).toBe("repo-loop-1");
});

test("runInTmux keeps the no-prompt Claude startup wait bounded", async () => {
  const sleeps: number[] = [];
  let sessionStarted = false;
  const manifest = createRunManifest({
    cwd: "/repo",
    mode: "paired",
    pid: 1234,
    repoId: "repo-123",
    runId: "1",
    status: "running",
  });
  const storage = {
    manifestPath: "/repo/.loop/runs/1/manifest.json",
    repoId: "repo-123",
    runDir: "/repo/.loop/runs/1",
    runId: "1",
    storageRoot: "/repo/.loop/runs",
    transcriptPath: "/repo/.loop/runs/1/transcript.jsonl",
  };

  await runInTmux(
    ["--tmux"],
    {
      capturePane: () => "",
      cwd: "/repo",
      env: {},
      findBinary: () => true,
      getCodexAppServerUrl: () => "ws://127.0.0.1:4500",
      getLastCodexThreadId: () => "codex-thread-1",
      isInteractive: () => false,
      launchArgv: ["bun", "/repo/src/cli.ts"],
      log: (): void => undefined,
      makeClaudeSessionId: () => "claude-session-1",
      preparePairedRun: (nextOpts) => {
        nextOpts.codexMcpConfigArgs = [
          "-c",
          'mcp_servers.loop-bridge.command="loop"',
        ];
        return { manifest, storage };
      },
      sendKeys: (): void => undefined,
      sendText: (): void => undefined,
      sleep: (ms: number) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
      startCodexProxy: () => Promise.resolve("ws://127.0.0.1:4600/"),
      startPersistentAgentSession: () => Promise.resolve(undefined),
      spawn: (args: string[]) => {
        if (args[0] === "tmux" && args[1] === "has-session") {
          return sessionStarted
            ? { exitCode: 0, stderr: "" }
            : { exitCode: 1, stderr: "" };
        }
        if (args[0] === "tmux" && args[1] === "new-session") {
          sessionStarted = true;
        }
        return { exitCode: 0, stderr: "" };
      },
      updateRunManifest: (_path, update) => update(manifest),
    },
    { opts: makePairedOptions({ proof: "" }) }
  );

  expect(sleeps).toEqual([250, 250, 250, 250, 250, 250, 250]);
});

test("tmux prompts keep the paired review workflow explicit", () => {
  const opts = makePairedOptions();
  const claudeChannelServer = tmuxInternals.buildClaudeChannelServerName(
    "1",
    "repo-123"
  );
  const primaryPrompt = tmuxInternals.buildPrimaryPrompt(
    "Ship feature",
    opts,
    "1",
    claudeChannelServer
  );
  const peerPrompt = tmuxInternals.buildPeerPrompt(
    "Ship feature",
    opts,
    "claude",
    "1",
    claudeChannelServer
  );

  expect(primaryPrompt).toContain("Agent-to-agent pair programming");
  expect(primaryPrompt).toContain("You are the main worker.");
  expect(primaryPrompt).toContain(
    "your own review and the peer review both pass"
  );
  expect(primaryPrompt).toContain(
    "create a draft PR or send a follow-up commit to the existing PR"
  );
  expect(primaryPrompt).not.toContain("Wait briefly if it arrives");
  expect(primaryPrompt).toContain('"mcp__loop_bridge__send_message"');
  expect(primaryPrompt).toContain("worktree isolation");
  expect(peerPrompt).toContain("You are the reviewer/support agent.");
  expect(peerPrompt).toContain("Do not take over the task or create the PR");
  expect(peerPrompt).toContain("Wait for Codex to send you a targeted request");
  expect(peerPrompt).not.toContain('"reply"');
  expect(peerPrompt).toContain(
    'Use "mcp__loop-bridge-repo-123-1__send_message" with target: "codex" for Codex-facing messages, including replies to inbound Codex channel messages; do not send Codex-facing responses as a human-facing message.'
  );
  expect(primaryPrompt).not.toContain("mcp__loop-bridge-repo-123-1__ prefix");
  expect(peerPrompt).not.toContain("mcp__loop-bridge-repo-123-1__ prefix");
  expect(peerPrompt).toContain('"mcp__loop-bridge-repo-123-1__bridge_status"');
  expect(peerPrompt).toContain(
    '"mcp__loop-bridge-repo-123-1__receive_messages"'
  );
});

test("interactive tmux prompts tell both agents to wait for the human", () => {
  const opts = makePairedOptions({ proof: "" });
  const claudeChannelServer = tmuxInternals.buildClaudeChannelServerName(
    "1",
    "repo-123"
  );
  const primaryPrompt = tmuxInternals.buildInteractivePrimaryPrompt(
    opts,
    "1",
    claudeChannelServer
  );
  const peerPrompt = tmuxInternals.buildInteractivePeerPrompt(
    opts,
    "claude",
    "1",
    claudeChannelServer
  );

  expect(primaryPrompt).toContain("Agent-to-agent pair programming");
  expect(primaryPrompt).toContain("No task has been assigned yet.");
  expect(primaryPrompt).toContain("Wait for the first human task");
  expect(primaryPrompt).toContain("If the human asks for plan mode");
  expect(primaryPrompt).toContain("ask Claude for a plan review");
  expect(primaryPrompt).toContain("ask the human to review the plan");
  expect(primaryPrompt).toContain('"mcp__loop_bridge__send_message"');
  expect(primaryPrompt).toContain("worktree isolation");
  expect(peerPrompt).toContain("No task has been assigned yet.");
  expect(peerPrompt).toContain(
    "If Codex asks for a plan review, review PLAN.md only"
  );
  expect(peerPrompt).toContain("Wait for Codex to provide a concrete task");
  expect(peerPrompt).toContain("human clearly assigns you separate work");
  expect(peerPrompt).not.toContain('"reply"');
  expect(peerPrompt).toContain(
    'Use "mcp__loop-bridge-repo-123-1__send_message" with target: "codex" for Codex-facing messages, including replies to inbound Codex channel messages; do not send Codex-facing responses as a human-facing message.'
  );
  expect(peerPrompt).not.toContain("mcp__loop-bridge-repo-123-1__ prefix");
  expect(peerPrompt).toContain('"mcp__loop-bridge-repo-123-1__bridge_status"');
  expect(peerPrompt).toContain(
    '"mcp__loop-bridge-repo-123-1__receive_messages"'
  );
  expect(peerPrompt).toContain(
    "If you are answering Codex, use the bridge tools instead of a human-facing reply."
  );
  expect(primaryPrompt).not.toContain("mcp__loop-bridge-repo-123-1__ prefix");
  expect(peerPrompt).not.toContain("mcp__loop-bridge-repo-123-1__ prefix");
});

test("runInTmux auto-confirms Claude startup prompts in paired mode", async () => {
  const calls: string[][] = [];
  const keyCalls: Array<{ keys: string[]; pane: string }> = [];
  const typed: Array<{ pane: string; text: string }> = [];
  let sessionStarted = false;
  let pollCount = 0;
  const devChannelsPrompt = [
    "WARNING: Loading development channels",
    "",
    "--dangerously-load-development-channels is for local channel development only.",
    "",
    "1. I am using this for local development",
  ].join("\n");
  const bypassPrompt =
    "WARNING: Claude Code running in Bypass Permissions mode";
  const opts = makePairedOptions();
  const manifest = createRunManifest({
    cwd: "/repo",
    mode: "paired",
    pid: 1234,
    repoId: "repo-123",
    runId: "1",
    status: "running",
  });
  const storage = {
    manifestPath: "/repo/.loop/runs/1/manifest.json",
    repoId: "repo-123",
    runDir: "/repo/.loop/runs/1",
    runId: "1",
    storageRoot: "/repo/.loop/runs",
    transcriptPath: "/repo/.loop/runs/1/transcript.jsonl",
  };

  await runInTmux(
    ["--tmux", "--proof", "verify with tests"],
    {
      capturePane: () => {
        pollCount += 1;
        if (pollCount === 1) {
          return devChannelsPrompt;
        }
        if (pollCount === 2) {
          return `${devChannelsPrompt}\n\n${bypassPrompt}`;
        }
        return "";
      },
      cwd: "/repo",
      env: {},
      findBinary: () => true,
      getCodexAppServerUrl: () => "ws://127.0.0.1:4500",
      getLastCodexThreadId: () => "codex-thread-1",
      isInteractive: () => false,
      launchArgv: ["bun", "/repo/src/cli.ts"],
      log: (): void => undefined,
      makeClaudeSessionId: () => "claude-session-1",
      preparePairedRun: (nextOpts) => {
        nextOpts.codexMcpConfigArgs = [
          "-c",
          'mcp_servers.loop-bridge.command="loop"',
        ];
        return { manifest, storage };
      },
      sendKeys: (pane: string, keys: string[]) => {
        keyCalls.push({ keys, pane });
      },
      sendText: (pane: string, text: string) => {
        typed.push({ pane, text });
      },
      sleep: () => Promise.resolve(),
      startCodexProxy: () => Promise.resolve("ws://127.0.0.1:4600/"),
      startPersistentAgentSession: () => Promise.resolve(undefined),
      spawn: (args: string[]) => {
        calls.push(args);
        if (args[0] === "tmux" && args[1] === "has-session") {
          return sessionStarted
            ? { exitCode: 0, stderr: "" }
            : { exitCode: 1, stderr: "" };
        }
        if (args[0] === "tmux" && args[1] === "new-session") {
          sessionStarted = true;
        }
        return { exitCode: 0, stderr: "" };
      },
      updateRunManifest: (_path, update) => update(manifest),
    },
    { opts, task: "Ship feature" }
  );

  expect(keyCalls[0]).toEqual({ keys: ["Enter"], pane: "repo-loop-1:0.0" });
  expect(keyCalls[1]).toEqual({
    keys: ["Down"],
    pane: "repo-loop-1:0.0",
  });
  expect(keyCalls[2]).toEqual({
    keys: ["Enter"],
    pane: "repo-loop-1:0.0",
  });
  expect(
    keyCalls.some(
      (call) =>
        call.pane === "repo-loop-1:0.0" &&
        call.keys.length === 1 &&
        call.keys[0] === "Enter"
    )
  ).toBe(true);
  expect(
    keyCalls.some(
      (call) =>
        call.pane === "repo-loop-1:0.1" &&
        call.keys.length === 1 &&
        call.keys[0] === "Enter"
    )
  ).toBe(false);
  expect(typed).toEqual([]);
});

test("runInTmux confirms wrapped Claude dev-channel prompts", async () => {
  const keyCalls: Array<{ keys: string[]; pane: string }> = [];
  let sessionStarted = false;
  let pollCount = 0;
  const devChannelsPrompt = [
    "WARNING: Loading development channels",
    "",
    "--dangerously-load-development-channels is for local channel development only.",
    "",
    "1. I am using this for local",
    "development",
  ].join("\n");
  const manifest = createRunManifest({
    cwd: "/repo",
    mode: "paired",
    pid: 1234,
    repoId: "repo-123",
    runId: "1",
    status: "running",
  });
  const storage = {
    manifestPath: "/repo/.loop/runs/1/manifest.json",
    repoId: "repo-123",
    runDir: "/repo/.loop/runs/1",
    runId: "1",
    storageRoot: "/repo/.loop/runs",
    transcriptPath: "/repo/.loop/runs/1/transcript.jsonl",
  };

  await runInTmux(
    ["--tmux", "--proof", "verify with tests"],
    {
      capturePane: () => {
        pollCount += 1;
        if (pollCount === 1) {
          return devChannelsPrompt;
        }
        return "";
      },
      cwd: "/repo",
      env: {},
      findBinary: () => true,
      getCodexAppServerUrl: () => "ws://127.0.0.1:4500",
      getLastCodexThreadId: () => "codex-thread-1",
      isInteractive: () => false,
      launchArgv: ["bun", "/repo/src/cli.ts"],
      log: (): void => undefined,
      makeClaudeSessionId: () => "claude-session-1",
      preparePairedRun: (nextOpts) => {
        nextOpts.codexMcpConfigArgs = [
          "-c",
          'mcp_servers.loop-bridge.command="loop"',
        ];
        return { manifest, storage };
      },
      sendKeys: (pane: string, keys: string[]) => {
        keyCalls.push({ keys, pane });
      },
      sendText: (): void => undefined,
      sleep: () => Promise.resolve(),
      startCodexProxy: () => Promise.resolve("ws://127.0.0.1:4600/"),
      startPersistentAgentSession: () => Promise.resolve(undefined),
      spawn: (args: string[]) => {
        if (args[0] === "tmux" && args[1] === "has-session") {
          return sessionStarted
            ? { exitCode: 0, stderr: "" }
            : { exitCode: 1, stderr: "" };
        }
        if (args[0] === "tmux" && args[1] === "new-session") {
          sessionStarted = true;
        }
        return { exitCode: 0, stderr: "" };
      },
      updateRunManifest: (_path, update) => update(manifest),
    },
    { opts: makePairedOptions(), task: "Ship feature" }
  );

  expect(keyCalls).toContainEqual({
    keys: ["Enter"],
    pane: "repo-loop-1:0.0",
  });
});

test("runInTmux catches a delayed Claude dev-channel prompt", async () => {
  const keyCalls: Array<{ keys: string[]; pane: string }> = [];
  let sessionStarted = false;
  let pollCount = 0;
  const devChannelsPrompt = [
    "WARNING: Loading development channels",
    "",
    "--dangerously-load-development-channels is for local channel development only.",
    "",
    "1. I am using this for local development",
  ].join("\n");
  const manifest = createRunManifest({
    cwd: "/repo",
    mode: "paired",
    pid: 1234,
    repoId: "repo-123",
    runId: "1",
    status: "running",
  });
  const storage = {
    manifestPath: "/repo/.loop/runs/1/manifest.json",
    repoId: "repo-123",
    runDir: "/repo/.loop/runs/1",
    runId: "1",
    storageRoot: "/repo/.loop/runs",
    transcriptPath: "/repo/.loop/runs/1/transcript.jsonl",
  };

  await runInTmux(
    ["--tmux", "--proof", "verify with tests"],
    {
      capturePane: () => {
        pollCount += 1;
        return pollCount === 5 ? devChannelsPrompt : "";
      },
      cwd: "/repo",
      env: {},
      findBinary: () => true,
      getCodexAppServerUrl: () => "ws://127.0.0.1:4500",
      getLastCodexThreadId: () => "codex-thread-1",
      isInteractive: () => false,
      launchArgv: ["bun", "/repo/src/cli.ts"],
      log: (): void => undefined,
      makeClaudeSessionId: () => "claude-session-1",
      preparePairedRun: (nextOpts) => {
        nextOpts.codexMcpConfigArgs = [
          "-c",
          'mcp_servers.loop-bridge.command="loop"',
        ];
        return { manifest, storage };
      },
      sendKeys: (pane: string, keys: string[]) => {
        keyCalls.push({ keys, pane });
      },
      sendText: (): void => undefined,
      sleep: () => Promise.resolve(),
      startCodexProxy: () => Promise.resolve("ws://127.0.0.1:4600/"),
      startPersistentAgentSession: () => Promise.resolve(undefined),
      spawn: (args: string[]) => {
        if (args[0] === "tmux" && args[1] === "has-session") {
          return sessionStarted
            ? { exitCode: 0, stderr: "" }
            : { exitCode: 1, stderr: "" };
        }
        if (args[0] === "tmux" && args[1] === "new-session") {
          sessionStarted = true;
        }
        return { exitCode: 0, stderr: "" };
      },
      updateRunManifest: (_path, update) => update(manifest),
    },
    { opts: makePairedOptions(), task: "Ship feature" }
  );

  expect(keyCalls).toContainEqual({
    keys: ["Enter"],
    pane: "repo-loop-1:0.0",
  });
});

test("runInTmux confirms the current Claude bypass prompt wording", async () => {
  const keyCalls: Array<{ keys: string[]; pane: string }> = [];
  let sessionStarted = false;
  let pollCount = 0;
  const bypassPrompt = [
    "Bypass Permissions mode",
    "",
    "1. No, exit",
    "2. Yes, I accept",
  ].join("\n");
  const manifest = createRunManifest({
    cwd: "/repo",
    mode: "paired",
    pid: 1234,
    repoId: "repo-123",
    runId: "1",
    status: "running",
  });
  const storage = {
    manifestPath: "/repo/.loop/runs/1/manifest.json",
    repoId: "repo-123",
    runDir: "/repo/.loop/runs/1",
    runId: "1",
    storageRoot: "/repo/.loop/runs",
    transcriptPath: "/repo/.loop/runs/1/transcript.jsonl",
  };

  await runInTmux(
    ["--tmux", "--proof", "verify with tests"],
    {
      capturePane: () => {
        pollCount += 1;
        if (pollCount === 1) {
          return bypassPrompt;
        }
        return "";
      },
      cwd: "/repo",
      env: {},
      findBinary: () => true,
      getCodexAppServerUrl: () => "ws://127.0.0.1:4500",
      getLastCodexThreadId: () => "codex-thread-1",
      isInteractive: () => false,
      launchArgv: ["bun", "/repo/src/cli.ts"],
      log: (): void => undefined,
      makeClaudeSessionId: () => "claude-session-1",
      preparePairedRun: (nextOpts) => {
        nextOpts.codexMcpConfigArgs = [
          "-c",
          'mcp_servers.loop-bridge.command="loop"',
        ];
        return { manifest, storage };
      },
      sendKeys: (pane: string, keys: string[]) => {
        keyCalls.push({ keys, pane });
      },
      sendText: (): void => undefined,
      sleep: () => Promise.resolve(),
      startCodexProxy: () => Promise.resolve("ws://127.0.0.1:4600/"),
      startPersistentAgentSession: () => Promise.resolve(undefined),
      spawn: (args: string[]) => {
        if (args[0] === "tmux" && args[1] === "has-session") {
          return sessionStarted
            ? { exitCode: 0, stderr: "" }
            : { exitCode: 1, stderr: "" };
        }
        if (args[0] === "tmux" && args[1] === "new-session") {
          sessionStarted = true;
        }
        return { exitCode: 0, stderr: "" };
      },
      updateRunManifest: (_path, update) => update(manifest),
    },
    { opts: makePairedOptions(), task: "Ship feature" }
  );

  expect(keyCalls).toContainEqual({
    keys: ["Down"],
    pane: "repo-loop-1:0.0",
  });
  expect(keyCalls).toContainEqual({
    keys: ["Enter"],
    pane: "repo-loop-1:0.0",
  });
});

test("runInTmux still confirms Claude trust prompts in paired mode", async () => {
  const keyCalls: Array<{ keys: string[]; pane: string }> = [];
  let sessionStarted = false;
  let pollCount = 0;
  const manifest = createRunManifest({
    cwd: "/repo",
    mode: "paired",
    pid: 1234,
    repoId: "repo-123",
    runId: "1",
    status: "running",
  });
  const storage = {
    manifestPath: "/repo/.loop/runs/1/manifest.json",
    repoId: "repo-123",
    runDir: "/repo/.loop/runs/1",
    runId: "1",
    storageRoot: "/repo/.loop/runs",
    transcriptPath: "/repo/.loop/runs/1/transcript.jsonl",
  };

  await runInTmux(
    ["--tmux", "--proof", "verify with tests"],
    {
      capturePane: () => {
        pollCount += 1;
        if (pollCount === 1) {
          return "Is this a project you created or one you trust?";
        }
        return "";
      },
      cwd: "/repo",
      env: {},
      findBinary: () => true,
      getCodexAppServerUrl: () => "ws://127.0.0.1:4500",
      getLastCodexThreadId: () => "codex-thread-1",
      isInteractive: () => false,
      launchArgv: ["bun", "/repo/src/cli.ts"],
      log: (): void => undefined,
      makeClaudeSessionId: () => "claude-session-1",
      preparePairedRun: (nextOpts) => {
        nextOpts.codexMcpConfigArgs = [
          "-c",
          'mcp_servers.loop-bridge.command="loop"',
        ];
        return { manifest, storage };
      },
      sendKeys: (pane: string, keys: string[]) => {
        keyCalls.push({ keys, pane });
      },
      sendText: (): void => undefined,
      sleep: () => Promise.resolve(),
      startCodexProxy: () => Promise.resolve("ws://127.0.0.1:4600/"),
      startPersistentAgentSession: () => Promise.resolve(undefined),
      spawn: (args: string[]) => {
        if (args[0] === "tmux" && args[1] === "has-session") {
          return sessionStarted
            ? { exitCode: 0, stderr: "" }
            : { exitCode: 1, stderr: "" };
        }
        if (args[0] === "tmux" && args[1] === "new-session") {
          sessionStarted = true;
        }
        return { exitCode: 0, stderr: "" };
      },
      updateRunManifest: (_path, update) => update(manifest),
    },
    { opts: makePairedOptions(), task: "Ship feature" }
  );

  expect(keyCalls).toContainEqual({
    keys: ["Enter"],
    pane: "repo-loop-1:0.0",
  });
});

test("runInTmux still catches a delayed Claude trust prompt", async () => {
  const keyCalls: Array<{ keys: string[]; pane: string }> = [];
  let sessionStarted = false;
  let pollCount = 0;
  const manifest = createRunManifest({
    cwd: "/repo",
    mode: "paired",
    pid: 1234,
    repoId: "repo-123",
    runId: "1",
    status: "running",
  });
  const storage = {
    manifestPath: "/repo/.loop/runs/1/manifest.json",
    repoId: "repo-123",
    runDir: "/repo/.loop/runs/1",
    runId: "1",
    storageRoot: "/repo/.loop/runs",
    transcriptPath: "/repo/.loop/runs/1/transcript.jsonl",
  };

  await runInTmux(
    ["--tmux", "--proof", "verify with tests"],
    {
      capturePane: () => {
        pollCount += 1;
        return pollCount === 4
          ? "Is this a project you created or one you trust?"
          : "";
      },
      cwd: "/repo",
      env: {},
      findBinary: () => true,
      getCodexAppServerUrl: () => "ws://127.0.0.1:4500",
      getLastCodexThreadId: () => "codex-thread-1",
      isInteractive: () => false,
      launchArgv: ["bun", "/repo/src/cli.ts"],
      log: (): void => undefined,
      makeClaudeSessionId: () => "claude-session-1",
      preparePairedRun: (nextOpts) => {
        nextOpts.codexMcpConfigArgs = [
          "-c",
          'mcp_servers.loop-bridge.command="loop"',
        ];
        return { manifest, storage };
      },
      sendKeys: (pane: string, keys: string[]) => {
        keyCalls.push({ keys, pane });
      },
      sendText: (): void => undefined,
      sleep: () => Promise.resolve(),
      startCodexProxy: () => Promise.resolve("ws://127.0.0.1:4600/"),
      startPersistentAgentSession: () => Promise.resolve(undefined),
      spawn: (args: string[]) => {
        if (args[0] === "tmux" && args[1] === "has-session") {
          return sessionStarted
            ? { exitCode: 0, stderr: "" }
            : { exitCode: 1, stderr: "" };
        }
        if (args[0] === "tmux" && args[1] === "new-session") {
          sessionStarted = true;
        }
        return { exitCode: 0, stderr: "" };
      },
      updateRunManifest: (_path, update) => update(manifest),
    },
    { opts: makePairedOptions(), task: "Ship feature" }
  );

  expect(keyCalls).toContainEqual({
    keys: ["Enter"],
    pane: "repo-loop-1:0.0",
  });
});

test("runInTmux reopens paired tmux panes without replaying the task", async () => {
  const calls: string[][] = [];
  const typed: Array<{ pane: string; text: string }> = [];
  let sessionStarted = false;
  const opts = makePairedOptions();
  const codexMcpConfigArgs = ["-c", 'mcp_servers.loop-bridge.command="loop"'];
  const codexRemoteUrl = "ws://127.0.0.1:4500";
  const codexProxyUrl = "ws://127.0.0.1:4600/";
  const manifest = createRunManifest({
    claudeSessionId: "claude-session-1",
    codexThreadId: "codex-thread-1",
    cwd: "/repo",
    mode: "paired",
    pid: 1234,
    repoId: "repo-123",
    runId: "alpha",
    status: "running",
  });
  const storage = {
    manifestPath: "/repo/.loop/runs/alpha/manifest.json",
    repoId: "repo-123",
    runDir: "/repo/.loop/runs/alpha",
    runId: "alpha",
    storageRoot: "/repo/.loop/runs",
    transcriptPath: "/repo/.loop/runs/alpha/transcript.jsonl",
  };

  const delegated = await runInTmux(
    ["--tmux", "--run-id", "alpha", "--proof", "verify with tests"],
    {
      capturePane: () => "",
      cwd: "/repo",
      env: {},
      findBinary: () => true,
      getCodexAppServerUrl: () => codexRemoteUrl,
      getLastCodexThreadId: () => "",
      isInteractive: () => false,
      launchArgv: ["bun", "/repo/src/cli.ts"],
      log: (): void => undefined,
      makeClaudeSessionId: () => "unused",
      preparePairedRun: (nextOpts) => {
        nextOpts.codexMcpConfigArgs = codexMcpConfigArgs;
        return { manifest, storage };
      },
      sendKeys: (): void => undefined,
      sendText: (pane: string, text: string) => {
        typed.push({ pane, text });
      },
      sleep: () => Promise.resolve(),
      startCodexProxy: () => Promise.resolve(codexProxyUrl),
      startPersistentAgentSession: () => Promise.resolve(undefined),
      spawn: (args: string[]) => {
        calls.push(args);
        if (args[0] === "tmux" && args[1] === "has-session") {
          return sessionStarted
            ? { exitCode: 0, stderr: "" }
            : { exitCode: 1, stderr: "" };
        }
        if (args[0] === "tmux" && args[1] === "new-session") {
          sessionStarted = true;
        }
        return { exitCode: 0, stderr: "" };
      },
      updateRunManifest: (_path, update) => update(manifest),
    },
    { opts, task: "Ship feature" }
  );

  const env = ["LOOP_RUN_BASE=repo", "LOOP_RUN_ID=alpha"];
  const claudeChannelServer = tmuxInternals.buildClaudeChannelServerName(
    "alpha",
    storage.repoId
  );
  const claudeChannelConfig = tmuxInternals.buildClaudeChannelServerConfig(
    ["bun", "/repo/src/cli.ts"],
    storage.runDir
  );
  const claudeCommand = tmuxInternals.buildShellCommand([
    "env",
    ...env,
    ...tmuxInternals.buildClaudeCommand(
      "claude-session-1",
      "opus",
      claudeChannelServer,
      true
    ),
  ]);
  const codexCommand = tmuxInternals.buildShellCommand([
    "env",
    ...env,
    ...tmuxInternals.buildCodexCommand(
      codexProxyUrl,
      "test-model",
      codexMcpConfigArgs
    ),
  ]);

  expect(delegated).toBe(true);
  expect(calls[1]).toEqual([
    "claude",
    "mcp",
    "add-json",
    "--scope",
    "local",
    claudeChannelServer,
    claudeChannelConfig,
  ]);
  expect(calls[2]).toEqual([
    "tmux",
    "new-session",
    "-d",
    "-s",
    "repo-loop-alpha",
    "-c",
    "/repo",
    claudeCommand,
  ]);
  expect(calls[3]).toEqual([
    "tmux",
    "split-window",
    "-h",
    "-t",
    "repo-loop-alpha:0",
    "-c",
    "/repo",
    codexCommand,
  ]);
  expect(typed).toEqual([]);
});

test("runInTmux resolves paired run id through an existing manifest", async () => {
  await withTempHomeRunManifest("alpha", async (home) => {
    const calls: string[][] = [];
    const attaches: string[] = [];
    let sessionStarted = false;
    const runBase = tmuxInternals.sanitizeBase(basename(process.cwd()));
    const session = tmuxInternals.buildRunName(runBase, "alpha");
    const command = tmuxInternals.buildShellCommand([
      "env",
      `LOOP_RUN_BASE=${runBase}`,
      "LOOP_RUN_ID=alpha",
      "bun",
      "/repo/src/cli.ts",
      "--run-id",
      "alpha",
      "--proof",
      "verify",
    ]);

    const delegated = await runInTmux(
      ["--tmux", "--run-id", "alpha", "--proof", "verify"],
      {
        attach: (session: string) => {
          attaches.push(session);
        },
        cwd: process.cwd(),
        env: { HOME: home },
        findBinary: () => true,
        getTerminalSize: () => undefined,
        isInteractive: () => true,
        launchArgv: ["bun", "/repo/src/cli.ts"],
        log: (): void => undefined,
        spawn: (args: string[]) => {
          calls.push(args);
          if (args[0] === "tmux" && args[1] === "has-session") {
            return sessionStarted
              ? { exitCode: 0, stderr: "" }
              : { exitCode: 1, stderr: "" };
          }
          if (args[0] === "tmux" && args[1] === "new-session") {
            sessionStarted = true;
          }
          return { exitCode: 0, stderr: "" };
        },
      }
    );

    expect(delegated).toBe(true);
    expect(calls).toEqual([
      ["tmux", "has-session", "-t", `=${session}`],
      [
        "tmux",
        "new-session",
        "-d",
        "-s",
        session,
        "-c",
        process.cwd(),
        command,
      ],
      ["tmux", "has-session", "-t", `=${session}`],
      [
        "tmux",
        "set-window-option",
        "-t",
        `${session}:0`,
        "remain-on-exit",
        "on",
      ],
    ]);
    expect(attaches).toEqual([session]);
  });
});

test("runInTmux rejects unknown run id before starting tmux session", async () => {
  const calls: string[][] = [];
  const home = makeTempHome();

  try {
    await expect(
      runInTmux(["--tmux", "--run-id", "typo", "--proof", "verify"], {
        cwd: process.cwd(),
        env: { HOME: home },
        findBinary: () => true,
        log: (): void => undefined,
        spawn: (args: string[]) => {
          calls.push(args);
          return { exitCode: 0, stderr: "" };
        },
      })
    ).rejects.toThrow('[loop] paired run "typo" does not exist');
    expect(calls).toEqual([]);
  } finally {
    rmSync(home, { force: true, recursive: true });
  }
});

test("runInTmux honors paired run resume from --session", async () => {
  await withTempHomeRunManifest("alpha", async (home) => {
    const calls: string[][] = [];
    let sessionStarted = false;
    const runBase = tmuxInternals.sanitizeBase(basename(process.cwd()));
    const session = tmuxInternals.buildRunName(runBase, "alpha");
    const command = tmuxInternals.buildShellCommand([
      "env",
      `LOOP_RUN_BASE=${runBase}`,
      "LOOP_RUN_ID=alpha",
      "bun",
      "/repo/src/cli.ts",
      "--session",
      "alpha",
      "--proof",
      "verify",
    ]);

    const delegated = await runInTmux(
      ["--tmux", "--session", "alpha", "--proof", "verify"],
      {
        cwd: process.cwd(),
        env: { HOME: home },
        findBinary: () => true,
        isInteractive: () => false,
        launchArgv: ["bun", "/repo/src/cli.ts"],
        log: (): void => undefined,
        spawn: (args: string[]) => {
          calls.push(args);
          if (args[0] === "tmux" && args[1] === "has-session") {
            return sessionStarted
              ? { exitCode: 0, stderr: "" }
              : { exitCode: 1, stderr: "" };
          }
          if (args[0] === "tmux" && args[1] === "new-session") {
            sessionStarted = true;
          }
          return { exitCode: 0, stderr: "" };
        },
      }
    );

    expect(delegated).toBe(true);
    expect(calls).toEqual([
      ["tmux", "has-session", "-t", `=${session}`],
      [
        "tmux",
        "new-session",
        "-d",
        "-s",
        session,
        "-c",
        process.cwd(),
        command,
      ],
      ["tmux", "has-session", "-t", `=${session}`],
      [
        "tmux",
        "set-window-option",
        "-t",
        `${session}:0`,
        "remain-on-exit",
        "on",
      ],
    ]);
  });
});

test("runInTmux resolves paired resume from a worktree using git common dir", async () => {
  const calls: string[][] = [];
  let sessionStarted = false;
  const runBase = "repo";
  const session = tmuxInternals.buildRunName(runBase, "alpha");
  const command = tmuxInternals.buildShellCommand([
    "env",
    `LOOP_RUN_BASE=${runBase}`,
    "LOOP_RUN_ID=alpha",
    "bun",
    "/repo/src/cli.ts",
    "--run-id",
    "alpha",
    "--proof",
    "verify",
  ]);

  const delegated = await runInTmux(
    ["--tmux", "--run-id", "alpha", "--proof", "verify"],
    {
      cwd: "/repo-loop-alpha",
      env: {},
      findBinary: () => true,
      isInteractive: () => false,
      launchArgv: ["bun", "/repo/src/cli.ts"],
      log: (): void => undefined,
      runGit: (_cwd: string, args: string[]) => {
        if (
          args.join(" ") === "rev-parse --path-format=absolute --git-common-dir"
        ) {
          return { exitCode: 0, stderr: "", stdout: "/repo/.git\n" };
        }
        return { exitCode: 1, stderr: "", stdout: "" };
      },
      spawn: (args: string[]) => {
        calls.push(args);
        if (args[0] === "tmux" && args[1] === "has-session") {
          return sessionStarted
            ? { exitCode: 0, stderr: "" }
            : { exitCode: 1, stderr: "" };
        }
        if (args[0] === "tmux" && args[1] === "new-session") {
          sessionStarted = true;
        }
        return { exitCode: 0, stderr: "" };
      },
    }
  );

  expect(delegated).toBe(true);
  expect(calls).toEqual([
    ["tmux", "has-session", "-t", `=${session}`],
    [
      "tmux",
      "new-session",
      "-d",
      "-s",
      session,
      "-c",
      "/repo-loop-alpha",
      command,
    ],
    ["tmux", "has-session", "-t", `=${session}`],
    ["tmux", "set-window-option", "-t", `${session}:0`, "remain-on-exit", "on"],
  ]);
});

test("runInTmux strips a worktree suffix when git metadata is unavailable", async () => {
  const calls: string[][] = [];
  let sessionStarted = false;
  const runBase = "repo";
  const session = tmuxInternals.buildRunName(runBase, "alpha");
  const command = tmuxInternals.buildShellCommand([
    "env",
    `LOOP_RUN_BASE=${runBase}`,
    "LOOP_RUN_ID=alpha",
    "bun",
    "/repo/src/cli.ts",
    "--run-id",
    "alpha",
    "--proof",
    "verify",
  ]);

  const delegated = await runInTmux(
    ["--tmux", "--run-id", "alpha", "--proof", "verify"],
    {
      cwd: "/repo-loop-alpha",
      env: {},
      findBinary: () => true,
      isInteractive: () => false,
      launchArgv: ["bun", "/repo/src/cli.ts"],
      log: (): void => undefined,
      runGit: (
        _cwd: string,
        _args: string[]
      ): { exitCode: number; stderr: string; stdout: string } => ({
        exitCode: 1,
        stderr: "",
        stdout: "",
      }),
      spawn: (args: string[]) => {
        calls.push(args);
        if (args[0] === "tmux" && args[1] === "has-session") {
          return sessionStarted
            ? { exitCode: 0, stderr: "" }
            : { exitCode: 1, stderr: "" };
        }
        if (args[0] === "tmux" && args[1] === "new-session") {
          sessionStarted = true;
        }
        return { exitCode: 0, stderr: "" };
      },
    }
  );

  expect(delegated).toBe(true);
  expect(calls).toEqual([
    ["tmux", "has-session", "-t", `=${session}`],
    [
      "tmux",
      "new-session",
      "-d",
      "-s",
      session,
      "-c",
      "/repo-loop-alpha",
      command,
    ],
    ["tmux", "has-session", "-t", `=${session}`],
    ["tmux", "set-window-option", "-t", `${session}:0`, "remain-on-exit", "on"],
  ]);
});

test("runInTmux resolves raw stored session ids from --session", async () => {
  await withTempHomeRunManifest(
    "alpha",
    async (home) => {
      const calls: string[][] = [];
      let sessionStarted = false;
      const runBase = tmuxInternals.sanitizeBase(basename(process.cwd()));
      const session = tmuxInternals.buildRunName(runBase, "alpha");
      const command = tmuxInternals.buildShellCommand([
        "env",
        `LOOP_RUN_BASE=${runBase}`,
        "LOOP_RUN_ID=alpha",
        "bun",
        "/repo/src/cli.ts",
        "--session",
        "claude-session-1",
        "--proof",
        "verify",
      ]);

      const delegated = await runInTmux(
        ["--tmux", "--session", "claude-session-1", "--proof", "verify"],
        {
          cwd: process.cwd(),
          env: { HOME: home },
          findBinary: () => true,
          isInteractive: () => false,
          launchArgv: ["bun", "/repo/src/cli.ts"],
          log: (): void => undefined,
          spawn: (args: string[]) => {
            calls.push(args);
            if (args[0] === "tmux" && args[1] === "has-session") {
              return sessionStarted
                ? { exitCode: 0, stderr: "" }
                : { exitCode: 1, stderr: "" };
            }
            if (args[0] === "tmux" && args[1] === "new-session") {
              sessionStarted = true;
            }
            return { exitCode: 0, stderr: "" };
          },
        }
      );

      expect(delegated).toBe(true);
      expect(calls).toEqual([
        ["tmux", "has-session", "-t", `=${session}`],
        [
          "tmux",
          "new-session",
          "-d",
          "-s",
          session,
          "-c",
          process.cwd(),
          command,
        ],
        ["tmux", "has-session", "-t", `=${session}`],
        [
          "tmux",
          "set-window-option",
          "-t",
          `${session}:0`,
          "remain-on-exit",
          "on",
        ],
      ]);
    },
    { claudeSessionId: "claude-session-1" }
  );
});

test("runInTmux ignores an unresolved raw session id in paired mode", async () => {
  const home = makeTempHome();
  const calls: string[][] = [];
  let sessionStarted = false;
  const runBase = tmuxInternals.sanitizeBase(basename(process.cwd()));
  const command = tmuxInternals.buildShellCommand([
    "env",
    `LOOP_RUN_BASE=${runBase}`,
    "LOOP_RUN_ID=1",
    "bun",
    "/repo/src/cli.ts",
    "--session",
    "claude-session-raw",
    "--proof",
    "verify",
  ]);

  try {
    const delegated = await runInTmux(
      ["--tmux", "--session", "claude-session-raw", "--proof", "verify"],
      {
        cwd: process.cwd(),
        env: { HOME: home },
        findBinary: () => true,
        isInteractive: () => false,
        launchArgv: ["bun", "/repo/src/cli.ts"],
        log: (): void => undefined,
        spawn: (args: string[]) => {
          calls.push(args);
          if (args[0] === "tmux" && args[1] === "has-session") {
            return sessionStarted
              ? { exitCode: 0, stderr: "" }
              : { exitCode: 1, stderr: "" };
          }
          if (args[0] === "tmux" && args[1] === "new-session") {
            sessionStarted = true;
          }
          return { exitCode: 0, stderr: "" };
        },
      }
    );

    expect(delegated).toBe(true);
    expect(calls).toEqual([
      [
        "tmux",
        "new-session",
        "-d",
        "-s",
        `${runBase}-loop-1`,
        "-c",
        process.cwd(),
        command,
      ],
      ["tmux", "has-session", "-t", `=${runBase}-loop-1`],
      [
        "tmux",
        "set-window-option",
        "-t",
        `${runBase}-loop-1:0`,
        "remain-on-exit",
        "on",
      ],
    ]);
  } finally {
    rmSync(home, { force: true, recursive: true });
  }
});

test("runInTmux keeps raw --session values in single-agent mode", async () => {
  const onlyModes = ["--claude-only", "--codex-only"] as const;

  for (const onlyMode of onlyModes) {
    const calls: string[][] = [];
    let sessionStarted = false;
    const command = tmuxInternals.buildShellCommand([
      "env",
      "LOOP_RUN_BASE=repo",
      "LOOP_RUN_ID=1",
      "bun",
      "/repo/src/cli.ts",
      onlyMode,
      "--session",
      "claude-session-1",
      "--proof",
      "verify",
    ]);

    const delegated = await runInTmux(
      [
        "--tmux",
        onlyMode,
        "--session",
        "claude-session-1",
        "--proof",
        "verify",
      ],
      {
        cwd: "/repo",
        env: {},
        findBinary: () => true,
        isInteractive: () => false,
        launchArgv: ["bun", "/repo/src/cli.ts"],
        log: (): void => undefined,
        spawn: (args: string[]) => {
          calls.push(args);
          if (args[0] === "tmux" && args[1] === "has-session") {
            return sessionStarted
              ? { exitCode: 0, stderr: "" }
              : { exitCode: 1, stderr: "" };
          }
          if (args[0] === "tmux" && args[1] === "new-session") {
            sessionStarted = true;
          }
          return { exitCode: 0, stderr: "" };
        },
      }
    );

    expect(delegated).toBe(true);
    expect(calls).toEqual([
      [
        "tmux",
        "new-session",
        "-d",
        "-s",
        "repo-loop-1",
        "-c",
        "/repo",
        command,
      ],
      ["tmux", "has-session", "-t", "=repo-loop-1"],
      [
        "tmux",
        "set-window-option",
        "-t",
        "repo-loop-1:0",
        "remain-on-exit",
        "on",
      ],
    ]);
  }
});

test("runInTmux increments session index on conflicts", async () => {
  const calls: string[][] = [];
  const delegated = await runInTmux(["--tmux", "--proof", "verify"], {
    attach: (): void => undefined,
    cwd: "/repo",
    env: {},
    findBinary: () => true,
    isInteractive: () => false,
    spawn: (args: string[]) => {
      calls.push(args);
      const name = args[4];
      if (name === "repo-loop-1") {
        return { exitCode: 1, stderr: "duplicate session: repo-loop-1" };
      }
      if (args[0] === "tmux" && args[1] === "has-session") {
        return { exitCode: 0, stderr: "" };
      }
      return { exitCode: 0, stderr: "" };
    },
  });

  expect(delegated).toBe(true);
  expect(calls[0]?.[4]).toBe("repo-loop-1");
  expect(calls[1]?.[4]).toBe("repo-loop-2");
  expect(calls[2]).toEqual(["tmux", "has-session", "-t", "=repo-loop-2"]);
  expect(calls[3]).toEqual([
    "tmux",
    "set-window-option",
    "-t",
    "repo-loop-2:0",
    "remain-on-exit",
    "on",
  ]);
});

test("runInTmux surfaces tmux startup errors", async () => {
  await expect(
    runInTmux(["--tmux", "--proof", "verify"], {
      env: {},
      findBinary: () => true,
      spawn: () => ({ exitCode: 1, stderr: "boom" }),
    })
  ).rejects.toThrow("Failed to start tmux session: boom");
});

test("runInTmux removes the Claude bridge server when paired tmux startup fails", async () => {
  const calls: string[][] = [];
  let manifest = createRunManifest({
    cwd: "/repo",
    mode: "paired",
    pid: 1234,
    repoId: "repo-123",
    runId: "1",
    status: "running",
  });
  const opts = makePairedOptions();
  const storage = {
    manifestPath: "/repo/.loop/runs/1/manifest.json",
    repoId: "repo-123",
    runDir: "/repo/.loop/runs/1",
    runId: "1",
    storageRoot: "/repo/.loop/runs",
    transcriptPath: "/repo/.loop/runs/1/transcript.jsonl",
  };

  await expect(
    runInTmux(
      ["--tmux", "--proof", "verify with tests"],
      {
        capturePane: () => "",
        cwd: "/repo",
        env: {},
        findBinary: () => true,
        getCodexAppServerUrl: () => "ws://127.0.0.1:4500",
        getLastCodexThreadId: () => "codex-thread-1",
        isInteractive: () => false,
        launchArgv: ["bun", "/repo/src/cli.ts"],
        log: (): void => undefined,
        makeClaudeSessionId: () => "claude-session-1",
        preparePairedRun: (nextOpts) => {
          nextOpts.codexMcpConfigArgs = [
            "-c",
            'mcp_servers.loop-bridge.command="loop"',
          ];
          return { manifest, storage };
        },
        sendKeys: (): void => undefined,
        sendText: (): void => undefined,
        sleep: () => Promise.resolve(),
        startCodexProxy: () => Promise.resolve("ws://127.0.0.1:4600/"),
        startPersistentAgentSession: () => Promise.resolve(undefined),
        spawn: (args: string[]) => {
          calls.push(args);
          if (args[0] === "tmux" && args[1] === "has-session") {
            return { exitCode: 1, stderr: "" };
          }
          if (args[0] === "tmux" && args[1] === "new-session") {
            return { exitCode: 1, stderr: "boom" };
          }
          return { exitCode: 0, stderr: "" };
        },
        updateRunManifest: (_path, update) => {
          manifest = update(manifest) ?? manifest;
          return manifest;
        },
      },
      { opts, task: "Ship feature" }
    )
  ).rejects.toThrow("Failed to start tmux session: boom");

  expect(calls).toContainEqual([
    "claude",
    "mcp",
    "add-json",
    "--scope",
    "local",
    tmuxInternals.buildClaudeChannelServerName("1", "repo-123"),
    tmuxInternals.buildClaudeChannelServerConfig(
      ["bun", "/repo/src/cli.ts"],
      storage.runDir
    ),
  ]);
  expect(calls).toContainEqual([
    "claude",
    "mcp",
    "remove",
    "--scope",
    "local",
    tmuxInternals.buildClaudeChannelServerName("1", "repo-123"),
  ]);
  expect(
    calls.some((args) => args[0] === "tmux" && args[1] === "kill-session")
  ).toBe(false);
});

test("runInTmux skips auto-attach for non-interactive sessions", async () => {
  const attaches: string[] = [];

  const delegated = await runInTmux(["--tmux", "--proof", "verify"], {
    attach: (session: string) => {
      attaches.push(session);
    },
    cwd: "/repo",
    env: {},
    findBinary: () => true,
    isInteractive: () => false,
    spawn: () => ({ exitCode: 0, stderr: "" }),
  });

  expect(delegated).toBe(true);
  expect(attaches).toEqual([]);
});

test("runInTmux reports when tmux session exits before attach", async () => {
  const runBase = tmuxInternals.sanitizeBase(basename(process.cwd()));
  await expect(
    runInTmux(["--tmux", "--proof", "verify"], {
      env: {},
      findBinary: () => true,
      spawn: (args: string[]) => {
        if (args[0] === "tmux" && args[1] === "has-session") {
          return { exitCode: 1, stderr: "session not found" };
        }
        return { exitCode: 0, stderr: "" };
      },
    })
  ).rejects.toThrow(
    `tmux session "${tmuxInternals.buildRunName(runBase, 1)}" exited before attach.`
  );
});

test("tmux internals strip --tmux from forwarded args", () => {
  expect(tmuxInternals.stripTmuxFlag(["--tmux", "--proof", "verify"])).toEqual([
    "--proof",
    "verify",
  ]);
});

test("tmux internals build launch argv from exec path", () => {
  expect(
    tmuxInternals.buildLaunchArgv(
      ["/usr/local/bin/bun", "src/cli.ts", "--tmux", "--proof", "verify"],
      "/usr/local/bin/bun"
    )
  ).toEqual(["/usr/local/bin/bun", `${process.cwd()}/src/cli.ts`]);
});

test("tmux internals build launch argv for bun-compiled binary", () => {
  expect(
    tmuxInternals.buildLaunchArgv(
      [
        "/usr/local/bin/bun",
        "/$bunfs/root/loop",
        "--tmux",
        "--proof",
        "verify",
      ],
      "/private/tmp/loop"
    )
  ).toEqual(["/private/tmp/loop"]);
});

test("tmux internals build launch argv for executable with no script arg", () => {
  expect(
    tmuxInternals.buildLaunchArgv(
      ["/usr/local/bin/loop", "--tmux", "--proof", "verify"],
      "/usr/local/bin/bun"
    )
  ).toEqual(["/usr/local/bin/loop"]);
});

test("tmux internals build launch argv for installed executable", () => {
  expect(
    tmuxInternals.buildLaunchArgv(
      [
        "/Users/lume/.local/bin/loop",
        "build launch command",
        "--tmux",
        "--proof",
        "verify",
      ],
      "/Users/lume/.local/bin/loop"
    )
  ).toEqual(["/Users/lume/.local/bin/loop"]);
});

test("tmux internals build launch argv when bun executes installed binary", () => {
  expect(
    tmuxInternals.buildLaunchArgv(
      [
        "/usr/local/bin/bun",
        "/Users/lume/.local/bin/loop",
        "--tmux",
        "--proof",
        "verify",
      ],
      "/usr/local/bin/bun"
    )
  ).toEqual(["/usr/local/bin/bun", "/Users/lume/.local/bin/loop"]);
});

test("tmux internals quote single quotes safely", () => {
  expect(tmuxInternals.quoteShellArg("a'b")).toBe("'a'\\''b'");
});

test("tmux internals build shell command with escaping", () => {
  expect(tmuxInternals.buildShellCommand(["loop", "--prompt", "a'b c"])).toBe(
    "'loop' '--prompt' 'a'\\''b c'"
  );
});

test("tmux internals unref detached helper processes", () => {
  const calls: Array<{ argv: string[]; options: Record<string, unknown> }> = [];
  let unrefCount = 0;

  tmuxInternals.spawnDetachedProcess(
    ["loop", "__codex-tmux-proxy"],
    { HOME: "/tmp/home" },
    (argv, options) => {
      calls.push({
        argv: argv.map((value) => String(value)),
        options: options as Record<string, unknown>,
      });
      return {
        unref: () => {
          unrefCount += 1;
        },
      } as ReturnType<typeof import("bun").spawn>;
    }
  );

  expect(calls).toEqual([
    {
      argv: ["loop", "__codex-tmux-proxy"],
      options: {
        detached: process.platform !== "win32",
        env: { HOME: "/tmp/home" },
        stderr: "ignore",
        stdin: "ignore",
        stdout: "ignore",
      },
    },
  ]);
  expect(unrefCount).toBe(1);
});

test("tmux internals launch Claude in bypass mode", () => {
  expect(
    tmuxInternals.buildClaudeCommand(
      "claude-session-1",
      "opus",
      "loop-bridge-1",
      false
    )
  ).toContain("--dangerously-skip-permissions");
  expect(
    tmuxInternals.buildClaudeCommand(
      "claude-session-1",
      "opus",
      "loop-bridge-1",
      false
    )
  ).not.toContain("--permission-mode");
});

test("tmux internals build run names", () => {
  expect(tmuxInternals.buildRunName("repo", 3)).toBe("repo-loop-3");
});

test("tmux internals detect session conflicts", () => {
  expect(tmuxInternals.isSessionConflict("duplicate session: loop-1")).toBe(
    true
  );
  expect(tmuxInternals.isSessionConflict("already exists")).toBe(true);
  expect(tmuxInternals.isSessionConflict("boom")).toBe(false);
});

test("tmux internals sanitize run base names", () => {
  expect(tmuxInternals.sanitizeBase("My Repo")).toBe("my-repo");
});
