import { cpSync, existsSync, readdirSync, rmSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { buildLoopName, runGit, sanitizeBase } from "./git";
import { resolveExistingRunId } from "./run-state";
import type { Options } from "./types";

interface GitResult {
  exitCode: number;
  stderr: string;
  stdout: string;
}

interface SelectedWorktree {
  branch: string;
  existing: boolean;
  runId: string;
  worktreePath: string;
}

interface WorktreeDeps {
  chdir: (path: string) => void;
  cwd: () => string;
  env: NodeJS.ProcessEnv;
  log: (line: string) => void;
  moveFile: (source: string, target: string) => void;
  pathExists: (path: string) => boolean;
  runGit: (args: string[]) => GitResult;
  syncTree: (source: string, target: string) => void;
}

const MAX_WORKTREE_ATTEMPTS = 10_000;
const RUN_BASE_ENV = "LOOP_RUN_BASE";
const RUN_ID_ENV = "LOOP_RUN_ID";
const PLAN_FILE = "PLAN.md";
const WORKTREE_CONFLICT_RE = /already exists|already checked out|not locked/i;
const STALE_WORKTREE_RE =
  /missing but already registered worktree|already registered worktree/i;
const WORKTREE_GIT_DIR_MARKER = ".git/worktrees/";

const isInside = (root: string, path: string): boolean => {
  const rel = relative(root, path);
  if (!rel) {
    return true;
  }
  if (isAbsolute(rel)) {
    return false;
  }
  return !rel.startsWith("..");
};

const buildWorktreeBranch = (base: string, runId: string | number): string =>
  buildLoopName(base, runId);

const buildWorktreePath = (
  repoRoot: string,
  base: string,
  runId: string | number
): string => join(dirname(repoRoot), buildWorktreeBranch(base, runId));

const isWorktreeConflict = (stderr: string): boolean =>
  WORKTREE_CONFLICT_RE.test(stderr);

const isStaleWorktreeRegistration = (stderr: string): boolean =>
  STALE_WORKTREE_RE.test(stderr);

const addWorktree = (deps: WorktreeDeps, args: string[]): GitResult =>
  deps.runGit(["worktree", "add", ...args]);

const addWorktreeWithPruneRetry = (
  deps: WorktreeDeps,
  args: string[]
): GitResult => {
  const first = addWorktree(deps, args);
  if (first.exitCode === 0 || !isStaleWorktreeRegistration(first.stderr)) {
    return first;
  }

  deps.runGit(["worktree", "prune"]);
  return addWorktree(deps, args);
};

const buildSelectedWorktree = (
  branch: string,
  existing: boolean,
  runId: string,
  worktreePath: string
): SelectedWorktree => ({
  branch,
  existing,
  runId,
  worktreePath,
});

const reenterWorktree = (
  deps: WorktreeDeps,
  candidateBranch: string,
  candidatePath: string,
  runId: string
): SelectedWorktree | undefined => {
  const result = addWorktreeWithPruneRetry(deps, [
    candidatePath,
    candidateBranch,
  ]);
  if (result.exitCode === 0) {
    return buildSelectedWorktree(candidateBranch, true, runId, candidatePath);
  }
  if (
    isWorktreeConflict(result.stderr) ||
    isStaleWorktreeRegistration(result.stderr)
  ) {
    return undefined;
  }
  const suffix = result.stderr ? `: ${result.stderr}` : "";
  throw new Error(`[loop] failed to re-enter git worktree${suffix}`);
};

const createWorktree = (
  deps: WorktreeDeps,
  candidateBranch: string,
  candidatePath: string,
  runId: string
): SelectedWorktree | undefined => {
  const result = addWorktreeWithPruneRetry(deps, [
    "-b",
    candidateBranch,
    candidatePath,
  ]);
  if (result.exitCode === 0) {
    return buildSelectedWorktree(candidateBranch, false, runId, candidatePath);
  }
  if (
    isWorktreeConflict(result.stderr) ||
    isStaleWorktreeRegistration(result.stderr)
  ) {
    return undefined;
  }

  const suffix = result.stderr ? `: ${result.stderr}` : "";
  throw new Error(`[loop] failed to create git worktree${suffix}`);
};

const parseToken = (value: string | undefined): string | undefined => {
  const token = value?.trim();
  if (token) {
    return token;
  }
  return undefined;
};

const resolveRequestedRunId = (
  opts: Options,
  cwd: string,
  env: NodeJS.ProcessEnv
): string | undefined => {
  const runId = parseToken(opts.resumeRunId);
  if (runId) {
    if (opts.pairedMode === false) {
      return runId;
    }

    const resolved = resolveExistingRunId(
      runId,
      cwd,
      env.HOME ?? process.env.HOME ?? ""
    );
    if (!resolved) {
      throw new Error(`[loop] paired run "${runId}" does not exist`);
    }
    return resolved;
  }

  if (opts.pairedMode === false) {
    return parseToken(env[RUN_ID_ENV]);
  }

  const sessionId = parseToken(opts.sessionId);
  if (!sessionId) {
    return parseToken(env[RUN_ID_ENV]);
  }

  const sessionRunId = resolveExistingRunId(
    sessionId,
    cwd,
    env.HOME ?? process.env.HOME ?? ""
  );
  if (sessionRunId) {
    return sessionRunId;
  }

  return parseToken(env[RUN_ID_ENV]);
};

const resolveWorktreeSelection = (
  deps: WorktreeDeps,
  repoRoot: string,
  runBase: string,
  requestedId: string | undefined
): SelectedWorktree => {
  const selectWorktree = (
    runId: string,
    allowReuse: boolean
  ): SelectedWorktree | undefined => {
    const candidateBranch = buildWorktreeBranch(runBase, runId);
    const candidatePath = buildWorktreePath(repoRoot, runBase, runId);

    const branchExists =
      deps.runGit([
        "show-ref",
        "--verify",
        "--quiet",
        `refs/heads/${candidateBranch}`,
      ]).exitCode === 0;
    if (!branchExists) {
      return createWorktree(deps, candidateBranch, candidatePath, runId);
    }

    if (!allowReuse) {
      return undefined;
    }

    if (deps.pathExists(candidatePath)) {
      return buildSelectedWorktree(candidateBranch, true, runId, candidatePath);
    }

    return reenterWorktree(deps, candidateBranch, candidatePath, runId);
  };

  if (requestedId !== undefined) {
    const selected = selectWorktree(requestedId, true);
    if (!selected) {
      throw new Error(
        `[loop] requested worktree id ${requestedId} is not available.`
      );
    }
    return selected;
  }

  for (let index = 1; index <= MAX_WORKTREE_ATTEMPTS; index += 1) {
    const selected = selectWorktree(String(index), false);
    if (selected) {
      return selected;
    }
  }

  throw new Error(
    "[loop] failed to create git worktree: no free worktree name found."
  );
};

const gitOutput = (
  deps: WorktreeDeps,
  args: string[],
  message: string
): string => {
  const result = deps.runGit(args);
  if (result.exitCode !== 0) {
    const suffix = result.stderr ? `: ${result.stderr}` : "";
    throw new Error(`${message}${suffix}`);
  }
  return result.stdout.trim();
};

const defaultDeps = (): WorktreeDeps => ({
  chdir: (path: string) => {
    process.chdir(path);
  },
  cwd: () => process.cwd(),
  env: process.env,
  log: (line: string) => {
    console.log(line);
  },
  pathExists: (path: string) => existsSync(path),
  moveFile: (source: string, target: string) => {
    cpSync(source, target, { force: true });
    rmSync(source, { force: true });
  },
  runGit: (args: string[]) => {
    try {
      return runGit(process.cwd(), args);
    } catch {
      throw new Error("Error: git is not installed. Install git first.");
    }
  },
  syncTree: (source: string, target: string) => {
    for (const name of readdirSync(source)) {
      if (name === ".git") {
        continue;
      }
      cpSync(join(source, name), join(target, name), {
        force: true,
        recursive: true,
      });
    }
  },
});

const buildWorktreeCwd = (
  repoRoot: string,
  currentCwd: string,
  worktreePath: string,
  pathExists: (path: string) => boolean
): string => {
  if (!isInside(repoRoot, currentCwd)) {
    return worktreePath;
  }

  const rel = relative(repoRoot, currentCwd);
  if (!rel) {
    return worktreePath;
  }

  const candidate = join(worktreePath, rel);
  if (!pathExists(candidate)) {
    return worktreePath;
  }

  return candidate;
};

export const maybeEnterWorktree = (
  opts: Options,
  overrides: Partial<WorktreeDeps> = {}
): void => {
  if (!opts.worktree) {
    return;
  }

  const deps = { ...defaultDeps(), ...overrides };
  const currentCwd = deps.cwd();
  const superProject = deps.runGit([
    "rev-parse",
    "--show-superproject-working-tree",
  ]);
  let inWorktree =
    superProject.exitCode === 0 && Boolean(superProject.stdout.trim());

  if (!inWorktree) {
    const gitDir = deps.runGit(["rev-parse", "--git-dir"]).stdout.trim();
    inWorktree = gitDir.replaceAll("\\", "/").includes(WORKTREE_GIT_DIR_MARKER);
  }

  if (inWorktree) {
    deps.log(
      "[loop] already running inside a git worktree, skipping --worktree setup"
    );
    return;
  }

  const repoRoot = gitOutput(
    deps,
    ["rev-parse", "--show-toplevel"],
    "[loop] failed to resolve git repo root"
  );
  const hasHead = deps.runGit(["rev-parse", "--verify", "HEAD"]).exitCode === 0;
  const runBase = sanitizeBase(deps.env[RUN_BASE_ENV] ?? basename(repoRoot));
  const requestedId = resolveRequestedRunId(opts, currentCwd, deps.env);
  const selected = resolveWorktreeSelection(
    deps,
    repoRoot,
    runBase,
    requestedId
  );
  const {
    branch,
    existing: reusedExisting,
    runId: selectedRunId,
    worktreePath,
  } = selected;
  if (!hasHead) {
    deps.syncTree(repoRoot, worktreePath);
    deps.log(
      "[loop] repo has no commits yet. copied current files into worktree."
    );
  }

  deps.env[RUN_BASE_ENV] = runBase;
  deps.env[RUN_ID_ENV] = selectedRunId;

  const worktreeCwd = buildWorktreeCwd(
    repoRoot,
    currentCwd,
    worktreePath,
    deps.pathExists
  );
  const sourcePlanPath = join(currentCwd, PLAN_FILE);
  if (deps.pathExists(sourcePlanPath)) {
    deps.moveFile(sourcePlanPath, join(worktreeCwd, PLAN_FILE));
  }
  deps.chdir(worktreeCwd);
  deps.log(
    `[loop] ${reusedExisting ? "re-entered" : "created"} worktree "${worktreePath}"`
  );
  deps.log(`[loop] switched to branch "${branch}"`);
};

export const worktreeInternals = {
  buildWorktreeBranch,
  buildWorktreeCwd,
  buildWorktreePath,
  isInside,
  isStaleWorktreeRegistration,
  isWorktreeConflict,
  sanitizeBase,
};
