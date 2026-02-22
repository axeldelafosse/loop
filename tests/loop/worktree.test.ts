import { expect, test } from "bun:test";
import type { Options } from "../../src/loop/types";
import { maybeEnterWorktree, worktreeInternals } from "../../src/loop/worktree";

const makeOptions = (overrides: Partial<Options> = {}): Options => ({
  agent: "codex",
  doneSignal: "<done/>",
  format: "raw",
  maxIterations: 5,
  model: "test-model",
  proof: "verify with tests",
  review: "claudex",
  tmux: false,
  worktree: false,
  ...overrides,
});

test("maybeEnterWorktree is a no-op when --worktree is disabled", () => {
  const gitCalls: string[][] = [];

  maybeEnterWorktree(makeOptions(), {
    runGit: (args: string[]) => {
      gitCalls.push(args);
      return { exitCode: 0, stderr: "", stdout: "" };
    },
  });

  expect(gitCalls).toEqual([]);
});

test("maybeEnterWorktree is a no-op when already in a git worktree", () => {
  const gitCalls: string[][] = [];
  const logs: string[] = [];

  maybeEnterWorktree(makeOptions({ worktree: true }), {
    cwd: () => "/repo-loop-1",
    log: (line: string) => {
      logs.push(line);
    },
    runGit: (args: string[]) => {
      gitCalls.push(args);
      if (args.join(" ") === "rev-parse --show-superproject-working-tree") {
        return {
          exitCode: 0,
          stderr: "",
          stdout: "/repo\n",
        };
      }
      throw new Error(`unexpected git call: ${args.join(" ")}`);
    },
  });

  expect(gitCalls).toEqual([["rev-parse", "--show-superproject-working-tree"]]);
  expect(logs).toContain(
    "[loop] already running inside a git worktree, skipping --worktree setup"
  );
});

test("maybeEnterWorktree is a no-op in linked worktree without superproject path", () => {
  const gitCalls: string[][] = [];
  const logs: string[] = [];

  maybeEnterWorktree(makeOptions({ worktree: true }), {
    cwd: () => "/repo-loop-1",
    log: (line: string) => {
      logs.push(line);
    },
    runGit: (args: string[]) => {
      gitCalls.push(args);
      if (args.join(" ") === "rev-parse --show-superproject-working-tree") {
        return { exitCode: 0, stderr: "", stdout: "" };
      }
      if (args.join(" ") === "rev-parse --git-dir") {
        return {
          exitCode: 0,
          stderr: "",
          stdout: "/tmp/main/.git/worktrees/repo-loop-1\n",
        };
      }
      throw new Error(`unexpected git call: ${args.join(" ")}`);
    },
  });

  expect(gitCalls).toEqual([
    ["rev-parse", "--show-superproject-working-tree"],
    ["rev-parse", "--git-dir"],
  ]);
  expect(logs).toContain(
    "[loop] already running inside a git worktree, skipping --worktree setup"
  );
});

test("maybeEnterWorktree is a no-op when superproject detection fails but git dir is linked", () => {
  const gitCalls: string[][] = [];
  const logs: string[] = [];

  maybeEnterWorktree(makeOptions({ worktree: true }), {
    cwd: () => "/repo-loop-1",
    log: (line: string) => {
      logs.push(line);
    },
    runGit: (args: string[]) => {
      gitCalls.push(args);
      if (args.join(" ") === "rev-parse --show-superproject-working-tree") {
        return { exitCode: 1, stderr: "not a git repo", stdout: "" };
      }
      if (args.join(" ") === "rev-parse --git-dir") {
        return {
          exitCode: 0,
          stderr: "",
          stdout: ".git/worktrees/repo-loop-2",
        };
      }
      throw new Error(`unexpected git call: ${args.join(" ")}`);
    },
  });

  expect(gitCalls).toEqual([
    ["rev-parse", "--show-superproject-working-tree"],
    ["rev-parse", "--git-dir"],
  ]);
  expect(logs).toContain(
    "[loop] already running inside a git worktree, skipping --worktree setup"
  );
});

test("maybeEnterWorktree creates and enters worktree #1", () => {
  const gitCalls: string[][] = [];
  const chdirs: string[] = [];
  const logs: string[] = [];

  maybeEnterWorktree(makeOptions({ worktree: true }), {
    chdir: (path: string) => {
      chdirs.push(path);
    },
    cwd: () => "/repo",
    env: {},
    log: (line: string) => {
      logs.push(line);
    },
    pathExists: () => false,
    runGit: (args: string[]) => {
      gitCalls.push(args);
      if (args.join(" ") === "rev-parse --show-toplevel") {
        return { exitCode: 0, stderr: "", stdout: "/repo\n" };
      }
      if (args.join(" ") === "rev-parse --verify HEAD") {
        return { exitCode: 0, stderr: "", stdout: "abc123\n" };
      }
      if (
        args.join(" ") === "show-ref --verify --quiet refs/heads/repo-loop-1"
      ) {
        return { exitCode: 1, stderr: "", stdout: "" };
      }
      return { exitCode: 0, stderr: "", stdout: "" };
    },
  });

  expect(gitCalls).toEqual([
    ["rev-parse", "--show-superproject-working-tree"],
    ["rev-parse", "--git-dir"],
    ["rev-parse", "--show-toplevel"],
    ["rev-parse", "--verify", "HEAD"],
    ["show-ref", "--verify", "--quiet", "refs/heads/repo-loop-1"],
    ["worktree", "add", "-b", "repo-loop-1", "/repo-loop-1"],
  ]);
  expect(chdirs).toEqual(["/repo-loop-1"]);
  expect(logs).toContain('[loop] created worktree "/repo-loop-1"');
  expect(logs).toContain('[loop] switched to branch "repo-loop-1"');
});

const makeWorktreeRunGit = () => (args: string[]) => {
  const cmd = args.join(" ");
  if (cmd === "rev-parse --show-toplevel") {
    return { exitCode: 0, stderr: "", stdout: "/repo\n" };
  }
  if (cmd === "rev-parse --verify HEAD") {
    return { exitCode: 0, stderr: "", stdout: "abc123\n" };
  }
  if (cmd === "show-ref --verify --quiet refs/heads/repo-loop-1") {
    return { exitCode: 1, stderr: "", stdout: "" };
  }
  return { exitCode: 0, stderr: "", stdout: "" };
};

test("maybeEnterWorktree moves PLAN.md into the worktree root", () => {
  const moved: Array<{ source: string; target: string }> = [];

  maybeEnterWorktree(makeOptions({ worktree: true }), {
    chdir: (): void => undefined,
    cwd: () => "/repo",
    env: {},
    log: (): void => undefined,
    pathExists: (path: string) =>
      path === "/repo-loop-1" || path === "/repo/PLAN.md",
    runGit: makeWorktreeRunGit(),
    moveFile: (source: string, target: string) => {
      moved.push({ source, target });
    },
  });

  expect(moved).toEqual([
    { source: "/repo/PLAN.md", target: "/repo-loop-1/PLAN.md" },
  ]);
});

test("maybeEnterWorktree moves PLAN.md into the worktree subpath", () => {
  const moved: Array<{ source: string; target: string }> = [];

  maybeEnterWorktree(makeOptions({ worktree: true }), {
    chdir: (): void => undefined,
    cwd: () => "/repo/src",
    env: {},
    log: (): void => undefined,
    pathExists: (path: string) =>
      path === "/repo-loop-1/src" || path === "/repo/src/PLAN.md",
    runGit: makeWorktreeRunGit(),
    moveFile: (source: string, target: string) => {
      moved.push({ source, target });
    },
  });

  expect(moved).toEqual([
    { source: "/repo/src/PLAN.md", target: "/repo-loop-1/src/PLAN.md" },
  ]);
});

test("maybeEnterWorktree increments index when branch name is taken", () => {
  const gitCalls: string[][] = [];

  maybeEnterWorktree(makeOptions({ worktree: true }), {
    chdir: (): void => undefined,
    cwd: () => "/repo",
    env: {},
    log: (): void => undefined,
    pathExists: () => false,
    runGit: (args: string[]) => {
      gitCalls.push(args);
      if (args.join(" ") === "rev-parse --show-toplevel") {
        return { exitCode: 0, stderr: "", stdout: "/repo\n" };
      }
      if (args.join(" ") === "rev-parse --verify HEAD") {
        return { exitCode: 0, stderr: "", stdout: "abc123\n" };
      }
      if (
        args.join(" ") === "show-ref --verify --quiet refs/heads/repo-loop-1"
      ) {
        return { exitCode: 0, stderr: "", stdout: "deadbeef\n" };
      }
      if (
        args.join(" ") === "show-ref --verify --quiet refs/heads/repo-loop-2"
      ) {
        return { exitCode: 1, stderr: "", stdout: "" };
      }
      return { exitCode: 0, stderr: "", stdout: "" };
    },
  });

  expect(gitCalls).toContainEqual([
    "show-ref",
    "--verify",
    "--quiet",
    "refs/heads/repo-loop-1",
  ]);
  expect(gitCalls).toContainEqual([
    "show-ref",
    "--verify",
    "--quiet",
    "refs/heads/repo-loop-2",
  ]);
  expect(gitCalls).toContainEqual([
    "worktree",
    "add",
    "-b",
    "repo-loop-2",
    "/repo-loop-2",
  ]);
});

test("maybeEnterWorktree copies files when repo has no commits", () => {
  const copied: Array<{ source: string; target: string }> = [];
  const logs: string[] = [];

  maybeEnterWorktree(makeOptions({ worktree: true }), {
    chdir: (): void => undefined,
    cwd: () => "/repo",
    env: {},
    log: (line: string) => {
      logs.push(line);
    },
    pathExists: () => false,
    runGit: (args: string[]) => {
      if (args.join(" ") === "rev-parse --show-toplevel") {
        return { exitCode: 0, stderr: "", stdout: "/repo\n" };
      }
      if (args.join(" ") === "rev-parse --verify HEAD") {
        return {
          exitCode: 1,
          stderr: "fatal: Needed a single revision",
          stdout: "",
        };
      }
      if (
        args.join(" ") === "show-ref --verify --quiet refs/heads/repo-loop-1"
      ) {
        return { exitCode: 1, stderr: "", stdout: "" };
      }
      return { exitCode: 0, stderr: "", stdout: "" };
    },
    syncTree: (source: string, target: string) => {
      copied.push({ source, target });
    },
  });

  expect(copied).toEqual([{ source: "/repo", target: "/repo-loop-1" }]);
  expect(logs).toContain(
    "[loop] repo has no commits yet. copied current files into worktree."
  );
});

test("maybeEnterWorktree honors requested run id from env", () => {
  const gitCalls: string[][] = [];

  maybeEnterWorktree(makeOptions({ worktree: true }), {
    chdir: (): void => undefined,
    cwd: () => "/repo",
    env: { LOOP_RUN_BASE: "repo", LOOP_RUN_ID: "4" },
    log: (): void => undefined,
    pathExists: () => false,
    runGit: (args: string[]) => {
      gitCalls.push(args);
      if (args.join(" ") === "rev-parse --show-toplevel") {
        return { exitCode: 0, stderr: "", stdout: "/repo\n" };
      }
      if (args.join(" ") === "rev-parse --verify HEAD") {
        return { exitCode: 0, stderr: "", stdout: "abc123\n" };
      }
      if (
        args.join(" ") === "show-ref --verify --quiet refs/heads/repo-loop-4"
      ) {
        return { exitCode: 1, stderr: "", stdout: "" };
      }
      return { exitCode: 0, stderr: "", stdout: "" };
    },
  });

  expect(gitCalls).toContainEqual([
    "worktree",
    "add",
    "-b",
    "repo-loop-4",
    "/repo-loop-4",
  ]);
});

test("maybeEnterWorktree prunes stale registration and retries same id", () => {
  const gitCalls: string[][] = [];

  maybeEnterWorktree(makeOptions({ worktree: true }), {
    chdir: (): void => undefined,
    cwd: () => "/repo",
    env: { LOOP_RUN_BASE: "repo", LOOP_RUN_ID: "1" },
    log: (): void => undefined,
    pathExists: () => false,
    runGit: (args: string[]) => {
      gitCalls.push(args);
      const cmd = args.join(" ");
      if (cmd === "rev-parse --show-toplevel") {
        return { exitCode: 0, stderr: "", stdout: "/repo\n" };
      }
      if (cmd === "rev-parse --verify HEAD") {
        return { exitCode: 0, stderr: "", stdout: "abc123\n" };
      }
      if (cmd === "show-ref --verify --quiet refs/heads/repo-loop-1") {
        return { exitCode: 1, stderr: "", stdout: "" };
      }
      if (
        cmd === "worktree add -b repo-loop-1 /repo-loop-1" &&
        gitCalls.filter((row) => row.join(" ") === cmd).length === 1
      ) {
        return {
          exitCode: 1,
          stderr:
            "fatal: '/repo-loop-1' is a missing but already registered worktree",
          stdout: "",
        };
      }
      return { exitCode: 0, stderr: "", stdout: "" };
    },
  });

  expect(gitCalls).toContainEqual(["worktree", "prune"]);
  expect(
    gitCalls.filter(
      (args: string[]) =>
        args.join(" ") === "worktree add -b repo-loop-1 /repo-loop-1"
    )
  ).toHaveLength(2);
});

test("maybeEnterWorktree surfaces git errors clearly", () => {
  expect(() =>
    maybeEnterWorktree(makeOptions({ worktree: true }), {
      env: {},
      runGit: () => ({
        exitCode: 1,
        stderr: "fatal: not a git repository",
        stdout: "",
      }),
    })
  ).toThrow(
    "[loop] failed to resolve git repo root: fatal: not a git repository"
  );
});

test("worktree internals build numbered names", () => {
  expect(worktreeInternals.buildWorktreeBranch("repo", 3)).toBe("repo-loop-3");
  expect(worktreeInternals.buildWorktreePath("/Users/me/repo", "repo", 2)).toBe(
    "/Users/me/repo-loop-2"
  );
});

test("worktree internals detect conflicts", () => {
  expect(worktreeInternals.isWorktreeConflict("already exists")).toBe(true);
  expect(worktreeInternals.isWorktreeConflict("already checked out")).toBe(
    true
  );
  expect(worktreeInternals.isWorktreeConflict("boom")).toBe(false);
});

test("worktree internals detect stale registration errors", () => {
  expect(
    worktreeInternals.isStaleWorktreeRegistration(
      "missing but already registered worktree"
    )
  ).toBe(true);
  expect(worktreeInternals.isStaleWorktreeRegistration("boom")).toBe(false);
});

test("worktree internals sanitize base names", () => {
  expect(worktreeInternals.sanitizeBase("My Repo")).toBe("my-repo");
});
