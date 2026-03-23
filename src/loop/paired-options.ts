import { buildCodexBridgeConfigArgs, ensureClaudeBridgeConfig } from "./bridge";
import {
  createRunManifest,
  ensureRunStorage,
  type RunManifest,
  type RunStorage,
  readRunManifest,
  resolveExistingRunId,
  resolveRepoId,
  resolveRunId,
  resolveRunStorage,
  resolveStorageRoot,
  writeRunManifest,
} from "./run-state";
import type { Options, PairedSessionIds } from "./types";

export interface PreparedRunState {
  allowRawSessionFallback: boolean;
  manifest?: RunManifest;
  storage: RunStorage;
}

interface RequestedRunState {
  allowRawSessionFallback: boolean;
  runId?: string;
}

export const canResumePairedManifest = (manifest?: RunManifest): boolean => {
  const status = manifest?.status;
  return status === "running" || status === "active";
};

const resolveRequestedRunState = (
  opts: Options,
  cwd: string
): RequestedRunState => {
  if (opts.resumeRunId) {
    const runId = resolveExistingRunId(opts.resumeRunId, cwd);
    if (!runId) {
      throw new Error(`[loop] paired run "${opts.resumeRunId}" does not exist`);
    }
    return { allowRawSessionFallback: false, runId };
  }

  if (!opts.sessionId?.trim()) {
    return { allowRawSessionFallback: false };
  }

  const runId = resolveExistingRunId(opts.sessionId, cwd);
  if (runId) {
    return { allowRawSessionFallback: false, runId };
  }
  return { allowRawSessionFallback: true };
};

const pairedSessionIds = (
  opts: Options,
  manifest: RunManifest | undefined,
  allowRawSessionFallback: boolean
): PairedSessionIds | undefined => {
  const stored = canResumePairedManifest(manifest) ? manifest : undefined;
  const sessionId = opts.sessionId?.trim();
  let fallback: PairedSessionIds | undefined;
  if (
    allowRawSessionFallback &&
    sessionId &&
    !(stored?.claudeSessionId || stored?.codexThreadId)
  ) {
    fallback =
      opts.agent === "claude" ? { claude: sessionId } : { codex: sessionId };
  }
  const claude = stored?.claudeSessionId || fallback?.claude || undefined;
  const codex = stored?.codexThreadId || fallback?.codex || undefined;
  if (!(claude || codex)) {
    return undefined;
  }
  return { claude, codex };
};

export const resolvePreparedRunState = (
  opts: Options,
  cwd = process.cwd(),
  createManifest = true
): PreparedRunState => {
  const requested = resolveRequestedRunState(opts, cwd);
  const repoId = resolveRepoId(cwd);
  const storageRoot = resolveStorageRoot();
  const runId =
    requested.runId ?? resolveRunId(storageRoot, repoId, process.env);
  process.env.LOOP_RUN_ID = runId;
  const storage = resolveRunStorage(runId, cwd);
  ensureRunStorage(storage);
  const existingManifest = readRunManifest(storage.manifestPath);
  if (existingManifest) {
    return {
      allowRawSessionFallback: requested.allowRawSessionFallback,
      manifest: existingManifest,
      storage,
    };
  }

  if (!createManifest) {
    return {
      allowRawSessionFallback: requested.allowRawSessionFallback,
      storage,
    };
  }

  const manifest = createRunManifest({
    claudeSessionId: "",
    codexThreadId: "",
    cwd,
    mode: "paired",
    pid: process.pid,
    repoId: storage.repoId,
    runId: storage.runId,
    status: "running",
  });
  writeRunManifest(storage.manifestPath, manifest);
  return {
    allowRawSessionFallback: requested.allowRawSessionFallback,
    manifest,
    storage,
  };
};

export const applyPairedOptions = (
  opts: Options,
  storage: RunStorage,
  manifest: RunManifest | undefined,
  allowRawSessionFallback = false
): void => {
  opts.claudeMcpConfigPath = ensureClaudeBridgeConfig(storage.runDir, "claude");
  opts.claudePersistentSession = true;
  opts.codexMcpConfigArgs = buildCodexBridgeConfigArgs(storage.runDir, "codex");
  opts.pairedMode = true;
  opts.pairedSessionIds = pairedSessionIds(
    opts,
    manifest,
    allowRawSessionFallback
  );
};

export const preparePairedOptions = (
  opts: Options,
  cwd = process.cwd(),
  createManifest = true
): void => {
  const { allowRawSessionFallback, manifest, storage } =
    resolvePreparedRunState(opts, cwd, createManifest);
  applyPairedOptions(opts, storage, manifest, allowRawSessionFallback);
};
