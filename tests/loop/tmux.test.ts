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

const makeTempHome = (): string => mkdtempSync(join(tmpdir(), "loop-tmux-"));

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
  const command =
    "'env' 'LOOP_RUN_BASE=repo' 'LOOP_RUN_ID=1' 'bun' '/repo/src/cli.ts' '--proof' 'verify' 'fix bug'";

  const delegated = runInTmux(["--tmux", "--proof", "verify", "fix bug"], {
    attach: (session: string) => {
      attaches.push(session);
    },
    cwd: "/repo",
    env: {},
    findBinary: () => true,
    isInteractive: () => true,
    launchArgv: ["bun", "/repo/src/cli.ts"],
    log: (line: string) => {
      logs.push(line);
    },
    spawn: (args: string[]) => {
      calls.push(args);
      return { exitCode: 0, stderr: "" };
    },
  });

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
  expect(logs).toContain('[loop] started tmux session "repo-loop-1"');
  expect(logs).toContain("[loop] attach with: tmux attach -t repo-loop-1");
  expect(attaches).toEqual(["repo-loop-1"]);
});

test("runInTmux keeps explicit run id in single-agent mode", () => {
  const calls: string[][] = [];
  let sessionStarted = false;

  const delegated = runInTmux(
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

test("runInTmux resolves paired run id through an existing manifest", async () => {
  await withTempHomeRunManifest("alpha", (home) => {
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

    const delegated = runInTmux(
      ["--tmux", "--run-id", "alpha", "--proof", "verify"],
      {
        attach: (session: string) => {
          attaches.push(session);
        },
        cwd: process.cwd(),
        env: { HOME: home },
        findBinary: () => true,
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

test("runInTmux rejects unknown run id before starting tmux session", () => {
  const calls: string[][] = [];
  const home = makeTempHome();

  try {
    expect(() =>
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
    ).toThrow('[loop] paired run "typo" does not exist');
    expect(calls).toEqual([]);
  } finally {
    rmSync(home, { force: true, recursive: true });
  }
});

test("runInTmux honors paired run resume from --session", async () => {
  await withTempHomeRunManifest("alpha", (home) => {
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

    const delegated = runInTmux(
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

test("runInTmux resolves paired resume from a worktree using git common dir", () => {
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

  const delegated = runInTmux(
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

test("runInTmux strips a worktree suffix when git metadata is unavailable", () => {
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

  const delegated = runInTmux(
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
    (home) => {
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

      const delegated = runInTmux(
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

test("runInTmux ignores an unresolved raw session id in paired mode", () => {
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
    const delegated = runInTmux(
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

test("runInTmux keeps raw --session values in single-agent mode", () => {
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

    const delegated = runInTmux(
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

test("runInTmux reports when tmux session exits before attach", () => {
  const runBase = tmuxInternals.sanitizeBase(basename(process.cwd()));
  expect(() =>
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
  ).toThrow(
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
