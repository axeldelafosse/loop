import { expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendRunTranscriptEntry,
  buildManifestPath,
  buildRunDir,
  buildTranscriptPath,
  createRunManifest,
  createRunResultEntry,
  createRunReviewEntry,
  createRunStatusEntry,
  createRunTranscriptEntry,
  loadRunState,
  readRunManifest,
  readRunTranscriptEntries,
  resolveExistingRunId,
  resolveRepoId,
  resolveRunId,
  resolveRunStorage,
  resolveStorageRoot,
  touchRunManifest,
  writeRunManifest,
} from "../../src/loop/run-state";

const makeTempDir = (): string =>
  mkdtempSync(join(tmpdir(), "loop-run-state-"));
const LOOP_REPO_ID_RE = /^loop-[a-f0-9]{12}$/;
const REPO_ID_RE = /^repo-[a-f0-9]{12}$/;

test("resolveRepoId prefers git common dir and stays stable across worktrees", () => {
  const calls: string[] = [];
  const runGit = (args: string[]) => {
    calls.push(args.join(" "));
    return args.includes("--git-common-dir")
      ? { exitCode: 0, stderr: "", stdout: "/repo/.git\n" }
      : { exitCode: 0, stderr: "", stdout: "" };
  };

  const first = resolveRepoId("/repo", { runGit });
  const second = resolveRepoId("/repo/worktree", { runGit });

  expect(first).toBe(second);
  expect(calls).toEqual([
    "rev-parse --path-format=absolute --git-common-dir",
    "rev-parse --path-format=absolute --git-common-dir",
  ]);
});

test("resolveRepoId falls back to top-level when git common dir is unavailable", () => {
  const runGit = (args: string[]) => {
    if (args.includes("--git-common-dir")) {
      return { exitCode: 1, stderr: "", stdout: "" };
    }
    return {
      exitCode: 0,
      stderr: "",
      stdout: "/Users/me/code/loop\n",
    };
  };

  expect(resolveRepoId("/Users/me/code/loop/src", { runGit })).toMatch(
    LOOP_REPO_ID_RE
  );
});

test("resolveStorageRoot and run path helpers build the expected layout", () => {
  const storageRoot = resolveStorageRoot("/Users/me");
  const runDir = buildRunDir(storageRoot, "repo-abc123", "42");

  expect(storageRoot).toBe("/Users/me/.loop/runs");
  expect(runDir).toBe("/Users/me/.loop/runs/repo-abc123/42");
  expect(buildManifestPath(runDir)).toBe(
    "/Users/me/.loop/runs/repo-abc123/42/manifest.json"
  );
  expect(buildTranscriptPath(runDir)).toBe(
    "/Users/me/.loop/runs/repo-abc123/42/transcript.jsonl"
  );
});

test("resolveRunStorage resolves the same run dir for a resumed run id", () => {
  const storage = resolveRunStorage("7", "/repo/worktree", "/Users/me", {
    runGit: (args: string[]) =>
      args.includes("--git-common-dir")
        ? { exitCode: 0, stderr: "", stdout: "/repo/.git\n" }
        : { exitCode: 0, stderr: "", stdout: "" },
  });

  expect(storage.repoId).toMatch(REPO_ID_RE);
  expect(storage.runDir).toBe(`/Users/me/.loop/runs/${storage.repoId}/7`);
  expect(storage.manifestPath).toBe(join(storage.runDir, "manifest.json"));
  expect(storage.transcriptPath).toBe(join(storage.runDir, "transcript.jsonl"));
});

test("resolveRunId prefers LOOP_RUN_ID over auto-incrementing storage", () => {
  const home = makeTempDir();
  const storageRoot = resolveStorageRoot(home);
  const repoId = "repo-abc123";
  const repoDir = join(storageRoot, repoId);
  mkdirSync(join(repoDir, "1"), { recursive: true });
  mkdirSync(join(repoDir, "2"), { recursive: true });

  const originalRunId = process.env.LOOP_RUN_ID;
  process.env.LOOP_RUN_ID = "19";
  try {
    expect(resolveRunId(storageRoot, repoId, process.env)).toBe("19");
  } finally {
    if (originalRunId === undefined) {
      Reflect.deleteProperty(process.env, "LOOP_RUN_ID");
    } else {
      process.env.LOOP_RUN_ID = originalRunId;
    }
    rmSync(home, { recursive: true, force: true });
  }
});

test("resolveRunId increments from the latest stored run", () => {
  const home = makeTempDir();
  const storageRoot = resolveStorageRoot(home);
  const repoId = "repo-abc123";
  const repoDir = join(storageRoot, repoId);
  mkdirSync(join(repoDir, "1"), { recursive: true });
  mkdirSync(join(repoDir, "3"), { recursive: true });

  const originalRunId = process.env.LOOP_RUN_ID;
  Reflect.deleteProperty(process.env, "LOOP_RUN_ID");
  try {
    expect(resolveRunId(storageRoot, repoId)).toBe("4");
  } finally {
    if (originalRunId === undefined) {
      Reflect.deleteProperty(process.env, "LOOP_RUN_ID");
    } else {
      process.env.LOOP_RUN_ID = originalRunId;
    }
    rmSync(home, { recursive: true, force: true });
  }
});

test("manifest helpers write, read, and touch run metadata", () => {
  const dir = makeTempDir();
  const manifestPath = join(dir, "manifest.json");
  const manifest = createRunManifest(
    {
      claudeSessionId: "claude-1",
      codexRemoteUrl: "ws://127.0.0.1:4500",
      codexThreadId: "codex-1",
      cwd: "/repo",
      mode: "paired",
      pid: 1234,
      repoId: "repo-abc123",
      runId: "9",
      state: "working",
    },
    "2026-03-22T10:00:00.000Z"
  );

  writeRunManifest(manifestPath, manifest);
  const loaded = readRunManifest(manifestPath);
  const touched = touchRunManifest(manifest, "2026-03-22T11:00:00.000Z");

  expect(loaded).toEqual(manifest);
  expect(touched.updatedAt).toBe("2026-03-22T11:00:00.000Z");
  expect(touched.createdAt).toBe(manifest.createdAt);
  rmSync(dir, { recursive: true, force: true });
});

test("manifest reader ignores malformed files", () => {
  const dir = makeTempDir();
  const path = join(dir, "manifest.json");
  writeFileSync(path, "{not json}", "utf8");

  expect(readRunManifest(path)).toBeUndefined();
  rmSync(dir, { recursive: true, force: true });
});

test("loadRunState resolves an existing run by run id", () => {
  const home = makeTempDir();
  const runGit = (args: string[]) =>
    args.includes("--git-common-dir")
      ? { exitCode: 0, stderr: "", stdout: "/repo/.git\n" }
      : { exitCode: 0, stderr: "", stdout: "" };
  const repoId = resolveRepoId("/repo/worktree", { runGit });
  const runDir = join(home, ".loop", "runs", repoId, "7");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, "manifest.json"),
    JSON.stringify({
      claude_session_id: "claude-1",
      codex_thread_id: "codex-1",
      created_at: "2026-03-22T10:00:00.000Z",
      cwd: "/repo",
      mode: "paired",
      pid: "1234",
      repo_id: repoId,
      run_id: "7",
      status: "active",
      updated_at: "2026-03-22T11:00:00.000Z",
    })
  );
  writeFileSync(
    join(runDir, "transcript.jsonl"),
    `${JSON.stringify({
      at: "2026-03-22T10:01:00.000Z",
      from: "claude",
      message: "hello",
      to: "codex",
    })}\n`
  );

  const state = loadRunState("7", "/repo/worktree", home, { runGit });

  expect(state.storage.runDir).toBe(runDir);
  expect(state.manifest).toEqual({
    claudeSessionId: "claude-1",
    codexThreadId: "codex-1",
    createdAt: "2026-03-22T10:00:00.000Z",
    cwd: "/repo",
    mode: "paired",
    pid: 1234,
    repoId,
    runId: "7",
    state: "working",
    status: "running",
    updatedAt: "2026-03-22T11:00:00.000Z",
  });
  expect(state.transcript).toEqual([
    {
      at: "2026-03-22T10:01:00.000Z",
      from: "claude",
      message: "hello",
      to: "codex",
    },
  ]);

  rmSync(home, { recursive: true, force: true });
});

test("resolveExistingRunId returns a matching stored run id", () => {
  const home = makeTempDir();
  const runGit = (args: string[]) =>
    args.includes("--git-common-dir")
      ? { exitCode: 0, stderr: "", stdout: "/repo/.git\n" }
      : { exitCode: 0, stderr: "", stdout: "" };
  const repoId = resolveRepoId("/repo/worktree", { runGit });
  const runDir = join(home, ".loop", "runs", repoId, "alpha");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, "manifest.json"),
    JSON.stringify({
      created_at: "2026-03-22T10:00:00.000Z",
      cwd: "/repo",
      mode: "paired",
      pid: 1234,
      repo_id: repoId,
      run_id: "alpha",
      status: "active",
      updated_at: "2026-03-22T11:00:00.000Z",
    })
  );

  expect(
    resolveExistingRunId("alpha", "/repo/worktree", home, { runGit })
  ).toBe("alpha");
  expect(
    resolveExistingRunId("missing", "/repo/worktree", home, { runGit })
  ).toBe(undefined);
  expect(
    resolveExistingRunId("../oops", "/repo/worktree", home, { runGit })
  ).toBe(undefined);

  rmSync(home, { recursive: true, force: true });
});

test("resolveExistingRunId matches stored Claude and Codex session ids", () => {
  const home = makeTempDir();
  const runGit = (args: string[]) =>
    args.includes("--git-common-dir")
      ? { exitCode: 0, stderr: "", stdout: "/repo/.git\n" }
      : { exitCode: 0, stderr: "", stdout: "" };
  const repoId = resolveRepoId("/repo/worktree", { runGit });
  const runDir = join(home, ".loop", "runs", repoId, "alpha");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, "manifest.json"),
    JSON.stringify({
      claude_session_id: "claude-session-1",
      codex_thread_id: "codex-thread-1",
      created_at: "2026-03-22T10:00:00.000Z",
      cwd: "/repo",
      mode: "paired",
      pid: 1234,
      repo_id: repoId,
      run_id: "alpha",
      status: "active",
      updated_at: "2026-03-22T11:00:00.000Z",
    })
  );

  expect(
    resolveExistingRunId("claude-session-1", "/repo/worktree", home, {
      runGit,
    })
  ).toBe("alpha");
  expect(
    resolveExistingRunId("codex-thread-1", "/repo/worktree", home, {
      runGit,
    })
  ).toBe("alpha");

  rmSync(home, { recursive: true, force: true });
});

test("transcript helpers append and read jsonl entries", () => {
  const dir = makeTempDir();
  const transcriptPath = join(dir, "transcript.jsonl");
  const first = createRunTranscriptEntry(
    "claude",
    "hello",
    "codex",
    "2026-03-22T10:00:00.000Z"
  );
  const second = createRunTranscriptEntry(
    "codex",
    "hi",
    "claude",
    "2026-03-22T10:01:00.000Z"
  );

  appendRunTranscriptEntry(transcriptPath, first);
  appendRunTranscriptEntry(transcriptPath, second);

  expect(readRunTranscriptEntries(transcriptPath)).toEqual([first, second]);
  expect(readFileSync(transcriptPath, "utf8")).toContain('"from":"claude"');
  rmSync(dir, { recursive: true, force: true });
});

test("transcript helpers parse structured status, review, and result entries", () => {
  const dir = makeTempDir();
  const transcriptPath = join(dir, "transcript.jsonl");
  const entries = [
    createRunStatusEntry(
      "working",
      "paired sessions ready",
      "2026-03-22T10:00:00.000Z"
    ),
    createRunReviewEntry(
      "codex",
      "fail",
      "Needs one more test.",
      "2026-03-22T10:01:00.000Z"
    ),
    createRunResultEntry(
      "done-signal-detected",
      "<done/>",
      "2026-03-22T10:02:00.000Z"
    ),
  ];

  for (const entry of entries) {
    appendRunTranscriptEntry(transcriptPath, entry);
  }

  expect(readRunTranscriptEntries(transcriptPath)).toEqual(entries);
  rmSync(dir, { recursive: true, force: true });
});

test("structured transcript entries round-trip without undefined optional fields", () => {
  const dir = makeTempDir();
  const transcriptPath = join(dir, "transcript.jsonl");
  const entries = [
    createRunStatusEntry("working", undefined, "2026-03-22T10:00:00.000Z"),
    createRunReviewEntry(
      "codex",
      "pass",
      undefined,
      "2026-03-22T10:01:00.000Z"
    ),
    createRunResultEntry("stopped", undefined, "2026-03-22T10:02:00.000Z"),
  ];

  for (const entry of entries) {
    appendRunTranscriptEntry(transcriptPath, entry);
  }

  expect(readRunTranscriptEntries(transcriptPath)).toEqual(entries);
  rmSync(dir, { recursive: true, force: true });
});

test("run ids are validated before storage paths are built", () => {
  expect(() => buildRunDir("/tmp", "repo", "../oops")).toThrow(
    "Invalid run id"
  );
  expect(() => buildRunDir("/tmp", "repo", "foo..bar")).toThrow(
    "Invalid run id"
  );
});
