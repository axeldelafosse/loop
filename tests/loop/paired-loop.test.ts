import { afterEach, expect, mock, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  bridgeInternals,
  readPendingBridgeMessages,
} from "../../src/loop/bridge";
import {
  createRunManifest,
  readRunManifest,
  resolveExistingRunId,
  resolveRunStorage,
  writeRunManifest,
} from "../../src/loop/run-state";
import type { Agent, Options, RunResult } from "../../src/loop/types";

type PairedLoopModule = typeof import("../../src/loop/paired-loop");
type AgentRunKind = "review" | "work";

const makeTempHome = (): string => mkdtempSync(join(tmpdir(), "loop-paired-"));
const makeOptions = (overrides: Partial<Options> = {}): Options => ({
  agent: "codex",
  codexModel: "test-model",
  doneSignal: "<done/>",
  format: "raw",
  maxIterations: 1,
  proof: "verify with tests",
  review: undefined,
  ...overrides,
});

const makeResult = (parsed: string): RunResult => ({
  combined: "",
  exitCode: 0,
  parsed,
});

const writeBridgeMessages = (
  runDir: string,
  messages: Array<{
    at: string;
    id: string;
    message: string;
    source: Agent;
    target: Agent;
  }>
): void => {
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    bridgeInternals.bridgePath(runDir),
    `${messages.map((message) => JSON.stringify({ ...message, kind: "message" })).join("\n")}\n`,
    "utf8"
  );
};

const appendBridgeMessage = (
  runDir: string,
  message: {
    at: string;
    id: string;
    message: string;
    source: Agent;
    target: Agent;
  }
): void => {
  bridgeInternals.appendBridgeEvent(runDir, { ...message, kind: "message" });
};

let runAgentImpl = (
  _agent: Agent,
  _prompt: string,
  _opts: Options,
  _sessionId?: string
): Promise<RunResult> => Promise.resolve(makeResult("<done/>"));
let startPersistentAgentSessionImpl = (
  _agent: Agent,
  _opts: Options,
  _sessionId?: string,
  _sessionOptions?: unknown,
  _kind?: AgentRunKind
): Promise<void> => Promise.resolve(undefined);
let importNonce = 0;

const loadPairedLoop = (): Promise<PairedLoopModule> => {
  mock.restore();
  mock.module("../../src/loop/runner", () => ({
    runAgent: mock(
      (
        agent: Agent,
        prompt: string,
        opts: Options,
        sessionId?: string
      ): Promise<RunResult> => runAgentImpl(agent, prompt, opts, sessionId)
    ),
    runReviewerAgent: mock(
      (
        agent: Agent,
        prompt: string,
        opts: Options,
        sessionId?: string
      ): Promise<RunResult> => runAgentImpl(agent, prompt, opts, sessionId)
    ),
    startPersistentAgentSession: mock(
      (
        agent: Agent,
        opts: Options,
        sessionId?: string,
        sessionOptions?: unknown,
        kind?: AgentRunKind
      ): Promise<void> =>
        startPersistentAgentSessionImpl(
          agent,
          opts,
          sessionId,
          sessionOptions,
          kind
        )
    ),
  }));
  importNonce += 1;
  return import(
    `../../src/loop/paired-loop.ts?paired-loop=${importNonce}`
  ) as Promise<PairedLoopModule>;
};

const withTempHome = async (
  runId: string,
  fn: (runDir: string) => Promise<void>
): Promise<void> => {
  const home = makeTempHome();
  const originalHome = process.env.HOME;
  const originalCooldown = process.env.LOOP_COOLDOWN_MS;
  const originalRunId = process.env.LOOP_RUN_ID;
  process.env.HOME = home;
  process.env.LOOP_COOLDOWN_MS = "0";
  process.env.LOOP_RUN_ID = runId;

  try {
    await fn(resolveRunStorage(runId, process.cwd()).runDir);
  } finally {
    if (originalHome === undefined) {
      Reflect.deleteProperty(process.env, "HOME");
    } else {
      process.env.HOME = originalHome;
    }
    if (originalCooldown === undefined) {
      Reflect.deleteProperty(process.env, "LOOP_COOLDOWN_MS");
    } else {
      process.env.LOOP_COOLDOWN_MS = originalCooldown;
    }
    if (originalRunId === undefined) {
      Reflect.deleteProperty(process.env, "LOOP_RUN_ID");
    } else {
      process.env.LOOP_RUN_ID = originalRunId;
    }
    rmSync(home, { force: true, recursive: true });
  }
};

afterEach(() => {
  mock.restore();
  runAgentImpl = (
    _agent: Agent,
    _prompt: string,
    _opts: Options,
    _sessionId?: string
  ): Promise<RunResult> => Promise.resolve(makeResult("<done/>"));
  startPersistentAgentSessionImpl = (
    _agent: Agent,
    _opts: Options,
    _sessionId?: string,
    _sessionOptions?: unknown,
    _kind?: AgentRunKind
  ): Promise<void> => Promise.resolve(undefined);
});

test("runPairedLoop fails when --run-id does not resolve to an existing manifest", async () => {
  const module = await loadPairedLoop();
  const home = makeTempHome();
  const originalHome = process.env.HOME;
  const originalRunId = process.env.LOOP_RUN_ID;
  process.env.HOME = home;
  Reflect.deleteProperty(process.env, "LOOP_RUN_ID");

  try {
    await expect(
      module.runPairedLoop("Ship feature", makeOptions({ resumeRunId: "77" }))
    ).rejects.toThrow('paired run "77" does not exist');
    expect(existsSync(join(home, ".loop", "runs"))).toBe(false);
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

test("runPairedLoop starts the non-primary peer session in review mode", async () => {
  const module = await loadPairedLoop();
  const startCalls: Array<{ agent: Agent; kind: AgentRunKind | undefined }> =
    [];
  startPersistentAgentSessionImpl = (
    agent,
    _opts,
    _sessionId,
    _launch,
    kind
  ) => {
    startCalls.push({ agent, kind });
    return Promise.resolve(undefined);
  };

  await withTempHome("11", async () => {
    await module.runPairedLoop(
      "Ship feature",
      makeOptions({ agent: "codex", claudeReviewerModel: "claude-review" })
    );
  });

  expect(startCalls).toEqual([
    { agent: "claude", kind: "review" },
    { agent: "codex", kind: "work" },
  ]);
});

test("runPairedLoop resolves a stored raw session id back to its run manifest", async () => {
  const module = await loadPairedLoop();
  const home = makeTempHome();
  const originalHome = process.env.HOME;
  const originalRunId = process.env.LOOP_RUN_ID;
  const starts: Array<{ agent: Agent; sessionId?: string }> = [];
  process.env.HOME = home;
  process.env.LOOP_RUN_ID = "99";
  startPersistentAgentSessionImpl = (agent, _opts, sessionId) => {
    starts.push({ agent, sessionId });
    return Promise.resolve(undefined);
  };

  try {
    const storage = resolveRunStorage("alpha", process.cwd(), home);
    writeRunManifest(
      storage.manifestPath,
      createRunManifest(
        {
          claudeSessionId: "claude-session-1",
          codexThreadId: "codex-thread-1",
          cwd: process.cwd(),
          mode: "paired",
          pid: 1234,
          repoId: storage.repoId,
          runId: "alpha",
          status: "running",
        },
        "2026-03-22T10:00:00.000Z"
      )
    );

    await module.runPairedLoop(
      "Ship feature",
      makeOptions({ sessionId: "claude-session-1" })
    );

    expect(starts).toEqual([
      { agent: "claude", sessionId: "claude-session-1" },
      { agent: "codex", sessionId: "codex-thread-1" },
    ]);
    expect(
      readRunManifest(resolveRunStorage("99", process.cwd(), home).manifestPath)
    ).toBeUndefined();
    expect(readRunManifest(storage.manifestPath)).toMatchObject({
      claudeSessionId: "claude-session-1",
      codexThreadId: "codex-thread-1",
      runId: "alpha",
    });
    expect(process.env.LOOP_RUN_ID).toBe("alpha");
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

test("runPairedLoop restarts a completed paired run with fresh agent sessions", async () => {
  const module = await loadPairedLoop();
  const home = makeTempHome();
  const originalHome = process.env.HOME;
  const originalRunId = process.env.LOOP_RUN_ID;
  const starts: Array<{ agent: Agent; sessionId?: string }> = [];
  process.env.HOME = home;
  Reflect.deleteProperty(process.env, "LOOP_RUN_ID");
  startPersistentAgentSessionImpl = (agent, _opts, sessionId) => {
    starts.push({ agent, sessionId });
    return Promise.resolve(undefined);
  };

  try {
    const storage = resolveRunStorage("alpha", process.cwd(), home);
    writeRunManifest(
      storage.manifestPath,
      createRunManifest(
        {
          claudeSessionId: "claude-session-1",
          codexThreadId: "codex-thread-1",
          cwd: process.cwd(),
          mode: "paired",
          pid: 1234,
          repoId: storage.repoId,
          runId: "alpha",
          status: "done",
        },
        "2026-03-22T10:00:00.000Z"
      )
    );

    await module.runPairedLoop(
      "Ship feature",
      makeOptions({ resumeRunId: "alpha" })
    );

    expect(starts).toEqual([
      { agent: "claude", sessionId: undefined },
      { agent: "codex", sessionId: undefined },
    ]);
    expect(readRunManifest(storage.manifestPath)).toMatchObject({
      claudeSessionId: "",
      codexThreadId: "",
      runId: "alpha",
      status: "done",
    });
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

test("preparePairedOptions loads stored pair ids before planning", async () => {
  const module = await loadPairedLoop();
  const home = makeTempHome();
  const originalHome = process.env.HOME;
  const originalRunId = process.env.LOOP_RUN_ID;
  process.env.HOME = home;
  Reflect.deleteProperty(process.env, "LOOP_RUN_ID");

  try {
    const storage = resolveRunStorage("alpha", process.cwd(), home);
    writeRunManifest(
      storage.manifestPath,
      createRunManifest(
        {
          claudeSessionId: "claude-session-1",
          codexThreadId: "codex-thread-1",
          cwd: process.cwd(),
          mode: "paired",
          pid: 1234,
          repoId: storage.repoId,
          runId: "alpha",
          status: "running",
        },
        "2026-03-22T10:00:00.000Z"
      )
    );
    const opts = makeOptions({ sessionId: "claude-session-1" });

    module.preparePairedOptions(opts);

    expect(process.env.LOOP_RUN_ID).toBe("alpha");
    expect(opts.claudePersistentSession).toBe(true);
    expect(opts.claudeMcpConfigPath).toContain(storage.runDir);
    expect(opts.codexMcpConfigArgs).toEqual(
      expect.arrayContaining([
        expect.stringContaining("mcp_servers.loop-bridge.command="),
        expect.stringContaining("mcp_servers.loop-bridge.args="),
      ])
    );
    expect(opts.pairedSessionIds).toEqual({
      claude: "claude-session-1",
      codex: "codex-thread-1",
    });
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

test("preparePairedOptions writes a resumeable manifest for a fresh paired run", async () => {
  const module = await loadPairedLoop();
  const home = makeTempHome();
  const originalHome = process.env.HOME;
  const originalRunId = process.env.LOOP_RUN_ID;
  process.env.HOME = home;
  process.env.LOOP_RUN_ID = "alpha";

  try {
    const storage = resolveRunStorage("alpha", process.cwd(), home);
    const opts = makeOptions({ pairedMode: true });

    module.preparePairedOptions(opts, process.cwd());

    const manifest = readRunManifest(storage.manifestPath);
    expect(manifest).toMatchObject({
      claudeSessionId: "",
      codexThreadId: "",
      cwd: process.cwd(),
      mode: "paired",
      repoId: storage.repoId,
      runId: "alpha",
      status: "running",
    });
    expect(resolveExistingRunId("alpha", process.cwd(), home)).toBe("alpha");
    expect(opts.pairedSessionIds).toBeUndefined();
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

test("runPairedLoop seeds a fresh paired run from a raw primary session id", async () => {
  const module = await loadPairedLoop();
  const starts: Array<{ agent: Agent; sessionId?: string }> = [];
  startPersistentAgentSessionImpl = (agent, _opts, sessionId) => {
    starts.push({ agent, sessionId });
    return Promise.resolve(undefined);
  };

  await withTempHome("raw", async (runDir) => {
    await module.runPairedLoop(
      "Ship feature",
      makeOptions({ agent: "claude", sessionId: "claude-session-raw" })
    );

    expect(starts).toEqual([
      { agent: "claude", sessionId: "claude-session-raw" },
      { agent: "codex", sessionId: undefined },
    ]);
    expect(readRunManifest(join(runDir, "manifest.json"))).toMatchObject({
      claudeSessionId: "claude-session-raw",
      runId: "raw",
    });
  });
});

test("runPairedLoop marks a failed startup as stopped", async () => {
  const module = await loadPairedLoop();
  startPersistentAgentSessionImpl = (agent) => {
    if (agent === "claude") {
      return Promise.reject(new Error("claude start failed"));
    }
    return Promise.resolve(undefined);
  };

  await withTempHome("3", async (runDir) => {
    await expect(
      module.runPairedLoop("Ship feature", makeOptions())
    ).rejects.toThrow("claude start failed");
    expect(readRunManifest(join(runDir, "manifest.json"))?.status).toBe(
      "stopped"
    );
  });
});

test("runPairedLoop creates an empty transcript when no bridge traffic occurs", async () => {
  const module = await loadPairedLoop();

  await withTempHome("4a", async (runDir) => {
    await module.runPairedLoop("Ship feature", makeOptions({ agent: "codex" }));

    const transcriptPath = join(runDir, "transcript.jsonl");
    expect(existsSync(transcriptPath)).toBe(true);
    expect(readFileSync(transcriptPath, "utf8")).toBe("");
  });
});

test("runPairedLoop delivers forwarded bridge messages to the target agent", async () => {
  const module = await loadPairedLoop();
  const calls: Array<{ agent: Agent; prompt: string }> = [];

  runAgentImpl = (agent, prompt) => {
    calls.push({ agent, prompt });
    return Promise.resolve(makeResult("working"));
  };

  await withTempHome("4", async (runDir) => {
    writeBridgeMessages(runDir, [
      {
        at: "2026-03-22T10:00:00.000Z",
        id: "msg-1",
        message: "Please review the Codex output.",
        source: "codex",
        target: "claude",
      },
    ]);

    await module.runPairedLoop("Ship feature", makeOptions({ agent: "codex" }));

    expect(calls).toHaveLength(2);
    expect(calls[0]?.agent).toBe("claude");
    expect(calls[1]?.agent).toBe("codex");
    expect(calls[0]?.prompt).toContain(
      "Message from Codex via the loop bridge:"
    );
    expect(calls[0]?.prompt).toContain("Please review the Codex output.");

    const events = bridgeInternals.readBridgeEvents(runDir);
    expect(events.some((event) => event.kind === "delivered")).toBe(true);
    expect(readRunManifest(join(runDir, "manifest.json"))?.status).toBe(
      "stopped"
    );
  });
});

test("runPairedLoop keeps a failed bridge message queued until the next run", async () => {
  const module = await loadPairedLoop();
  const firstRunCalls: Array<{ agent: Agent; prompt: string }> = [];
  const secondRunCalls: Array<{ agent: Agent; prompt: string }> = [];
  let allowBridgeDelivery = false;

  runAgentImpl = (agent, prompt) => {
    firstRunCalls.push({ agent, prompt });
    if (agent === "claude" && !allowBridgeDelivery) {
      return Promise.reject(new Error("temporary bridge failure"));
    }
    return Promise.resolve(makeResult("working"));
  };

  await withTempHome("4b", async (runDir) => {
    writeBridgeMessages(runDir, [
      {
        at: "2026-03-22T10:00:00.000Z",
        id: "msg-1",
        message: "Please review the Codex output.",
        source: "codex",
        target: "claude",
      },
    ]);

    await module.runPairedLoop("Ship feature", makeOptions({ agent: "codex" }));

    expect(firstRunCalls.map((call) => call.agent)).toEqual([
      "claude",
      "codex",
      "claude",
    ]);
    expect(readPendingBridgeMessages(runDir)).toHaveLength(1);
    expect(
      bridgeInternals
        .readBridgeEvents(runDir)
        .filter((event) => event.kind === "delivered")
    ).toHaveLength(0);

    allowBridgeDelivery = true;
    runAgentImpl = (agent, prompt) => {
      secondRunCalls.push({ agent, prompt });
      return Promise.resolve(makeResult("working"));
    };

    await module.runPairedLoop("Ship feature", makeOptions({ agent: "codex" }));

    expect(secondRunCalls[0]?.agent).toBe("claude");
    expect(secondRunCalls[0]?.prompt).toContain(
      "Message from Codex via the loop bridge:"
    );
    expect(readPendingBridgeMessages(runDir)).toHaveLength(0);
    expect(
      bridgeInternals
        .readBridgeEvents(runDir)
        .filter((event) => event.kind === "delivered")
    ).toHaveLength(1);
  });
});

test("runPairedLoop delivers peer messages back to the primary agent", async () => {
  const module = await loadPairedLoop();
  const calls: Array<{ agent: Agent; prompt: string }> = [];
  let sentReply = false;

  runAgentImpl = (agent, prompt, opts) => {
    calls.push({ agent, prompt });
    const runDir = dirname(opts.claudeMcpConfigPath ?? "");

    if (agent === "claude" && calls.length === 1) {
      appendBridgeMessage(runDir, {
        at: "2026-03-22T10:00:00.000Z",
        id: "msg-1",
        message: "Please verify the implementation details.",
        source: "claude",
        target: "codex",
      });
      return Promise.resolve(makeResult("<done/>"));
    }

    if (agent === "codex" && !sentReply) {
      sentReply = true;
      appendBridgeMessage(runDir, {
        at: "2026-03-22T10:01:00.000Z",
        id: "msg-2",
        message: "Found one change to make before landing this.",
        source: "codex",
        target: "claude",
      });
    }

    return Promise.resolve(makeResult("working"));
  };

  await withTempHome("5", async () => {
    await module.runPairedLoop(
      "Ship feature",
      makeOptions({ agent: "claude" })
    );

    expect(calls).toHaveLength(3);
    expect(calls[0]?.agent).toBe("claude");
    expect(calls[1]?.agent).toBe("codex");
    expect(calls[1]?.prompt).toContain(
      "Message from Claude via the loop bridge:"
    );
    expect(calls[1]?.prompt).toContain(
      "Please verify the implementation details."
    );
    expect(calls[2]?.agent).toBe("claude");
    expect(calls[2]?.prompt).toContain(
      "Message from Codex via the loop bridge:"
    );
    expect(calls[2]?.prompt).toContain(
      "Found one change to make before landing this."
    );
  });
});

test("runPairedLoop skips the default work turn after draining input for the primary agent", async () => {
  const module = await loadPairedLoop();
  const calls: Array<{ agent: Agent; prompt: string }> = [];

  runAgentImpl = (agent, prompt) => {
    calls.push({ agent, prompt });
    return Promise.resolve(makeResult("working"));
  };

  await withTempHome("9", async (runDir) => {
    writeBridgeMessages(runDir, [
      {
        at: "2026-03-22T10:00:00.000Z",
        id: "msg-1",
        message: "Please verify the implementation details.",
        source: "claude",
        target: "codex",
      },
    ]);

    await module.runPairedLoop("Ship feature", makeOptions({ agent: "codex" }));

    expect(calls).toHaveLength(1);
    expect(calls[0]?.agent).toBe("codex");
    expect(calls[0]?.prompt).toContain(
      "Message from Claude via the loop bridge:"
    );
    expect(calls[0]?.prompt).toContain(
      "Please verify the implementation details."
    );
    expect(
      bridgeInternals
        .readBridgeEvents(runDir)
        .filter((event) => event.kind === "delivered")
    ).toHaveLength(1);
  });
});

test("runPairedLoop preserves claudex reviewers in paired mode", async () => {
  const module = await loadPairedLoop();
  const reviewPrompts: Array<{ agent: Agent; prompt: string }> = [];

  runAgentImpl = (agent, prompt) => {
    if (prompt.includes("Review this completed work")) {
      reviewPrompts.push({ agent, prompt });
      return Promise.resolve(
        makeResult("Needs changes.\n<review>FAIL</review>")
      );
    }

    return Promise.resolve(makeResult("<done/>"));
  };

  await withTempHome("7", async () => {
    await module.runPairedLoop(
      "Ship feature",
      makeOptions({ agent: "claude", review: "claudex" })
    );

    expect(reviewPrompts.map((entry) => entry.agent)).toEqual([
      "claude",
      "codex",
    ]);
    expect(reviewPrompts[0]?.prompt).toContain(
      "keep the actionable notes in your review body before the final review signal"
    );
    expect(reviewPrompts[0]?.prompt).not.toContain("send_to_agent");
    expect(reviewPrompts[1]?.prompt).toContain(
      'send the actionable notes to Claude with "send_to_agent"'
    );
  });
});

test("runPairedLoop keeps explicit same-agent review on that agent", async () => {
  const module = await loadPairedLoop();
  const reviewPrompts: Array<{ agent: Agent; prompt: string }> = [];

  runAgentImpl = (agent, prompt) => {
    if (prompt.includes("Review this completed work")) {
      reviewPrompts.push({ agent, prompt });
      return Promise.resolve(
        makeResult("Needs changes.\n<review>FAIL</review>")
      );
    }

    return Promise.resolve(makeResult("<done/>"));
  };

  await withTempHome("8", async () => {
    await module.runPairedLoop(
      "Ship feature",
      makeOptions({ agent: "codex", review: "codex" })
    );

    expect(reviewPrompts).toHaveLength(1);
    expect(reviewPrompts[0]?.agent).toBe("codex");
    expect(reviewPrompts[0]?.prompt).toContain(
      "keep the actionable notes in your review body before the final review signal"
    );
    expect(reviewPrompts[0]?.prompt).not.toContain("send_to_agent");
  });
});

test("runPairedLoop keeps self-review notes for the next prompt when peer feedback was bridged", async () => {
  const module = await loadPairedLoop();
  const workPrompts: string[] = [];
  let workTurns = 0;
  const originalCooldown = process.env.LOOP_COOLDOWN_MS;
  process.env.LOOP_COOLDOWN_MS = "0";

  try {
    await withTempHome("10", async (runDir) => {
      runAgentImpl = (agent, prompt) => {
        if (prompt.includes("Review this completed work")) {
          if (agent === "claude") {
            return Promise.resolve(
              makeResult(
                "Self review found one more fix.\n<review>FAIL</review>"
              )
            );
          }

          appendBridgeMessage(runDir, {
            at: "2026-03-22T10:02:00.000Z",
            id: "msg-3",
            message: "Peer review says to tighten the tests.",
            source: "codex",
            target: "claude",
          });
          return Promise.resolve(
            makeResult("Peer review found one more fix.\n<review>FAIL</review>")
          );
        }

        if (prompt.includes("Message from Codex via the loop bridge:")) {
          return Promise.resolve(makeResult("Bridge message received."));
        }

        workPrompts.push(prompt);
        workTurns += 1;
        return Promise.resolve(
          makeResult(workTurns === 1 ? "<done/>" : "Continuing fixes.")
        );
      };

      await module.runPairedLoop(
        "Ship feature",
        makeOptions({ agent: "claude", maxIterations: 2, review: "claudex" })
      );

      expect(workPrompts).toHaveLength(2);
      expect(workPrompts[1]).toContain("Review feedback:");
      expect(workPrompts[1]).toContain(
        "[claude] Self review found one more fix."
      );
      expect(workPrompts[1]).not.toContain("[codex]");
    });
  } finally {
    if (originalCooldown === undefined) {
      Reflect.deleteProperty(process.env, "LOOP_COOLDOWN_MS");
    } else {
      process.env.LOOP_COOLDOWN_MS = originalCooldown;
    }
  }
});

test("runPairedLoop delivers cross-direction bridge messages without permanent suppression", async () => {
  const module = await loadPairedLoop();
  const calls: Array<{ agent: Agent; prompt: string }> = [];

  runAgentImpl = (agent, prompt) => {
    calls.push({ agent, prompt });
    return Promise.resolve(makeResult("<done/>"));
  };

  await withTempHome("6", async (runDir) => {
    writeBridgeMessages(runDir, [
      {
        at: "2026-03-22T10:00:00.000Z",
        id: "msg-1",
        message: "Please review the implementation details.",
        source: "claude",
        target: "codex",
      },
      {
        at: "2026-03-22T10:01:00.000Z",
        id: "msg-2",
        message: "Please review the implementation details.",
        source: "codex",
        target: "claude",
      },
    ]);

    await module.runPairedLoop("Ship feature", makeOptions({ agent: "codex" }));

    const events = bridgeInternals.readBridgeEvents(runDir);
    expect(calls).toHaveLength(2);
    expect(calls.map((call) => call.agent)).toEqual(["codex", "claude"]);
    expect(events.filter((event) => event.kind === "delivered")).toHaveLength(
      2
    );
    expect(events.filter((event) => event.kind === "blocked")).toHaveLength(0);
    expect(readPendingBridgeMessages(runDir)).toHaveLength(0);
    expect(existsSync(bridgeInternals.bridgePath(runDir))).toBe(true);
    expect(readRunManifest(join(runDir, "manifest.json"))?.status).toBe(
      "stopped"
    );
  });
});
