import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { spawn, spawnSync } from "bun";
import { BRIDGE_SERVER, BRIDGE_SUBCOMMAND } from "./bridge";
import { getCodexAppServerUrl, getLastCodexThreadId } from "./codex-app-server";
import {
  CODEX_TMUX_PROXY_SUBCOMMAND,
  findCodexTmuxProxyPort,
  waitForCodexTmuxProxy,
} from "./codex-tmux-proxy";
import { DEFAULT_CLAUDE_MODEL } from "./constants";
import { buildLoopName, decode, runGit, sanitizeBase } from "./git";
import { buildLaunchArgv } from "./launch";
import { preparePairedRun } from "./paired-options";
import { DETACH_CHILD_PROCESS } from "./process";
import {
  type RunManifest,
  type RunStorage,
  resolveExistingRunId,
  touchRunManifest,
  updateRunManifest,
} from "./run-state";
import { startPersistentAgentSession } from "./runner";
import type { Agent, Options } from "./types";

export const TMUX_FLAG = "--tmux";
export const TMUX_MISSING_ERROR =
  "Error: tmux is not installed. Install tmux with: brew install tmux";
const WORKTREE_FLAG = "--worktree";
const RUN_ID_FLAG = "--run-id";
const SESSION_FLAG = "--session";
const ONLY_MODE_FLAGS = ["--claude-only", "--codex-only"] as const;
const RUN_BASE_ENV = "LOOP_RUN_BASE";
const RUN_ID_ENV = "LOOP_RUN_ID";
const CLAUDE_TRUST_PROMPT = "Is this a project you created or one you trust?";
const CLAUDE_BYPASS_PROMPT = "running in Bypass Permissions mode";
const CLAUDE_CHANNEL_SCOPE = "local";
const CLAUDE_PROMPT_INITIAL_POLLS = 8;
const CLAUDE_PROMPT_POLL_DELAY_MS = 250;
const CLAUDE_PROMPT_SETTLE_POLLS = 2;
const CODEX_READY_POLL_DELAY_MS = 250;
const CODEX_READY_POLLS = 20;
const CODEX_SEND_FOOTER = "Ctrl+J newline";
const MCP_ALREADY_EXISTS_RE = /already exists/i;
const PROMPT_DISPATCH_DELAY_MS = 500;
const REVIEWER_BOOT_DELAY_MS = 1500;

interface SpawnResult {
  exitCode: number;
  stderr: string;
}

interface TerminalSize {
  columns: number;
  rows: number;
}

interface GitResult {
  exitCode: number;
  stderr: string;
  stdout: string;
}

interface TmuxDeps {
  attach: (session: string) => void;
  capturePane: (pane: string) => string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  findBinary: (cmd: string) => boolean;
  getCodexAppServerUrl: () => string;
  getLastCodexThreadId: () => string;
  getTerminalSize: () => TerminalSize | undefined;
  isInteractive: () => boolean;
  launchArgv: string[];
  log: (line: string) => void;
  makeClaudeSessionId: () => string;
  preparePairedRun: typeof preparePairedRun;
  runGit: (cwd: string, args: string[]) => GitResult;
  sendKeys: (pane: string, keys: string[]) => void;
  sendText: (pane: string, text: string) => void;
  sleep: (ms: number) => Promise<void>;
  spawn: (args: string[]) => SpawnResult;
  startCodexProxy: (
    runDir: string,
    remoteUrl: string,
    threadId: string
  ) => Promise<string>;
  startPersistentAgentSession: typeof startPersistentAgentSession;
  updateRunManifest: typeof updateRunManifest;
}

interface PairedTmuxLaunch {
  opts: Options;
  task?: string;
}

const quoteShellArg = (value: string): string =>
  `'${value.replaceAll("'", "'\\''")}'`;

const buildShellCommand = (argv: string[]): string =>
  argv.map(quoteShellArg).join(" ");

const stripTmuxFlag = (argv: string[]): string[] =>
  argv.filter((arg) => arg !== TMUX_FLAG);

const isSingleAgentMode = (argv: string[]): boolean =>
  ONLY_MODE_FLAGS.some((flag) => argv.includes(flag));

const capitalize = (value: string): string =>
  value.slice(0, 1).toUpperCase() + value.slice(1);

const peerAgent = (agent: Agent): Agent =>
  agent === "claude" ? "codex" : "claude";

const appendProofPrompt = (parts: string[], proof: string): void => {
  const trimmed = proof.trim();
  if (!trimmed) {
    return;
  }
  parts.push(`Proof requirements:\n${trimmed}`);
};

const pairedBridgeGuidance = (agent: Agent): string => {
  const peer = agent === "claude" ? "Codex" : "Claude";
  return [
    "Paired mode:",
    `You are in a persistent Claude/Codex pair. Use the MCP tool "send_to_agent" when you want ${peer} to act, review, or answer.`,
    "Do not ask the human to relay messages between agents. Normal paired messages should arrive directly.",
    'Use "bridge_status" only for diagnostics if direct delivery seems stuck. Use "receive_messages" only as a manual fallback.',
  ].join("\n");
};

const pairedWorkflowGuidance = (opts: Options, agent: Agent): string => {
  const primary = capitalize(opts.agent);
  const peer = capitalize(peerAgent(opts.agent));

  if (agent === opts.agent) {
    return [
      "Workflow:",
      `You are the main worker. ${peer} is the peer reviewer/support agent.`,
      "Do the implementation and verification work yourself first.",
      `After your initial pass, ask ${peer} for review with "send_to_agent". Also do your own final review before closing out.`,
      "If either your own review or the peer review finds an issue, keep working and repeat the review cycle until both reviews pass.",
      "Do not stop after a single passing review.",
      "Once both reviews pass, do the PR step yourself: create a draft PR for the current branch, or if a PR already exists, send a follow-up commit to it.",
    ].join("\n");
  }

  return [
    "Workflow:",
    `${primary} is the main worker. You are the reviewer/support agent.`,
    "Do not take over the task or create the PR yourself.",
    `When ${primary} asks for review, do a real review against the task, proof requirements, and current repo state.`,
    "If you find an issue, send clear actionable feedback back to the main worker.",
    "If the work looks good, send an explicit approval so the main worker can count your review as passed.",
  ].join("\n");
};

const buildPrimaryPrompt = (task: string, opts: Options): string => {
  const peer = capitalize(peerAgent(opts.agent));
  const parts = [
    `Paired tmux mode. You are the primary ${capitalize(opts.agent)} agent for this run.`,
    `Task:\n${task.trim()}`,
    `Your peer is ${peer}. Do the initial pass yourself, then use "send_to_agent" when you want review or targeted help from ${peer}.`,
  ];
  appendProofPrompt(parts, opts.proof);
  parts.push(pairedBridgeGuidance(opts.agent));
  parts.push(pairedWorkflowGuidance(opts, opts.agent));
  parts.push(
    `${peer} has already been prompted as the reviewer/support agent and should send you a short ready message. Wait briefly for that ready signal if it arrives quickly, then review the repo and begin the task. Ask ${peer} for review once you have concrete work or a specific question.`
  );
  return parts.join("\n\n");
};

const buildPeerPrompt = (task: string, opts: Options, agent: Agent): string => {
  const primary = capitalize(opts.agent);
  const parts = [
    `Paired tmux mode. ${primary} is the primary agent for this run.`,
    `Task:\n${task.trim()}`,
    `You are ${capitalize(agent)}. Do not start implementing or verifying this task on your own.`,
  ];
  appendProofPrompt(parts, opts.proof);
  parts.push(pairedBridgeGuidance(agent));
  parts.push(pairedWorkflowGuidance(opts, agent));
  parts.push(
    `Your first action is to use "send_to_agent" to tell ${primary}: "Reviewer ready. I have the task context and I am waiting for your request." After that, wait for ${primary} to send you a targeted request or review ask.`
  );
  return parts.join("\n\n");
};

const buildInteractivePrimaryPrompt = (opts: Options): string => {
  const peer = capitalize(peerAgent(opts.agent));
  const parts = [
    `Paired tmux mode. You are the primary ${capitalize(opts.agent)} agent for this run.`,
    "No task has been assigned yet.",
    `Your peer is ${peer}. Stay in paired mode and use "send_to_agent" when you want ${peer} to review work, answer questions, or help once the human gives you a task.`,
  ];
  appendProofPrompt(parts, opts.proof);
  parts.push(pairedBridgeGuidance(opts.agent));
  parts.push(pairedWorkflowGuidance(opts, opts.agent));
  parts.push(
    `Wait for the human to provide the first task. Do not start implementing anything until a task arrives. Once you have a concrete task, coordinate directly with ${peer} and keep the paired review workflow intact.`
  );
  return parts.join("\n\n");
};

const buildInteractivePeerPrompt = (opts: Options, agent: Agent): string => {
  const primary = capitalize(opts.agent);
  const parts = [
    `Paired tmux mode. ${primary} is the primary agent for this run.`,
    "No task has been assigned yet.",
    `You are ${capitalize(agent)}. Your reviewer/support role is active, but do not start implementing or verifying anything until ${primary} or the human gives you a specific request.`,
  ];
  appendProofPrompt(parts, opts.proof);
  parts.push(pairedBridgeGuidance(agent));
  parts.push(pairedWorkflowGuidance(opts, agent));
  parts.push(
    `Your first action is to use "send_to_agent" to tell ${primary}: "Reviewer ready. No task yet. I am waiting for your request." After that, wait for the human or ${primary} to provide a concrete task or review request.`
  );
  return parts.join("\n\n");
};

const buildLaunchPrompt = (launch: PairedTmuxLaunch, agent: Agent): string => {
  const task = launch.task?.trim();
  if (!task) {
    return launch.opts.agent === agent
      ? buildInteractivePrimaryPrompt(launch.opts)
      : buildInteractivePeerPrompt(launch.opts, agent);
  }
  return launch.opts.agent === agent
    ? buildPrimaryPrompt(task, launch.opts)
    : buildPeerPrompt(task, launch.opts, agent);
};

const resolveTmuxModel = (agent: Agent, opts: Options): string => {
  if (agent === "codex") {
    return opts.agent === "codex"
      ? opts.codexModel
      : (opts.codexReviewerModel ?? opts.codexModel);
  }
  return opts.agent === "claude"
    ? DEFAULT_CLAUDE_MODEL
    : (opts.claudeReviewerModel ?? DEFAULT_CLAUDE_MODEL);
};

const buildClaudeChannelServerName = (runId: string): string =>
  `${BRIDGE_SERVER}-${sanitizeBase(runId)}`;

const buildClaudeChannelServerConfig = (
  launchArgv: string[],
  runDir: string
): string => {
  const [command, ...baseArgs] = launchArgv;
  return JSON.stringify({
    args: [...baseArgs, BRIDGE_SUBCOMMAND, runDir, "claude"],
    command,
    type: "stdio",
  });
};

const buildClaudeCommand = (
  sessionId: string,
  model: string,
  channelServer: string,
  resume: boolean,
  prompt?: string
): string[] => {
  const args = [
    "claude",
    resume ? "--resume" : "--session-id",
    sessionId,
    "--model",
    model,
    "--dangerously-load-development-channels",
    `server:${channelServer}`,
    "--dangerously-skip-permissions",
  ];
  if (prompt) {
    args.push(prompt);
  }
  return args;
};

const buildCodexCommand = (
  remoteUrl: string,
  model: string,
  configValues: string[],
  prompt?: string
): string[] => {
  const args = [
    "codex",
    "-m",
    model,
    ...configValues,
    "--enable",
    "tui_app_server",
    "--remote",
    remoteUrl,
  ];
  if (prompt) {
    args.push(prompt);
  }
  return args;
};

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
  const singleAgentMode = isSingleAgentMode(argv);
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

const isTerminalDimension = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value > 0;

const buildSessionSizeArgs = (deps: TmuxDeps): string[] => {
  const size = deps.getTerminalSize();
  if (!size) {
    return [];
  }
  if (!(isTerminalDimension(size.columns) && isTerminalDimension(size.rows))) {
    return [];
  }
  return ["-x", String(size.columns), "-y", String(size.rows)];
};

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

const tmuxStartupMessage = (paired: boolean): string =>
  paired
    ? "[loop] starting paired tmux workspace. This can take a few seconds..."
    : "[loop] starting tmux session. This can take a few seconds...";

const updatePairedManifest = (
  deps: TmuxDeps,
  storage: RunStorage,
  manifest: RunManifest,
  claudeSessionId: string,
  codexRemoteUrl: string,
  codexThreadId: string,
  session: string
): void => {
  deps.updateRunManifest(storage.manifestPath, (current) =>
    touchRunManifest(
      {
        ...(current ?? manifest),
        claudeSessionId,
        codexRemoteUrl,
        codexThreadId,
        cwd: deps.cwd,
        mode: "paired",
        pid: process.pid,
        tmuxSession: session,
      },
      new Date().toISOString()
    )
  );
};

const registerClaudeChannelServer = (
  deps: TmuxDeps,
  serverName: string,
  runDir: string
): void => {
  const result = deps.spawn([
    "claude",
    "mcp",
    "add-json",
    "--scope",
    CLAUDE_CHANNEL_SCOPE,
    serverName,
    buildClaudeChannelServerConfig(deps.launchArgv, runDir),
  ]);
  if (result.exitCode === 0 || MCP_ALREADY_EXISTS_RE.test(result.stderr)) {
    return;
  }
  const suffix = result.stderr ? `: ${result.stderr}` : ".";
  throw new Error(`[loop] failed to register Claude channel server${suffix}`);
};

const ensurePairedSessionIds = async (
  deps: TmuxDeps,
  opts: Options,
  storage: RunStorage,
  manifest: RunManifest,
  session: string
): Promise<{
  claudeSessionId: string;
  codexRemoteUrl: string;
  codexThreadId: string;
}> => {
  const codexKind = opts.agent === "codex" ? "work" : "review";

  await deps.startPersistentAgentSession(
    "codex",
    opts,
    manifest.codexThreadId || undefined,
    undefined,
    codexKind
  );

  const claudeSessionId =
    manifest.claudeSessionId || deps.makeClaudeSessionId();
  const codexThreadId = deps.getLastCodexThreadId() || manifest.codexThreadId;
  if (!codexThreadId) {
    throw new Error("[loop] failed to resolve Codex thread for tmux launch");
  }
  const codexRemoteUrl = deps.getCodexAppServerUrl();
  if (!codexRemoteUrl) {
    throw new Error(
      "[loop] failed to resolve Codex app-server for tmux launch"
    );
  }

  opts.pairedSessionIds = { claude: claudeSessionId, codex: codexThreadId };
  updatePairedManifest(
    deps,
    storage,
    manifest,
    claudeSessionId,
    codexRemoteUrl,
    codexThreadId,
    session
  );
  return { claudeSessionId, codexRemoteUrl, codexThreadId };
};

const runTmuxCommand = (
  deps: TmuxDeps,
  args: string[],
  message = "Failed to start tmux session"
): void => {
  const result = deps.spawn(args);
  if (result.exitCode === 0) {
    return;
  }
  const suffix = result.stderr ? `: ${result.stderr}` : ".";
  throw new Error(`${message}${suffix}`);
};

const detectClaudePrompt = (text: string): "bypass" | "trust" | undefined => {
  if (text.includes(CLAUDE_TRUST_PROMPT)) {
    return "trust";
  }
  if (text.includes(CLAUDE_BYPASS_PROMPT)) {
    return "bypass";
  }
  return undefined;
};

const codexReady = (text: string): boolean => text.includes(CODEX_SEND_FOOTER);

const unblockClaudePane = async (
  session: string,
  deps: TmuxDeps
): Promise<void> => {
  const pane = `${session}:0.0`;
  let handledPrompt = false;
  let quietPolls = 0;

  for (
    let attempt = 0;
    attempt < CLAUDE_PROMPT_INITIAL_POLLS * 2;
    attempt += 1
  ) {
    const prompt = detectClaudePrompt(deps.capturePane(pane));
    if (prompt === "trust") {
      deps.sendKeys(pane, ["Enter"]);
      handledPrompt = true;
      quietPolls = 0;
      await deps.sleep(CLAUDE_PROMPT_POLL_DELAY_MS);
      continue;
    }
    if (prompt === "bypass") {
      deps.sendKeys(pane, ["Down", "Enter"]);
      handledPrompt = true;
      quietPolls = 0;
      await deps.sleep(CLAUDE_PROMPT_POLL_DELAY_MS);
      continue;
    }

    quietPolls += 1;
    if (handledPrompt && quietPolls >= CLAUDE_PROMPT_SETTLE_POLLS) {
      return;
    }
    if (!handledPrompt && quietPolls >= CLAUDE_PROMPT_INITIAL_POLLS) {
      return;
    }
    await deps.sleep(CLAUDE_PROMPT_POLL_DELAY_MS);
  }
};

const waitForCodexReady = async (
  session: string,
  deps: TmuxDeps
): Promise<void> => {
  const pane = `${session}:0.1`;
  for (let attempt = 0; attempt < CODEX_READY_POLLS; attempt += 1) {
    if (codexReady(deps.capturePane(pane))) {
      return;
    }
    await deps.sleep(CODEX_READY_POLL_DELAY_MS);
  }
};

const seedPanePrompt = async (
  pane: string,
  prompt: string,
  deps: TmuxDeps
): Promise<void> => {
  const lines = prompt.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    deps.sendText(pane, lines[index] ?? "");
    if (index < lines.length - 1) {
      deps.sendKeys(pane, ["C-j"]);
    }
  }
  await deps.sleep(100);
  deps.sendKeys(pane, ["Enter"]);
};

const submitCodexPrompt = async (
  session: string,
  prompt: string,
  deps: TmuxDeps
): Promise<void> => {
  const pane = `${session}:0.1`;
  await waitForCodexReady(session, deps);
  await seedPanePrompt(pane, prompt, deps);
  await deps.sleep(CODEX_READY_POLL_DELAY_MS);
  if (codexReady(deps.capturePane(pane))) {
    deps.sendKeys(pane, ["Enter"]);
  }
};

const startPairedSession = async (
  deps: TmuxDeps,
  launch: PairedTmuxLaunch
): Promise<string> => {
  const { manifest, storage } = deps.preparePairedRun(launch.opts, deps.cwd);
  const runBase = resolveRunBase(deps.cwd, deps, storage.runId);
  const session = buildRunName(runBase, storage.runId);
  if (sessionExists(session, deps.spawn)) {
    return session;
  }

  const hadClaudeSession = Boolean(manifest.claudeSessionId);
  const hadCodexThread = Boolean(manifest.codexThreadId);
  const { claudeSessionId, codexRemoteUrl } = await ensurePairedSessionIds(
    deps,
    launch.opts,
    storage,
    manifest,
    session
  );
  if (!launch.opts.codexMcpConfigArgs?.length) {
    throw new Error("[loop] missing Codex bridge config for tmux launch");
  }
  const codexThreadId = launch.opts.pairedSessionIds?.codex;
  if (!codexThreadId) {
    throw new Error("[loop] failed to resolve Codex thread for tmux launch");
  }
  const codexProxyUrl = await deps.startCodexProxy(
    storage.runDir,
    codexRemoteUrl,
    codexThreadId
  );
  const claudeChannelServer = buildClaudeChannelServerName(storage.runId);
  registerClaudeChannelServer(deps, claudeChannelServer, storage.runDir);
  const env = [`${RUN_BASE_ENV}=${runBase}`, `${RUN_ID_ENV}=${storage.runId}`];
  const claudePrompt = buildLaunchPrompt(launch, "claude");
  const codexPrompt = buildLaunchPrompt(launch, "codex");
  const claudeCommand = buildShellCommand([
    "env",
    ...env,
    ...buildClaudeCommand(
      claudeSessionId,
      resolveTmuxModel("claude", launch.opts),
      claudeChannelServer,
      hadClaudeSession
    ),
  ]);
  const codexCommand = buildShellCommand([
    "env",
    ...env,
    ...buildCodexCommand(
      codexProxyUrl,
      resolveTmuxModel("codex", launch.opts),
      launch.opts.codexMcpConfigArgs ?? []
    ),
  ]);

  runTmuxCommand(deps, [
    "tmux",
    "new-session",
    "-d",
    ...buildSessionSizeArgs(deps),
    "-s",
    session,
    "-c",
    deps.cwd,
    claudeCommand,
  ]);
  runTmuxCommand(
    deps,
    [
      "tmux",
      "split-window",
      "-h",
      "-t",
      `${session}:0`,
      "-c",
      deps.cwd,
      codexCommand,
    ],
    "Failed to split tmux window"
  );
  deps.spawn([
    "tmux",
    "select-layout",
    "-t",
    `${session}:0`,
    "even-horizontal",
  ]);
  await unblockClaudePane(session, deps);
  await deps.sleep(PROMPT_DISPATCH_DELAY_MS);
  const peerPane =
    launch.opts.agent === "claude" ? `${session}:0.1` : `${session}:0.0`;
  const primaryPane =
    launch.opts.agent === "claude" ? `${session}:0.0` : `${session}:0.1`;
  const peerPrompt =
    launch.opts.agent === "claude" ? codexPrompt : claudePrompt;
  const primaryPrompt =
    launch.opts.agent === "claude" ? claudePrompt : codexPrompt;

  if (!hadClaudeSession && peerPane.endsWith(":0.0")) {
    await seedPanePrompt(peerPane, peerPrompt, deps);
  }
  if (!hadCodexThread && peerPane.endsWith(":0.1")) {
    await submitCodexPrompt(session, peerPrompt, deps);
  }
  if (!(hadClaudeSession && hadCodexThread)) {
    await deps.sleep(REVIEWER_BOOT_DELAY_MS);
  }
  if (!hadClaudeSession && primaryPane.endsWith(":0.0")) {
    await seedPanePrompt(primaryPane, primaryPrompt, deps);
  }
  if (!hadCodexThread && primaryPane.endsWith(":0.1")) {
    await submitCodexPrompt(session, primaryPrompt, deps);
  }
  deps.spawn(["tmux", "select-pane", "-t", primaryPane]);
  return session;
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
    ...buildSessionSizeArgs(deps),
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
      ...buildSessionSizeArgs(deps),
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
  capturePane: (pane: string) => {
    const result = spawnSync(["tmux", "capture-pane", "-p", "-t", pane], {
      stderr: "ignore",
      stdout: "pipe",
    });
    return decode(result.stdout);
  },
  cwd: process.cwd(),
  env: process.env,
  findBinary: (cmd: string) => commandExists(cmd),
  getCodexAppServerUrl,
  getLastCodexThreadId,
  getTerminalSize: () => {
    const columns = process.stdout.columns;
    const rows = process.stdout.rows;
    if (!(isTerminalDimension(columns) && isTerminalDimension(rows))) {
      return undefined;
    }
    return { columns, rows };
  },
  isInteractive: () => Boolean(process.stdin.isTTY && process.stdout.isTTY),
  launchArgv: buildLaunchArgv(),
  log: (line: string) => {
    console.log(line);
  },
  makeClaudeSessionId: () => randomUUID(),
  preparePairedRun,
  runGit: (cwd: string, args: string[]) => runGit(cwd, args),
  sendKeys: (pane: string, keys: string[]) => {
    spawnSync(["tmux", "send-keys", "-t", pane, ...keys], { stderr: "ignore" });
  },
  sendText: (pane: string, text: string) => {
    spawnSync(["tmux", "send-keys", "-t", pane, "-l", "--", text], {
      stderr: "ignore",
    });
  },
  sleep: (ms: number) =>
    new Promise((resolve) => {
      setTimeout(resolve, ms);
    }),
  startCodexProxy: async (
    runDir: string,
    remoteUrl: string,
    threadId: string
  ) => {
    const port = await findCodexTmuxProxyPort();
    spawn(
      [
        ...buildLaunchArgv(),
        CODEX_TMUX_PROXY_SUBCOMMAND,
        runDir,
        remoteUrl,
        threadId,
        String(port),
      ],
      {
        detached: DETACH_CHILD_PROCESS,
        env: process.env,
        stderr: "ignore",
        stdin: "ignore",
        stdout: "ignore",
      }
    );
    return waitForCodexTmuxProxy(port);
  },
  startPersistentAgentSession,
  spawn: (args: string[]) => {
    const result = spawnSync(args, { stderr: "pipe" });
    return { exitCode: result.exitCode, stderr: decode(result.stderr) };
  },
  updateRunManifest,
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

export const runInTmux = async (
  argv: string[],
  overrides: Partial<TmuxDeps> = {},
  launch?: PairedTmuxLaunch
): Promise<boolean> => {
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

  const pairedLaunch =
    Boolean(launch) &&
    !isSingleAgentMode(argv) &&
    Boolean(launch?.opts.pairedMode);
  deps.log(tmuxStartupMessage(pairedLaunch));

  const session =
    pairedLaunch && launch
      ? await startPairedSession(deps, launch)
      : findSession(argv, deps);

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
  buildClaudeCommand,
  buildClaudeChannelServerConfig,
  buildClaudeChannelServerName,
  buildCodexCommand,
  buildInteractivePeerPrompt,
  buildInteractivePrimaryPrompt,
  buildLaunchArgv,
  buildLaunchPrompt,
  buildPeerPrompt,
  buildPrimaryPrompt,
  buildRunName,
  buildShellCommand,
  isSessionConflict,
  quoteShellArg,
  sanitizeBase,
  stripTmuxFlag,
  worktreeAvailable,
};
