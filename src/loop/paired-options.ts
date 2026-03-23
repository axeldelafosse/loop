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
  manifest?: RunManifest;
  storage: RunStorage;
}

const resolveRequestedRunId = (
  opts: Options,
  cwd: string
): string | undefined => {
  if (opts.resumeRunId) {
    const runId = resolveExistingRunId(opts.resumeRunId, cwd);
    if (!runId) {
      throw new Error(`[loop] paired run "${opts.resumeRunId}" does not exist`);
    }
    return runId;
  }

  if (!opts.sessionId?.trim()) {
    return undefined;
  }

  return resolveExistingRunId(opts.sessionId, cwd);
};

const pairedSessionIds = (
  opts: Options,
  manifest?: RunManifest
): PairedSessionIds | undefined => {
  const sessionId = opts.sessionId?.trim();
  let fallback: PairedSessionIds | undefined;
  if (sessionId && !(manifest?.claudeSessionId || manifest?.codexThreadId)) {
    fallback =
      opts.agent === "claude" ? { claude: sessionId } : { codex: sessionId };
  }
  const claude = manifest?.claudeSessionId || fallback?.claude || undefined;
  const codex = manifest?.codexThreadId || fallback?.codex || undefined;
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
  const requested = resolveRequestedRunId(opts, cwd);
  const repoId = resolveRepoId(cwd);
  const storageRoot = resolveStorageRoot();
  const runId = requested ?? resolveRunId(storageRoot, repoId, process.env);
  process.env.LOOP_RUN_ID = runId;
  const storage = resolveRunStorage(runId, cwd);
  ensureRunStorage(storage);
  const existingManifest = readRunManifest(storage.manifestPath);
  if (existingManifest) {
    return { manifest: existingManifest, storage };
  }

  if (!createManifest) {
    return { storage };
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
  return { manifest, storage };
};

export const applyPairedOptions = (
  opts: Options,
  storage: RunStorage,
  manifest?: RunManifest
): void => {
  opts.claudeMcpConfigPath = ensureClaudeBridgeConfig(storage.runDir, "claude");
  opts.claudePersistentSession = true;
  opts.codexMcpConfigArgs = buildCodexBridgeConfigArgs(storage.runDir, "codex");
  opts.pairedMode = true;
  opts.pairedSessionIds = pairedSessionIds(opts, manifest);
};

export const preparePairedOptions = (
  opts: Options,
  cwd = process.cwd(),
  createManifest = true
): void => {
  const { manifest, storage } = resolvePreparedRunState(
    opts,
    cwd,
    createManifest
  );
  applyPairedOptions(opts, storage, manifest);
};
