import { expect, test } from "bun:test";
import {
  runInTmux,
  TMUX_MISSING_ERROR,
  tmuxInternals,
} from "../../src/loop/tmux";

test("runInTmux returns false when --tmux is not present", () => {
  const delegated = runInTmux(["--proof", "verify"], {
    findBinary: () => true,
  });

  expect(delegated).toBe(false);
});

test("runInTmux returns false when already inside tmux", () => {
  const delegated = runInTmux(["--tmux", "--proof", "verify"], {
    env: { TMUX: "1" },
  });

  expect(delegated).toBe(false);
});

test("runInTmux throws install message when tmux is missing", () => {
  expect(() =>
    runInTmux(["--tmux", "--proof", "verify"], {
      env: {},
      findBinary: () => false,
    })
  ).toThrow(TMUX_MISSING_ERROR);
});

test("runInTmux starts detached session and strips --tmux", () => {
  const calls: string[][] = [];
  const attaches: string[] = [];
  const logs: string[] = [];

  const delegated = runInTmux(["--tmux", "--proof", "verify", "fix bug"], {
    attach: (session: string) => {
      attaches.push(session);
    },
    cwd: "/repo",
    env: {},
    findBinary: () => true,
    isInteractive: () => true,
    launchArgv: ["bun", "/repo/src/loop.ts"],
    log: (line: string) => {
      logs.push(line);
    },
    spawn: (args: string[]) => {
      calls.push(args);
      return { exitCode: 0, stderr: "" };
    },
  });

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
      "'env' 'LOOP_RUN_BASE=repo' 'LOOP_RUN_ID=1' 'bun' '/repo/src/loop.ts' '--proof' 'verify' 'fix bug'",
    ],
  ]);
  expect(logs).toContain('[loop] started tmux session "repo-loop-1"');
  expect(logs).toContain("[loop] attach with: tmux attach -t repo-loop-1");
  expect(attaches).toEqual(["repo-loop-1"]);
});

test("runInTmux increments session index on conflicts", () => {
  const calls: string[][] = [];
  const delegated = runInTmux(["--tmux", "--proof", "verify"], {
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
      return { exitCode: 0, stderr: "" };
    },
  });

  expect(delegated).toBe(true);
  expect(calls[0]?.[4]).toBe("repo-loop-1");
  expect(calls[1]?.[4]).toBe("repo-loop-2");
});

test("runInTmux surfaces tmux startup errors", () => {
  expect(() =>
    runInTmux(["--tmux", "--proof", "verify"], {
      env: {},
      findBinary: () => true,
      spawn: () => ({ exitCode: 1, stderr: "boom" }),
    })
  ).toThrow("Failed to start tmux session: boom");
});

test("runInTmux skips auto-attach for non-interactive sessions", () => {
  const attaches: string[] = [];

  const delegated = runInTmux(["--tmux", "--proof", "verify"], {
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

test("tmux internals strip --tmux from forwarded args", () => {
  expect(tmuxInternals.stripTmuxFlag(["--tmux", "--proof", "verify"])).toEqual([
    "--proof",
    "verify",
  ]);
});

test("tmux internals build launch argv from exec path", () => {
  expect(
    tmuxInternals.buildLaunchArgv(
      ["/usr/local/bin/bun", "src/loop.ts", "--tmux", "--proof", "verify"],
      "/usr/local/bin/bun"
    )
  ).toEqual(["/usr/local/bin/bun", `${process.cwd()}/src/loop.ts`]);
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
