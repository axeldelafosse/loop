import { existsSync } from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  resolve as resolvePath,
} from "node:path";
import { spawnSync } from "bun";
import { buildLoopName, decode, runGit, sanitizeBase } from "./git";

export const TMUX_FLAG = "--tmux";
export const TMUX_MISSING_ERROR =
  "Error: tmux is not installed. Install tmux with: brew install tmux";
const WORKTREE_FLAG = "--worktree";
const RUN_BASE_ENV = "LOOP_RUN_BASE";
const RUN_ID_ENV = "LOOP_RUN_ID";

interface SpawnResult {
  exitCode: number;
  stderr: string;
}

interface TmuxDeps {
  attach: (session: string) => void;
  cwd: string;
  env: NodeJS.ProcessEnv;
  findBinary: (cmd: string) => boolean;
  isInteractive: () => boolean;
  launchArgv: string[];
  log: (line: string) => void;
  spawn: (args: string[]) => SpawnResult;
}

const quoteShellArg = (value: string): string =>
  `'${value.replaceAll("'", "'\\''")}'`;

const buildShellCommand = (argv: string[]): string =>
  argv.map(quoteShellArg).join(" ");

const stripTmuxFlag = (argv: string[]): string[] =>
  argv.filter((arg) => arg !== TMUX_FLAG);
const isScriptPath = (path: string): boolean =>
  path.endsWith(".ts") ||
  path.endsWith(".tsx") ||
  path.endsWith(".js") ||
  path.endsWith(".mjs") ||
  path.endsWith(".cjs");
const isBunExecutable = (value: string): boolean => {
  const file = basename(value);
  return file === "bun" || file === "bun.exe";
};

const MAX_SESSION_ATTEMPTS = 10_000;
const SESSION_CONFLICT_RE = /duplicate session|already exists/i;
const NO_SESSION_RE = /no sessions|couldn't find session|session .* not found/i;
const resolveRunBase = (cwd: string): string => {
  try {
    const repoRoot = runGit(cwd, ["rev-parse", "--show-toplevel"], "ignore");
    if (repoRoot.exitCode === 0 && repoRoot.stdout) {
      return sanitizeBase(basename(repoRoot.stdout));
    }
  } catch {
    return sanitizeBase(basename(cwd));
  }
  return sanitizeBase(basename(cwd));
};

const buildRunName = (base: string, index: number): string =>
  buildLoopName(base, index);

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

const buildLaunchArgv = (
  processArgv: string[] = process.argv,
  execPath: string = process.execPath
): string[] => {
  const scriptArg = processArgv[1];
  const commandPath = processArgv[0];
  if (
    !scriptArg ||
    scriptArg.startsWith("-") ||
    scriptArg.startsWith("/$bunfs/")
  ) {
    if (
      !(commandPath && isAbsolute(commandPath)) ||
      isBunExecutable(commandPath)
    ) {
      return [execPath];
    }
    return [commandPath];
  }
  const scriptPath = isAbsolute(scriptArg) ? scriptArg : resolvePath(scriptArg);
  if (isBunExecutable(execPath) || isScriptPath(scriptPath)) {
    return [execPath, scriptPath];
  }
  return commandPath ? [commandPath] : [execPath];
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
  spawn: (args: string[]) => {
    const result = spawnSync(args, { stderr: "pipe" });
    return { exitCode: result.exitCode, stderr: decode(result.stderr) };
  },
});

const findSession = (argv: string[], deps: TmuxDeps): string => {
  const forwardedArgv = stripTmuxFlag(argv);
  const runBase = resolveRunBase(deps.cwd);
  const needsWorktree = argv.includes(WORKTREE_FLAG);

  for (let index = 1; index <= MAX_SESSION_ATTEMPTS; index++) {
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
