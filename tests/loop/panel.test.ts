import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { panelInternals } from "../../src/loop/panel";

test("parseProcessList keeps codex engine and deduplicates wrapper", () => {
  const output = `
  PID  PPID COMMAND
54665 4474 node /Users/me/.nvm/versions/node/v24.9.0/bin/codex
54666 54665 /Users/me/.nvm/versions/node/v24.9.0/lib/node_modules/@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/codex/codex
88398 87837 claude
`.trim();
  const rows = panelInternals.parseProcessList(output);
  expect(rows).toEqual([
    { agent: "codex", pid: 54_666 },
    { agent: "claude", pid: 88_398 },
  ]);
});

test("parseProcessList deduplicates codex app-server wrapper and engine", () => {
  const output = `
  PID  PPID COMMAND
  66100 1200 codex app-server
  66101 66100 /usr/local/bin/node /Users/me/.nvm/.../node_modules/@openai/codex/dist/app-server.js
  77220 1201 claude
 `.trim();
  const rows = panelInternals.parseProcessList(output);
  expect(rows).toEqual([
    { agent: "codex", pid: 66_101 },
    { agent: "claude", pid: 77_220 },
  ]);
});

test("parseProcessList handles node app-server launches with runtime flags", () => {
  const output = `
  PID  PPID COMMAND
  66110 1200 node --no-warnings /Users/me/.nvm/.../node_modules/@openai/codex/dist/app-server.js
  77230 1201 claude
  `.trim();
  const rows = panelInternals.parseProcessList(output);
  expect(rows).toEqual([
    { agent: "codex", pid: 66_110 },
    { agent: "claude", pid: 77_230 },
  ]);
});

test("parseProcessList detects a direct codex app-server process", () => {
  const output = `
  PID  PPID COMMAND
  66200 1200 /usr/local/bin/codex-app-server run
  77221 1201 claude
`.trim();
  const rows = panelInternals.parseProcessList(output);
  expect(rows).toEqual([
    { agent: "codex", pid: 66_200 },
    { agent: "claude", pid: 77_221 },
  ]);
});

test("parseProcessList detects a bare app-server process", () => {
  const output = `
  PID  PPID COMMAND
  66300 1200 app-server
  77231 1201 claude
  `.trim();
  const rows = panelInternals.parseProcessList(output);
  expect(rows).toEqual([
    { agent: "codex", pid: 66_300 },
    { agent: "claude", pid: 77_231 },
  ]);
});

test("parseProcessList detects a bun app-server invocation with flags", () => {
  const output = `
  PID  PPID COMMAND
  66201 1200 bun --inspect=0.0.0.0:9229 /Users/me/.nvm/versions/node/v24.9.0/bin/codex app-server
  77222 1201 claude
`.trim();
  const rows = panelInternals.parseProcessList(output);
  expect(rows).toEqual([
    { agent: "codex", pid: 66_201 },
    { agent: "claude", pid: 77_222 },
  ]);
});

test("parseProcessList detects a standalone app-server invocation", () => {
  const output = `
  PID  PPID COMMAND
  66202 1200 app-server run
  77223 1201 claude
`.trim();
  const rows = panelInternals.parseProcessList(output);
  expect(rows).toEqual([
    { agent: "codex", pid: 66_202 },
    { agent: "claude", pid: 77_223 },
  ]);
});

test("parseLsofSnapshot extracts cwd and file names", () => {
  const output = `
p54666
fcwd
n/Users/me/project
f16
n/Users/me/.codex/sessions/2026/02/20/rollout.jsonl
`.trim();
  const parsed = panelInternals.parseLsofSnapshot(output);
  expect(parsed.cwd).toBe("/Users/me/project");
  expect(parsed.names).toContain(
    "/Users/me/.codex/sessions/2026/02/20/rollout.jsonl"
  );
});

test("parseTmuxSessions keeps active loop sessions and extracts ids", () => {
  const output = `
repo-loop-2\t0
repo-loop-10\t1
scratch\t0
`.trim();
  const rows = panelInternals.parseTmuxSessions(output);
  expect(rows).toEqual([
    { attached: false, id: "2", session: "repo-loop-2" },
    { attached: true, id: "10", session: "repo-loop-10" },
  ]);
});

test("parseTmuxSessions keeps alphanumeric loop sessions", () => {
  const output = `
repo-loop-2\t0
repo-loop-alpha\t1
repo-loop-10\t1
`.trim();
  const rows = panelInternals.parseTmuxSessions(output);
  expect(rows).toEqual([
    { attached: false, id: "2", session: "repo-loop-2" },
    { attached: true, id: "10", session: "repo-loop-10" },
    { attached: true, id: "alpha", session: "repo-loop-alpha" },
  ]);
});

test("parseTmuxSessions keeps hyphen and underscore loop sessions", () => {
  const output = `
repo-loop-alpha-1\t1
repo-loop-alpha_1\t0
repo-loop-abc123\t1
`.trim();
  const rows = panelInternals.parseTmuxSessions(output);
  expect(rows).toEqual([
    { attached: true, id: "abc123", session: "repo-loop-abc123" },
    { attached: false, id: "alpha_1", session: "repo-loop-alpha_1" },
    { attached: true, id: "alpha-1", session: "repo-loop-alpha-1" },
  ]);
});

test("projectKeyFromCwd matches claude project folder naming", () => {
  expect(panelInternals.projectKeyFromCwd("/Users/me/code/loop")).toBe(
    "-Users-me-code-loop"
  );
});

test("parseTimestampMs returns NaN for invalid timestamp", () => {
  expect(Number.isNaN(panelInternals.parseTimestampMs("invalid"))).toBe(true);
});

test("collectLoopRuns loads manifests and keeps newest first", () => {
  const root = mkdtempSync(join(tmpdir(), "loop-runs-"));
  const first = join(root, "repo-alpha", "7");
  const second = join(root, "repo-beta", "9");
  mkdirSync(first, { recursive: true });
  mkdirSync(second, { recursive: true });
  writeFileSync(
    join(first, "manifest.json"),
    JSON.stringify({
      claudeSessionId: "claude-alpha",
      codexThreadId: "codex-alpha",
      cwd: "/repo-alpha",
      mode: "paired",
      pid: 123,
      status: "running",
      created_at: "2026-03-20T09:00:00.000Z",
      updated_at: "2026-03-20T10:00:00.000Z",
    })
  );
  writeFileSync(
    join(second, "manifest.json"),
    JSON.stringify({
      claudeSessionId: "claude-beta",
      codexThreadId: "codex-beta",
      cwd: "/repo-beta",
      mode: "paired",
      pid: 456,
      repoId: "repo-beta",
      runId: "9",
      status: "done",
      updatedAt: "2026-03-21T10:00:00.000Z",
    })
  );

  const rows = panelInternals.collectLoopRuns(root);
  rmSync(root, { recursive: true, force: true });

  expect(rows).toEqual([
    {
      claudeSessionId: "claude-beta",
      codexThreadId: "codex-beta",
      cwd: "/repo-beta",
      mode: "paired",
      pid: 456,
      repoId: "repo-beta",
      runId: "9",
      state: "completed",
      status: "done",
      updatedAtMs: panelInternals.parseTimestampMs("2026-03-21T10:00:00.000Z"),
    },
    {
      claudeSessionId: "claude-alpha",
      codexThreadId: "codex-alpha",
      cwd: "/repo-alpha",
      mode: "paired",
      pid: 123,
      repoId: "repo-alpha",
      runId: "7",
      state: "working",
      status: "running",
      updatedAtMs: panelInternals.parseTimestampMs("2026-03-20T10:00:00.000Z"),
    },
  ]);
});

test("reconcileDoneRows moves disappeared instance into done section", () => {
  const previous = [
    {
      agent: "codex" as const,
      cwd: "/Users/me/code/loop",
      event: "event_msg/task_complete",
      idle: "0s",
      pid: 54_666,
      session: "session-1",
      state: "active",
    },
  ];
  const next = panelInternals.reconcileDoneRows(previous, [], [], 1000);
  expect(next).toHaveLength(1);
  expect(next[0]).toMatchObject({
    id: "codex:session-1",
    row: previous[0],
  });
  expect(next[0]?.endedAtMs).toBe(1000);
});

test("reconcileDoneRows removes done entry when session is running again", () => {
  const running = [
    {
      agent: "claude" as const,
      cwd: "/Users/me/code/loop",
      event: "progress",
      idle: "0s",
      pid: 88_398,
      session: "session-2",
      state: "active",
    },
  ];
  const existingDone = [
    {
      endedAtMs: 500,
      id: "claude:session-2",
      row: running[0],
    },
  ];
  const next = panelInternals.reconcileDoneRows(
    [],
    running,
    existingDone,
    1000
  );
  expect(next).toHaveLength(0);
});

test("buildLines uses stacked layout on narrow terminals", () => {
  const snapshot = {
    rows: [
      {
        agent: "codex" as const,
        cwd: "/Users/me/some/really/long/path/to/project",
        event: "event_msg/task_complete",
        idle: "2m",
        pid: 54_666,
        session: "session-with-a-very-long-id",
        state: "idle",
      },
    ],
    loopRuns: [
      {
        claudeSessionId: "claude-session-1",
        codexThreadId: "codex-thread-1",
        cwd: "/Users/me/code/loop",
        mode: "paired",
        pid: 100,
        repoId: "repo",
        runId: "1",
        state: "working",
        status: "running",
        updatedAtMs: Date.now() - 5000,
      },
    ],
    tmuxRows: [{ attached: false, id: "3", session: "repo-loop-3" }],
  };
  const doneRows = [
    {
      endedAtMs: Date.now() - 30_000,
      id: "codex:done-session",
      row: {
        agent: "codex" as const,
        cwd: "/Users/me/another/really/long/path/to/project",
        event: "event_msg/task_complete",
        idle: "-",
        pid: -1,
        session: "done-session",
        state: "done",
      },
    },
  ];
  const lines = panelInternals.buildLines(snapshot, doneRows, 60);

  expect(lines).toContain("[running] 1");
  expect(lines).toContain("[done] 1");
  expect(lines).toContain("[tmux] 1");
  expect(lines).toContain("[loop runs] 1");
  expect(
    lines.some((line) => line.startsWith("id=3 session=repo-loop-3"))
  ).toBe(true);
  expect(lines.some((line) => line.startsWith("repo/1"))).toBe(true);
  expect(lines.some((line) => line.includes("claude: claude-session-1"))).toBe(
    true
  );
  expect(lines.some((line) => line.startsWith("session: "))).toBe(true);
  expect(lines.some((line) => line.startsWith("final: "))).toBe(true);
});

test("parseCodexHistoryRow falls back to top-level session keys when payload is missing", () => {
  const dir = mkdtempSync(join(tmpdir(), "loop-codex-history-"));
  const path = join(dir, "session-123.jsonl");
  writeFileSync(
    path,
    `${JSON.stringify({ id: "session-123", cwd: "/repo/example" })}\n${JSON.stringify(
      {
        type: "turn/completed",
      }
    )}\n`
  );
  const row = panelInternals.parseCodexHistoryRow(path);
  rmSync(dir, { recursive: true, force: true });
  expect(row?.row.session).toBe("session-123");
  expect(row?.row.cwd).toBe("/repo/example");
  expect(row?.row.event).toBe("turn/completed");
});
