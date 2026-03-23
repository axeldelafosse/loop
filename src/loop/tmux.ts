import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { spawnSync } from "bun";
import { buildLoopName, decode, runGit, sanitizeBase } from "./git";
import { buildLaunchArgv } from "./launch";
import { resolveExistingRunId } from "./run-state";

export const TMUX_FLAG = "--tmux";
export const TMUX_MISSING_ERROR =
  "Error: tmux is not installed. Install tmux with: brew install tmux";
const WORKTREE_FLAG = "--worktree";
const RUN_ID_FLAG = "--run-id";
const SESSION_FLAG = "--session";
const ONLY_MODE_FLAGS = ["--claude-only", "--codex-only"] as const;
const RUN_BASE_ENV = "LOOP_RUN_BASE";
const RUN_ID_ENV = "LOOP_RUN_ID";

interface SpawnResult {
  exitCode: number;
  stderr: string;
}

interface GitResult {
  exitCode: number;
  stderr: string;
  stdout: string;
}

interface TmuxDeps {
  attach: (session: string) => void;
  cwd: string;
  env: NodeJS.ProcessEnv;
  findBinary: (cmd: string) => boolean;
  isInteractive: () => boolean;
  launchArgv: string[];
  log: (line: string) => void;
  runGit: (cwd: string, args: string[]) => GitResult;
  spawn: (args: string[]) => SpawnResult;
}

const quoteShellArg = (value: string): string =>
  `'${value.replaceAll("'", "'\\''")}'`;

const buildShellCommand = (argv: string[]): string =>
  argv.map(quoteShellArg).join(" ");

const stripTmuxFlag = (argv: string[]): string[] =>
  argv.filter((arg) => arg !== TMUX_FLAG);

const parseToken = (argv: string[], flag: string): string | undefined => {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg.startsWith(`${flag}=`)) {
      const value = arg.slice(flag.length + 1).trim();
      if (value) {
        return value;
      }
      throw new Error(`Invalid ${flag} value: cannot be empty`);
    }
    if (arg === flag) {
      const value = argv[index + 1];
      if (!value || value.startsWith("-")) {
        throw new Error(`Missing value for ${flag}`);
      }
      const token = value.trim();
      if (token) {
        return token;
      }
      throw new Error(`Invalid ${flag} value: cannot be empty`);
    }
  }
  return undefined;
};

const resolveRequestedRunId = (
  argv: string[],
  deps: TmuxDeps
): string | undefined => {
  const runId = parseToken(argv, RUN_ID_FLAG);
  const singleAgentMode = ONLY_MODE_FLAGS.some((flag) => argv.includes(flag));
  if (runId) {
    if (singleAgentMode) {
      return runId;
    }
    const resolved = (() => {
      try {
        return resolveExistingRunId(
          runId,
          deps.cwd,
          deps.env.HOME ?? process.env.HOME ?? ""
        );
      } catch {
        return undefined;
      }
    })();
    if (!resolved) {
      if (cwdMatchesRunId(deps.cwd, runId)) {
        return runId;
      }
      throw new Error(`[loop] paired run "${runId}" does not exist`);
    }
    return resolved;
  }

  const sessionId = parseToken(argv, SESSION_FLAG);
  if (!sessionId) {
    return undefined;
  }

  if (singleAgentMode) {
    return undefined;
  }

  const resolved = (() => {
    try {
      return resolveExistingRunId(
        sessionId,
        deps.cwd,
        deps.env.HOME ?? process.env.HOME ?? ""
      );
    } catch {
      return undefined;
    }
  })();
  if (!resolved) {
    if (cwdMatchesRunId(deps.cwd, sessionId)) {
      return sessionId;
    }
    return undefined;
  }
  return resolved;
};

const cwdMatchesRunId = (cwd: string, runId: string): boolean => {
  const base = sanitizeBase(basename(cwd));
  return base.endsWith(`-loop-${sanitizeBase(runId)}`);
};

const MAX_SESSION_ATTEMPTS = 10_000;
const SESSION_CONFLICT_RE = /duplicate session|already exists/i;
const NO_SESSION_RE = /no sessions|couldn't find session|session .* not found/i;
const LOOP_WORKTREE_SUFFIX_RE = /-loop-[a-z0-9][a-z0-9_-]*$/i;

const stripLoopSuffix = (value: string): string =>
  value.replace(LOOP_WORKTREE_SUFFIX_RE, "") || value;

const resolveRunBase = (
  cwd: string,
  deps: TmuxDeps,
  requestedId?: string
): string => {
  const gitResult = (args: string[]): GitResult | undefined => {
    try {
      return deps.runGit(cwd, args);
    } catch {
      return undefined;
    }
  };

  const commonDir = gitResult([
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]);
  if (commonDir?.exitCode === 0 && commonDir.stdout) {
    return sanitizeBase(basename(dirname(commonDir.stdout)));
  }

  const topLevel = gitResult([
    "rev-parse",
    "--path-format=absolute",
    "--show-toplevel",
  ]);
  if (topLevel?.exitCode === 0 && topLevel.stdout) {
    return sanitizeBase(basename(topLevel.stdout));
  }

  const base = sanitizeBase(basename(cwd));
  if (requestedId) {
    const requestedSuffix = `-loop-${sanitizeBase(requestedId)}`;
    if (base.endsWith(requestedSuffix)) {
      return stripLoopSuffix(base.slice(0, -requestedSuffix.length));
    }
  }
  return stripLoopSuffix(base);
};

const buildRunName = (base: string, runId: string | number): string =>
  buildLoopName(base, runId);

const worktreeAvailable = (cwd: string, runName: string): boolean => {
  const repoRoot = (() => {
    try {
      return runGit(cwd, ["rev-parse", "--show-toplevel"], "ignore");
    } catch {
      return undefined;
    }
  })();

  if (!repoRoot) {
    return true;
  }

  if (repoRoot.exitCode !== 0 || !repoRoot.stdout) {
    return true;
  }

  const path = join(dirname(repoRoot.stdout), runName);
  if (existsSync(path)) {
    return false;
  }

  const branch = (() => {
    try {
      return runGit(
        cwd,
        ["show-ref", "--verify", "--quiet", `refs/heads/${runName}`],
        "ignore"
      );
    } catch {
      return undefined;
    }
  })();
  if (!branch) {
    return true;
  }

  if (branch.exitCode === 0) {
    return false;
  }

  return true;
};

const commandExists = (cmd: string): boolean => {
  try {
    spawnSync([cmd, "-V"], { stderr: "ignore", stdout: "ignore" });
    return true;
  } catch {
    return false;
  }
};

const isSessionConflict = (stderr: string): boolean =>
  SESSION_CONFLICT_RE.test(stderr);

const sessionExists = (
  session: string,
  spawnFn: TmuxDeps["spawn"]
): boolean => {
  const result = spawnFn(["tmux", "has-session", "-t", session]);
  return result.exitCode === 0;
};

const keepSessionAttached = (
  session: string,
  spawnFn: TmuxDeps["spawn"]
): void => {
  spawnFn([
    "tmux",
    "set-window-option",
    "-t",
    `${session}:0`,
    "remain-on-exit",
    "on",
  ]);
};

const isSessionGone = (
  session: string,
  error: unknown,
  spawnFn: TmuxDeps["spawn"]
): boolean =>
  !sessionExists(session, spawnFn) ||
  (error instanceof Error && NO_SESSION_RE.test(error.message));

const buildSessionCommand = (
  deps: TmuxDeps,
  env: string[],
  forwardedArgv: string[]
): string => {
  return buildShellCommand([
    "env",
    ...env,
    ...deps.launchArgv,
    ...forwardedArgv,
  ]);
};

const startRequestedSession = (
  deps: TmuxDeps,
  runBase: string,
  requestedId: string,
  forwardedArgv: string[]
): string => {
  const candidate = buildRunName(runBase, requestedId);
  const existingSession = sessionExists(candidate, deps.spawn);
  if (existingSession) {
    return candidate;
  }

  const command = buildSessionCommand(
    deps,
    [`${RUN_BASE_ENV}=${runBase}`, `${RUN_ID_ENV}=${requestedId}`],
    forwardedArgv
  );
  const result = deps.spawn([
    "tmux",
    "new-session",
    "-d",
    "-s",
    candidate,
    "-c",
    deps.cwd,
    command,
  ]);
  if (result.exitCode === 0) {
    return candidate;
  }

  const suffix = result.stderr ? `: ${result.stderr}` : ".";
  throw new Error(`Failed to start tmux session${suffix}`);
};

const startAutoSession = (
  deps: TmuxDeps,
  runBase: string,
  forwardedArgv: string[],
  needsWorktree: boolean
): string => {
  for (let index = 1; index <= MAX_SESSION_ATTEMPTS; index += 1) {
    const candidate = buildRunName(runBase, index);
    if (needsWorktree && !worktreeAvailable(deps.cwd, candidate)) {
      continue;
    }

    const command = buildSessionCommand(
      deps,
      [`${RUN_BASE_ENV}=${runBase}`, `${RUN_ID_ENV}=${index}`],
      forwardedArgv
    );
    const result = deps.spawn([
      "tmux",
      "new-session",
      "-d",
      "-s",
      candidate,
      "-c",
      deps.cwd,
      command,
    ]);
    if (result.exitCode === 0) {
      return candidate;
    }
    if (!isSessionConflict(result.stderr)) {
      const suffix = result.stderr ? `: ${result.stderr}` : ".";
      throw new Error(`Failed to start tmux session${suffix}`);
    }
  }

  return "";
};

const defaultDeps = (): TmuxDeps => ({
  attach: (session: string) => {
    const result = spawnSync(["tmux", "attach", "-t", session], {
      stderr: "inherit",
      stdin: "inherit",
      stdout: "inherit",
    });
    if (result.exitCode !== 0) {
      throw new Error(`Failed to attach to tmux session "${session}".`);
    }
  },
  cwd: process.cwd(),
  env: process.env,
  findBinary: (cmd: string) => commandExists(cmd),
  isInteractive: () => Boolean(process.stdin.isTTY && process.stdout.isTTY),
  launchArgv: buildLaunchArgv(),
  log: (line: string) => {
    console.log(line);
  },
  runGit: (cwd: string, args: string[]) => runGit(cwd, args),
  spawn: (args: string[]) => {
    const result = spawnSync(args, { stderr: "pipe" });
    return { exitCode: result.exitCode, stderr: decode(result.stderr) };
  },
});

const findSession = (argv: string[], deps: TmuxDeps): string => {
  const forwardedArgv = stripTmuxFlag(argv);
  const requestedId = resolveRequestedRunId(argv, deps);
  const runBase = resolveRunBase(deps.cwd, deps, requestedId);
  const needsWorktree = argv.includes(WORKTREE_FLAG);

  if (requestedId !== undefined) {
    return startRequestedSession(deps, runBase, requestedId, forwardedArgv);
  }

  return startAutoSession(deps, runBase, forwardedArgv, needsWorktree);
};

const attachSessionIfInteractive = (
  session: string,
  deps: TmuxDeps
): boolean => {
  if (!deps.isInteractive()) {
    return true;
  }

  try {
    deps.attach(session);
    return true;
  } catch (error: unknown) {
    if (isSessionGone(session, error, deps.spawn)) {
      deps.log(
        `[loop] tmux session "${session}" exited before attach, continuing here.`
      );
      return false;
    }
    throw error instanceof Error
      ? error
      : new Error(`Failed to attach to tmux session "${session}".`);
  }
};

export const runInTmux = (
  argv: string[],
  overrides: Partial<TmuxDeps> = {}
): boolean => {
  if (!argv.includes(TMUX_FLAG)) {
    return false;
  }

  const deps = { ...defaultDeps(), ...overrides };
  if (deps.env.TMUX) {
    return false;
  }

  if (!deps.findBinary("tmux")) {
    throw new Error(TMUX_MISSING_ERROR);
  }

  const session = findSession(argv, deps);

  if (!session) {
    throw new Error(
      "Failed to start tmux session: no free session name found."
    );
  }

  if (!sessionExists(session, deps.spawn)) {
    throw new Error(`tmux session "${session}" exited before attach.`);
  }

  keepSessionAttached(session, deps.spawn);

  deps.log(`[loop] started tmux session "${session}"`);
  deps.log(`[loop] attach with: tmux attach -t ${session}`);
  return attachSessionIfInteractive(session, deps);
};

export const tmuxInternals = {
  buildLaunchArgv,
  buildRunName,
  buildShellCommand,
  isSessionConflict,
  quoteShellArg,
  sanitizeBase,
  stripTmuxFlag,
  worktreeAvailable,
};
