import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve as resolvePath } from "node:path";
import {
  type GitResult,
  runGit as runGitCommand,
  sanitizeBase,
  validateRunId,
} from "./git";
import type {
  Agent,
  ReviewStatus,
  RunLifecycleState,
  RunStatus,
} from "./types";

const RUNS_ROOT = join(".loop", "runs");
const MANIFEST_FILE = "manifest.json";
const TRANSCRIPT_FILE = "transcript.jsonl";
const LINE_SPLIT_RE = /\r?\n/;
const ACTIVE_RUN_STATES = new Set<RunLifecycleState>([
  "submitted",
  "working",
  "reviewing",
  "input-required",
]);

const isRunLifecycleState = (value: string): value is RunLifecycleState =>
  value === "submitted" ||
  value === "working" ||
  value === "reviewing" ||
  value === "input-required" ||
  value === "completed" ||
  value === "failed" ||
  value === "stopped";

const isReviewStatus = (value: string): value is ReviewStatus =>
  value === "pass" || value === "fail";

export interface RunStorage {
  manifestPath: string;
  repoId: string;
  runDir: string;
  runId: string;
  storageRoot: string;
  transcriptPath: string;
}

export interface RunManifest {
  claudeSessionId: string;
  codexRemoteUrl?: string;
  codexThreadId: string;
  createdAt: string;
  cwd: string;
  mode: string;
  pid: number;
  repoId: string;
  runId: string;
  state: RunLifecycleState;
  status: RunStatus;
  tmuxSession?: string;
  updatedAt: string;
}

export interface RunMessageTranscriptEntry {
  at: string;
  from: string;
  kind?: "message";
  message: string;
  to?: string;
}

export interface RunStatusTranscriptEntry {
  at: string;
  detail?: string;
  kind: "status";
  state: RunLifecycleState;
}

export interface RunReviewTranscriptEntry {
  at: string;
  kind: "review";
  reason?: string;
  reviewer: Agent;
  status: ReviewStatus;
}

export interface RunResultTranscriptEntry {
  at: string;
  detail?: string;
  kind: "result";
  result:
    | "done-signal-detected"
    | "failed"
    | "max-iterations-reached"
    | "stopped";
}

export type RunTranscriptEntry =
  | RunMessageTranscriptEntry
  | RunResultTranscriptEntry
  | RunReviewTranscriptEntry
  | RunStatusTranscriptEntry;

const RUN_INDEX_RE = /^\d+$/;

export interface RunState {
  manifest?: RunManifest;
  storage: RunStorage;
  transcript: RunTranscriptEntry[];
}

interface RepoIdDeps {
  runGit: (args: string[]) => GitResult;
}

interface RunManifestInput {
  claudeSessionId?: string;
  codexRemoteUrl?: string;
  codexThreadId?: string;
  createdAt?: string;
  cwd: string;
  mode: string;
  pid: number;
  repoId: string;
  runId: string;
  state?: RunLifecycleState;
  status?: string;
  tmuxSession?: string;
  updatedAt?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const asInteger = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isInteger(value) ? value : undefined;

const firstString = (
  obj: Record<string, unknown>,
  keys: string[]
): string | undefined => {
  for (const key of keys) {
    const value = asString(obj[key]);
    if (value) {
      return value;
    }
  }
  return undefined;
};

const firstInteger = (
  obj: Record<string, unknown>,
  keys: string[]
): number | undefined => {
  for (const key of keys) {
    const value = obj[key];
    const integer = asInteger(value);
    if (integer !== undefined) {
      return integer;
    }
    if (typeof value === "string") {
      const parsed = Number.parseInt(value, 10);
      if (Number.isInteger(parsed)) {
        return parsed;
      }
    }
  }
  return undefined;
};

const optionalRunId = (runId: string | undefined): string | undefined => {
  if (!runId) {
    return undefined;
  }
  try {
    return validateRunId(runId);
  } catch {
    return undefined;
  }
};

const trimToken = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

export const parseRunLifecycleState = (
  state: string | undefined,
  status?: string
): RunLifecycleState | undefined => {
  if (state && isRunLifecycleState(state)) {
    return state;
  }
  if (!status) {
    return undefined;
  }
  if (isRunLifecycleState(status)) {
    return status;
  }
  if (status === "active" || status === "running") {
    return "working";
  }
  if (status === "done") {
    return "completed";
  }
  return undefined;
};

export const runStatusFromState = (state: RunLifecycleState): RunStatus => {
  if (state === "completed") {
    return "done";
  }
  if (state === "failed") {
    return "failed";
  }
  if (state === "stopped") {
    return "stopped";
  }
  return "running";
};

export const isActiveRunState = (state: RunLifecycleState): boolean =>
  ACTIVE_RUN_STATES.has(state);

export const setRunManifestState = (
  manifest: RunManifest,
  state: RunLifecycleState,
  now = new Date().toISOString()
): RunManifest => ({
  ...manifest,
  state,
  status: runStatusFromState(state),
  updatedAt: now,
});

const gitText = (
  cwd: string,
  args: string[],
  deps?: Partial<RepoIdDeps>
): string | undefined => {
  const runGit =
    deps?.runGit ?? ((gitArgs: string[]) => runGitCommand(cwd, gitArgs));
  const result = runGit(args);
  if (result.exitCode !== 0) {
    return undefined;
  }
  const text = result.stdout.trim();
  return text ? resolvePath(cwd, text) : undefined;
};

const hashSeed = (value: string): string =>
  createHash("sha256").update(value).digest("hex").slice(0, 12);

const buildRepoId = (label: string, seed: string): string =>
  `${sanitizeBase(label)}-${hashSeed(seed)}`;

const ensureParentDir = (path: string): void => {
  mkdirSync(dirname(path), { recursive: true });
};

const readRunIndices = (path: string): number[] => {
  if (!existsSync(path)) {
    return [];
  }
  try {
    return readdirSync(path)
      .filter((name) => RUN_INDEX_RE.test(name))
      .map((name) => Number.parseInt(name, 10))
      .filter((value) => Number.isInteger(value) && value > 0)
      .sort((a, b) => a - b);
  } catch {
    return [];
  }
};

const readStoredRunIds = (path: string): string[] => {
  if (!existsSync(path)) {
    return [];
  }
  try {
    return readdirSync(path)
      .filter((name) => {
        try {
          validateRunId(name);
          return true;
        } catch {
          return false;
        }
      })
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  } catch {
    return [];
  }
};

export const resolveStorageRoot = (home = process.env.HOME ?? ""): string =>
  join(home || process.cwd(), RUNS_ROOT);

export const resolveRunId = (
  storageRoot: string,
  repoId: string,
  env: NodeJS.ProcessEnv = {}
): string => {
  const requested = asString(env.LOOP_RUN_ID);
  if (requested) {
    return validateRunId(requested);
  }

  const repoDir = join(storageRoot, repoId);
  const indices = readRunIndices(repoDir);
  const next = indices.at(-1) ?? 0;
  return String(next + 1);
};

export const resolveRepoId = (
  cwd = process.cwd(),
  deps?: Partial<RepoIdDeps>
): string => {
  const commonDir = gitText(
    cwd,
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    deps
  );
  if (commonDir) {
    return buildRepoId(basename(dirname(commonDir)), commonDir);
  }

  const topLevel = gitText(
    cwd,
    ["rev-parse", "--path-format=absolute", "--show-toplevel"],
    deps
  );
  if (topLevel) {
    return buildRepoId(basename(topLevel), topLevel);
  }

  return buildRepoId(basename(cwd) || "loop", cwd);
};

export const buildRunDir = (
  storageRoot: string,
  repoId: string,
  runId: string
): string => join(storageRoot, repoId, validateRunId(runId));

export const buildManifestPath = (runDir: string): string =>
  join(runDir, MANIFEST_FILE);

export const buildTranscriptPath = (runDir: string): string =>
  join(runDir, TRANSCRIPT_FILE);

export const resolveRunStorage = (
  runId: string,
  cwd = process.cwd(),
  home = process.env.HOME ?? "",
  deps?: Partial<RepoIdDeps>
): RunStorage => {
  const repoId = resolveRepoId(cwd, deps);
  const storageRoot = resolveStorageRoot(home);
  const runDir = buildRunDir(storageRoot, repoId, runId);
  return {
    manifestPath: buildManifestPath(runDir),
    repoId,
    runDir,
    runId: validateRunId(runId),
    storageRoot,
    transcriptPath: buildTranscriptPath(runDir),
  };
};

export const resolveExistingRunId = (
  runId: string | undefined,
  cwd = process.cwd(),
  home = process.env.HOME ?? "",
  deps?: Partial<RepoIdDeps>
): string | undefined => {
  const selector = trimToken(runId);
  if (!selector) {
    return undefined;
  }

  const candidate = optionalRunId(selector);
  if (candidate) {
    const storage = resolveRunStorage(candidate, cwd, home, deps);
    if (readRunManifest(storage.manifestPath)) {
      return candidate;
    }
  }

  const repoId = resolveRepoId(cwd, deps);
  const repoDir = join(resolveStorageRoot(home), repoId);
  for (const storedRunId of readStoredRunIds(repoDir)) {
    const manifestPath = buildManifestPath(join(repoDir, storedRunId));
    const manifest = readRunManifest(manifestPath);
    if (!manifest) {
      continue;
    }
    if (
      manifest.claudeSessionId === selector ||
      manifest.codexThreadId === selector
    ) {
      return manifest.runId;
    }
  }
  return undefined;
};

export const ensureRunStorage = (storage: RunStorage): void => {
  mkdirSync(storage.runDir, { recursive: true });
  if (!existsSync(storage.transcriptPath)) {
    writeFileSync(storage.transcriptPath, "", "utf8");
  }
};

export const updateRunManifest = (
  manifestPath: string,
  update: (manifest: RunManifest | undefined) => RunManifest | undefined
): RunManifest | undefined => {
  const next = update(readRunManifest(manifestPath));
  if (!next) {
    return undefined;
  }
  writeRunManifest(manifestPath, next);
  return next;
};

export const createRunManifest = (
  input: RunManifestInput,
  now = new Date().toISOString()
): RunManifest => {
  const state =
    input.state ??
    parseRunLifecycleState(undefined, input.status) ??
    "submitted";
  return {
    claudeSessionId: input.claudeSessionId ?? "",
    ...(input.codexRemoteUrl ? { codexRemoteUrl: input.codexRemoteUrl } : {}),
    codexThreadId: input.codexThreadId ?? "",
    createdAt: input.createdAt ?? now,
    cwd: input.cwd,
    mode: input.mode,
    pid: input.pid,
    repoId: input.repoId,
    runId: validateRunId(input.runId),
    state,
    status: runStatusFromState(state),
    ...(input.tmuxSession ? { tmuxSession: input.tmuxSession } : {}),
    updatedAt: input.updatedAt ?? now,
  };
};

export const touchRunManifest = (
  manifest: RunManifest,
  now = new Date().toISOString()
): RunManifest => ({
  ...manifest,
  status: runStatusFromState(manifest.state),
  updatedAt: now,
});

export const writeRunManifest = (
  manifestPath: string,
  manifest: RunManifest
): void => {
  ensureParentDir(manifestPath);
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
};

export const readRunManifest = (
  manifestPath: string
): RunManifest | undefined => {
  if (!existsSync(manifestPath)) {
    return undefined;
  }

  try {
    const raw = readFileSync(manifestPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) {
      return undefined;
    }

    const runId = firstString(parsed, ["runId", "run_id"]);
    const repoId = firstString(parsed, ["repoId", "repo_id"]);
    const cwd = firstString(parsed, ["cwd"]);
    const mode = firstString(parsed, ["mode"]);
    const rawState = firstString(parsed, ["state"]);
    const status = firstString(parsed, ["status"]);
    const createdAt = firstString(parsed, ["createdAt", "created_at"]);
    const updatedAt = firstString(parsed, ["updatedAt", "updated_at"]);
    const pid = firstInteger(parsed, ["pid"]);
    const state = parseRunLifecycleState(rawState, status);
    if (!(runId && repoId)) {
      return undefined;
    }
    if (!cwd) {
      return undefined;
    }
    if (!mode) {
      return undefined;
    }
    if (!(status || state)) {
      return undefined;
    }
    if (!createdAt) {
      return undefined;
    }
    if (!updatedAt) {
      return undefined;
    }
    if (pid === undefined) {
      return undefined;
    }

    return {
      claudeSessionId:
        firstString(parsed, ["claudeSessionId", "claude_session_id"]) ?? "",
      ...(firstString(parsed, ["codexRemoteUrl", "codex_remote_url"])
        ? {
            codexRemoteUrl: firstString(parsed, [
              "codexRemoteUrl",
              "codex_remote_url",
            ]),
          }
        : {}),
      codexThreadId:
        firstString(parsed, ["codexThreadId", "codex_thread_id"]) ?? "",
      createdAt,
      cwd,
      mode,
      pid,
      repoId,
      runId,
      state: state ?? "working",
      status: state ? runStatusFromState(state) : "running",
      ...(firstString(parsed, ["tmuxSession", "tmux_session"])
        ? {
            tmuxSession: firstString(parsed, ["tmuxSession", "tmux_session"]),
          }
        : {}),
      updatedAt,
    };
  } catch {
    return undefined;
  }
};

export const loadRunState = (
  runId: string,
  cwd = process.cwd(),
  home = process.env.HOME ?? "",
  deps?: Partial<RepoIdDeps>
): RunState => {
  const storage = resolveRunStorage(runId, cwd, home, deps);
  return {
    manifest: readRunManifest(storage.manifestPath),
    storage,
    transcript: readRunTranscriptEntries(storage.transcriptPath),
  };
};

export const createRunTranscriptEntry = (
  from: string,
  message: string,
  to?: string,
  at = new Date().toISOString()
): RunMessageTranscriptEntry => ({
  at,
  from,
  message,
  to,
});

export const createRunStatusEntry = (
  state: RunLifecycleState,
  detail?: string,
  at = new Date().toISOString()
): RunStatusTranscriptEntry => ({
  at,
  ...(detail ? { detail } : {}),
  kind: "status",
  state,
});

export const createRunReviewEntry = (
  reviewer: Agent,
  status: ReviewStatus,
  reason?: string,
  at = new Date().toISOString()
): RunReviewTranscriptEntry => ({
  at,
  kind: "review",
  ...(reason ? { reason } : {}),
  reviewer,
  status,
});

export const createRunResultEntry = (
  result: RunResultTranscriptEntry["result"],
  detail?: string,
  at = new Date().toISOString()
): RunResultTranscriptEntry => ({
  at,
  ...(detail ? { detail } : {}),
  kind: "result",
  result,
});

const parseStatusTranscriptEntry = (
  parsed: Record<string, unknown>,
  at: string
): RunStatusTranscriptEntry | undefined => {
  const state = parseRunLifecycleState(asString(parsed.state));
  const detail = asString(parsed.detail);
  return state
    ? {
        at,
        ...(detail ? { detail } : {}),
        kind: "status",
        state,
      }
    : undefined;
};

const parseReviewTranscriptEntry = (
  parsed: Record<string, unknown>,
  at: string
): RunReviewTranscriptEntry | undefined => {
  const reviewer =
    parsed.reviewer === "claude" || parsed.reviewer === "codex"
      ? parsed.reviewer
      : undefined;
  const reason = asString(parsed.reason);
  const status =
    typeof parsed.status === "string" && isReviewStatus(parsed.status)
      ? parsed.status
      : undefined;
  if (!(reviewer && status)) {
    return undefined;
  }
  return {
    at,
    kind: "review",
    ...(reason ? { reason } : {}),
    reviewer,
    status,
  };
};

const parseResultTranscriptEntry = (
  parsed: Record<string, unknown>,
  at: string
): RunResultTranscriptEntry | undefined => {
  const result = asString(parsed.result);
  const detail = asString(parsed.detail);
  if (
    !(
      result === "done-signal-detected" ||
      result === "failed" ||
      result === "max-iterations-reached" ||
      result === "stopped"
    )
  ) {
    return undefined;
  }
  return {
    at,
    ...(detail ? { detail } : {}),
    kind: "result",
    result,
  };
};

const parseMessageTranscriptEntry = (
  parsed: Record<string, unknown>,
  at: string,
  kind: string | undefined
): RunMessageTranscriptEntry | undefined => {
  const from = asString(parsed.from);
  const message = asString(parsed.message);
  if (!(from && message)) {
    return undefined;
  }
  return {
    at,
    from,
    kind: kind === "message" ? "message" : undefined,
    message,
    to: asString(parsed.to),
  };
};

const parseRunTranscriptEntry = (
  parsed: Record<string, unknown>
): RunTranscriptEntry | undefined => {
  const at = asString(parsed.at);
  if (!at) {
    return undefined;
  }

  const kind = asString(parsed.kind);
  if (kind === "status") {
    return parseStatusTranscriptEntry(parsed, at);
  }
  if (kind === "review") {
    return parseReviewTranscriptEntry(parsed, at);
  }
  if (kind === "result") {
    return parseResultTranscriptEntry(parsed, at);
  }
  return parseMessageTranscriptEntry(parsed, at, kind);
};

export const appendRunTranscriptEntry = (
  transcriptPath: string,
  entry: RunTranscriptEntry
): void => {
  ensureParentDir(transcriptPath);
  appendFileSync(transcriptPath, `${JSON.stringify(entry)}\n`, "utf8");
};

export const readRunTranscriptEntries = (
  transcriptPath: string
): RunTranscriptEntry[] => {
  if (!existsSync(transcriptPath)) {
    return [];
  }

  const entries: RunTranscriptEntry[] = [];
  for (const line of readFileSync(transcriptPath, "utf8").split(
    LINE_SPLIT_RE
  )) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (!isRecord(parsed)) {
        continue;
      }
      const entry = parseRunTranscriptEntry(parsed);
      if (entry) {
        entries.push(entry);
      }
    } catch {
      // ignore malformed transcript lines
    }
  }
  return entries;
};
