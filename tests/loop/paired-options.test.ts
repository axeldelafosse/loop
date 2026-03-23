import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { preparePairedOptions } from "../../src/loop/paired-options";
import {
  createRunManifest,
  readRunManifest,
  resolveRunStorage,
  writeRunManifest,
} from "../../src/loop/run-state";
import type { Options } from "../../src/loop/types";

const makeTempHome = (): string => mkdtempSync(join(tmpdir(), "loop-paired-"));

const makeOptions = (overrides: Partial<Options> = {}): Options => ({
  agent: "codex",
  codexModel: "test-model",
  doneSignal: "<done/>",
  format: "raw",
  maxIterations: 1,
  proof: "verify with tests",
  ...overrides,
});

test("preparePairedOptions accepts a raw session id without creating a paired manifest", () => {
  const home = makeTempHome();
  const originalHome = process.env.HOME;
  const originalRunId = process.env.LOOP_RUN_ID;
  process.env.HOME = home;
  Reflect.deleteProperty(process.env, "LOOP_RUN_ID");

  try {
    const opts = makeOptions({
      agent: "claude",
      pairedMode: true,
      sessionId: "claude-session-raw",
    });

    expect(() =>
      preparePairedOptions(opts, process.cwd(), false)
    ).not.toThrow();

    const storage = resolveRunStorage("1", process.cwd(), home);
    expect(process.env.LOOP_RUN_ID).toBe("1");
    expect(readRunManifest(storage.manifestPath)).toBeUndefined();
    expect(opts.claudePersistentSession).toBe(true);
    expect(opts.pairedSessionIds).toEqual({
      claude: "claude-session-raw",
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
    rmSync(home, { recursive: true, force: true });
  }
});

test("preparePairedOptions ignores stored session ids from a completed paired run", () => {
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
          status: "done",
        },
        "2026-03-22T10:00:00.000Z"
      )
    );
    const opts = makeOptions({ sessionId: "codex-thread-1" });

    preparePairedOptions(opts, process.cwd(), false);

    expect(process.env.LOOP_RUN_ID).toBe("alpha");
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
    rmSync(home, { recursive: true, force: true });
  }
});
