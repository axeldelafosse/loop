import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
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
  expect(calls[1]).toEqual(["tmux", "has-session", "-t", "repo-loop-1"]);
  expect(calls[2]).toEqual([
    "tmux",
    "set-window-option",
    "-t",
    "repo-loop-1:0",
    "remain-on-exit",
    "on",
  ]);
  expect(logs[0]).toBe(
    "[loop] starting tmux session. This can take a few seconds..."
  );
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
  expect(calls[0]).toEqual(["tmux", "has-session", "-t", "repo-loop-alpha"]);
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
  expect(calls[2]).toEqual(["tmux", "has-session", "-t", "repo-loop-alpha"]);
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
  const claudeChannelServer = tmuxInternals.buildClaudeChannelServerName("1");
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
      false
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
    ["tmux", "has-session", "-t", "repo-loop-1"],
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
    ["tmux", "has-session", "-t", "repo-loop-1"],
    [
      "tmux",
      "set-window-option",
      "-t",
      "repo-loop-1:0",
      "remain-on-exit",
      "on",
    ],
  ]);
  const typedByPane = new Map<string, string[]>();
  for (const entry of typed) {
    const values = typedByPane.get(entry.pane) ?? [];
    values.push(entry.text);
    typedByPane.set(entry.pane, values);
  }
  expect(typedByPane.get("repo-loop-1:0.0")?.join("\n")).toBe(
    tmuxInternals.buildPeerPrompt("Ship feature", opts, "claude")
  );
  expect(typedByPane.get("repo-loop-1:0.1")?.join("\n")).toBe(
    tmuxInternals.buildPrimaryPrompt("Ship feature", opts)
  );
  expect(logs[0]).toBe(
    "[loop] starting paired tmux workspace. This can take a few seconds..."
  );
  expect(logs).toContain('[loop] started tmux session "repo-loop-1"');
  expect(logs).toContain("[loop] attach with: tmux attach -t repo-loop-1");
  expect(manifest.claudeSessionId).toBe("claude-session-1");
  expect(manifest.codexRemoteUrl).toBe(codexRemoteUrl);
  expect(manifest.codexThreadId).toBe("codex-thread-1");
  expect(manifest.tmuxSession).toBe("repo-loop-1");
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
  expect(calls[0]).toEqual(["tmux", "has-session", "-t", "repo-loop-1"]);
  const typedByPane = new Map<string, string[]>();
  for (const entry of typed) {
    const values = typedByPane.get(entry.pane) ?? [];
    values.push(entry.text);
    typedByPane.set(entry.pane, values);
  }
  expect(typedByPane.get("repo-loop-1:0.0")?.join("\n")).toBe(
    tmuxInternals.buildInteractivePeerPrompt(opts, "claude")
  );
  expect(typedByPane.get("repo-loop-1:0.1")?.join("\n")).toBe(
    tmuxInternals.buildInteractivePrimaryPrompt(opts)
  );
  expect(manifest.tmuxSession).toBe("repo-loop-1");
});

test("tmux prompts keep the paired review workflow explicit", () => {
  const opts = makePairedOptions();
  const primaryPrompt = tmuxInternals.buildPrimaryPrompt("Ship feature", opts);
  const peerPrompt = tmuxInternals.buildPeerPrompt(
    "Ship feature",
    opts,
    "claude"
  );

  expect(primaryPrompt).toContain("You are the main worker.");
  expect(primaryPrompt).toContain(
    "If either your own review or the peer review finds an issue"
  );
  expect(primaryPrompt).toContain("create a draft PR");
  expect(primaryPrompt).toContain("ready signal");
  expect(primaryPrompt).toContain("worktree isolation");
  expect(peerPrompt).toContain("You are the reviewer/support agent.");
  expect(peerPrompt).toContain("Do not take over the task or create the PR");
  expect(peerPrompt).toContain("Reviewer ready.");
});

test("interactive tmux prompts tell both agents to wait for the human", () => {
  const opts = makePairedOptions({ proof: "" });
  const primaryPrompt = tmuxInternals.buildInteractivePrimaryPrompt(opts);
  const peerPrompt = tmuxInternals.buildInteractivePeerPrompt(opts, "claude");

  expect(primaryPrompt).toContain("No task has been assigned yet.");
  expect(primaryPrompt).toContain(
    "Wait for the human to provide the first task"
  );
  expect(primaryPrompt).toContain("worktree isolation");
  expect(peerPrompt).toContain("No task has been assigned yet.");
  expect(peerPrompt).toContain("Reviewer ready. No task yet.");
  expect(peerPrompt).toContain("wait for the human");
});

test("runInTmux auto-confirms Claude startup prompts in paired mode", async () => {
  const calls: string[][] = [];
  const keyCalls: Array<{ keys: string[]; pane: string }> = [];
  const typed: Array<{ pane: string; text: string }> = [];
  let sessionStarted = false;
  let pollCount = 0;
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
          return "Is this a project you created or one you trust?";
        }
        if (pollCount === 2) {
          return "WARNING: Claude Code running in Bypass Permissions mode";
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
    keys: ["Down", "Enter"],
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
  ).toBe(true);
  const typedByPane = new Map<string, string[]>();
  for (const entry of typed) {
    const values = typedByPane.get(entry.pane) ?? [];
    values.push(entry.text);
    typedByPane.set(entry.pane, values);
  }
  expect(typedByPane.get("repo-loop-1:0.0")?.join("\n")).toBe(
    tmuxInternals.buildPeerPrompt("Ship feature", opts, "claude")
  );
  expect(typedByPane.get("repo-loop-1:0.1")?.join("\n")).toBe(
    tmuxInternals.buildPrimaryPrompt("Ship feature", opts)
  );
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
  const claudeChannelServer =
    tmuxInternals.buildClaudeChannelServerName("alpha");
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
      ["tmux", "has-session", "-t", session],
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
      ["tmux", "has-session", "-t", session],
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
      ["tmux", "has-session", "-t", session],
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
      ["tmux", "has-session", "-t", session],
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
    ["tmux", "has-session", "-t", session],
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
    ["tmux", "has-session", "-t", session],
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
    ["tmux", "has-session", "-t", session],
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
    ["tmux", "has-session", "-t", session],
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
        ["tmux", "has-session", "-t", session],
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
        ["tmux", "has-session", "-t", session],
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
      ["tmux", "has-session", "-t", `${runBase}-loop-1`],
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
      ["tmux", "has-session", "-t", "repo-loop-1"],
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
  expect(calls[2]).toEqual(["tmux", "has-session", "-t", "repo-loop-2"]);
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
