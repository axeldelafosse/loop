import { spawnSync } from "bun";

export interface GitResult {
  exitCode: number;
  stderr: string;
  stdout: string;
}

const SAFE_NAME_RE = /[^a-z0-9-]+/g;
const MAIN_BRANCHES = new Set(["main", "master"]);

export const decode = (value: Uint8Array | null | undefined): string =>
  value ? new TextDecoder().decode(value).trim() : "";

export const sanitizeBase = (value: string): string => {
  const cleaned = value
    .toLowerCase()
    .replace(SAFE_NAME_RE, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned || "loop";
};

export const buildLoopName = (base: string, index: number): string =>
  `${base}-loop-${index}`;

export const runGit = (
  cwd: string,
  args: string[],
  stderr: "pipe" | "ignore" = "pipe"
): GitResult => {
  const result = spawnSync(["git", ...args], {
    cwd,
    stderr,
    stdout: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stderr: stderr === "ignore" ? "" : decode(result.stderr),
    stdout: decode(result.stdout),
  };
};

export const checkGitState = (
  deps: { runGit?: (args: string[]) => GitResult } = {}
): string | undefined => {
  const git = deps.runGit ?? ((args: string[]) => runGit(process.cwd(), args));

  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch.exitCode !== 0) {
    return undefined;
  }

  const current = branch.stdout;
  if (!MAIN_BRANCHES.has(current)) {
    return `[loop] heads up: on branch "${current}", not main`;
  }

  const behind = git(["rev-list", "--count", "HEAD..@{upstream}"]);
  if (behind.exitCode !== 0) {
    return undefined;
  }

  const count = Number.parseInt(behind.stdout, 10);
  if (count > 0) {
    const commits = count === 1 ? "1 commit" : `${count} commits`;
    return `[loop] heads up: local ${current} is ${commits} behind remote`;
  }
  return undefined;
};
