import { cpSync, existsSync, readdirSync, rmSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { buildLoopName, runGit, sanitizeBase } from "./git";
import type { Options } from "./types";

interface GitResult {
  exitCode: number;
  stderr: string;
  stdout: string;
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

const buildWorktreeBranch = (base: string, index: number): string =>
  buildLoopName(base, index);

const buildWorktreePath = (
  repoRoot: string,
  base: string,
  index: number
): string => join(dirname(repoRoot), buildWorktreeBranch(base, index));

const isWorktreeConflict = (stderr: string): boolean =>
  WORKTREE_CONFLICT_RE.test(stderr);

const isStaleWorktreeRegistration = (stderr: string): boolean =>
  STALE_WORKTREE_RE.test(stderr);

const addWorktree = (
  deps: WorktreeDeps,
  branch: string,
  path: string
): GitResult => deps.runGit(["worktree", "add", "-b", branch, path]);

const addWorktreeWithPruneRetry = (
  deps: WorktreeDeps,
  branch: string,
  path: string
): GitResult => {
  const first = addWorktree(deps, branch, path);
  if (first.exitCode === 0 || !isStaleWorktreeRegistration(first.stderr)) {
    return first;
  }

  deps.runGit(["worktree", "prune"]);
  return addWorktree(deps, branch, path);
};

const parseRunId = (value: string | undefined): number | undefined => {
  const parsed = Number(value);
  if (Number.isInteger(parsed) && parsed > 0) {
    return parsed;
  }
  return undefined;
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
  const requestedId = parseRunId(deps.env[RUN_ID_ENV]);
  let branch = "";
  let worktreePath = "";
  const tryCreateWorktree = (
    index: number
  ): { branch: string; worktreePath: string } | undefined => {
    const candidateBranch = buildWorktreeBranch(runBase, index);
    const candidatePath = buildWorktreePath(repoRoot, runBase, index);

    const branchExists =
      deps.runGit([
        "show-ref",
        "--verify",
        "--quiet",
        `refs/heads/${candidateBranch}`,
      ]).exitCode === 0;
    if (branchExists) {
      return undefined;
    }

    const result = addWorktreeWithPruneRetry(
      deps,
      candidateBranch,
      candidatePath
    );
    if (result.exitCode === 0) {
      return { branch: candidateBranch, worktreePath: candidatePath };
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

  if (requestedId !== undefined) {
    const selected = tryCreateWorktree(requestedId);
    if (!selected) {
      throw new Error(
        `[loop] requested worktree id ${requestedId} is not available.`
      );
    }
    branch = selected.branch;
    worktreePath = selected.worktreePath;
  } else {
    for (let index = 1; index <= MAX_WORKTREE_ATTEMPTS; index++) {
      const selected = tryCreateWorktree(index);
      if (!selected) {
        continue;
      }
      branch = selected.branch;
      worktreePath = selected.worktreePath;
      break;
    }
  }

  if (!(branch && worktreePath)) {
    throw new Error(
      "[loop] failed to create git worktree: no free worktree name found."
    );
  }
  if (!hasHead) {
    deps.syncTree(repoRoot, worktreePath);
    deps.log(
      "[loop] repo has no commits yet. copied current files into worktree."
    );
  }

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
  deps.log(`[loop] created worktree "${worktreePath}"`);
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
