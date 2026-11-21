import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { spawn, spawnSync } from "bun";
import {
  registerClaudeChannelServer,
  removeClaudeChannelServer,
} from "./bridge-claude-registration";
import {
  buildClaudeChannelServerConfig,
  claudeChannelServerName,
  legacyClaudeChannelServerName,
  resolveClaudeChannelServerName,
} from "./bridge-config";
import { type BridgeTool, quotedBridgeTool } from "./bridge-guidance";
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
import { SPAWN_TEAM_WITH_WORKTREE_ISOLATION } from "./prompts";
import {
  type RunManifest,
  type RunStorage,
  resolveExistingRunId,
  touchRunManifest,
  updateRunManifest,
} from "./run-state";
import {
  closePersistentCodexSession,
  releasePersistentCodexSession,
  startPersistentAgentSession,
} from "./runner";
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
const CLAUDE_BYPASS_MODE = "Bypass Permissions mode";
const CLAUDE_BYPASS_ACCEPT = "Yes, I accept";
const CLAUDE_EXIT_OPTION = "No, exit";
const CLAUDE_DEV_CHANNELS_PROMPT = "WARNING: Loading development channels";
const CLAUDE_DEV_CHANNELS_CONFIRM = "I am using this for local development";
const CLAUDE_PROMPT_MAX_POLLS = 8;
const CLAUDE_PROMPT_POLL_DELAY_MS = 250;
const CLAUDE_PROMPT_SETTLE_POLLS = 2;

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
  closePersistentCodexSession: typeof closePersistentCodexSession;
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
  releasePersistentCodexSession: typeof releasePersistentCodexSession;
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

// -- Host-managed startup (opt-in, LOOP_HOST_MANAGED_STARTUP=1) ----------------
// When the HOST launcher sets LOOP_HOST_MANAGED_STARTUP=1, loop delegates three startup
// concerns to the host so they are verified before any project work runs:
//   1. no automatic consent keystrokes (unblockClaudePane is skipped; a genuine prompt is
//      left for the present operator to handle);
//   2. pane retention/capture is initialized AT CREATION (remain-on-exit set + a bounded
//      tail pipe armed BEFORE the agent process can exit), scoped to this run's window only --
//      no shared-server/global change, no unrelated session touched;
//   3. the task is HELD via a cooperative, application-level delivery barrier: each agent is
//      launched with a role/bridge BOOTSTRAP that carries NO project task and NO source-task
//      pointer, and blocks on a single shared barrier file that does not exist yet. The HOST
//      is the only component that creates that barrier -- with the task payload -- and only
//      AFTER it has verified the launched model/effort + run identity. (Same-UID agents can
//      read the filesystem; this is the strongest cooperative barrier short of an OS sandbox,
//      not a claim of inaccessibility.)
// The hold engages only for a genuinely FRESH agent (no prior vendor session); a resume
// carries no new task and is not held. Default (env unset / != "1") startup is byte-identical.
const HOST_MANAGED_STARTUP_ENV = "LOOP_HOST_MANAGED_STARTUP";
const HOST_MANAGED_STARTUP_VALUE = "1";
const MANAGED_DIR_NAME = ".loop-managed";
const MANAGED_TASK_BARRIER = "task"; // <runDir>/.loop-managed/task -- shared release barrier
const MANAGED_PANE_LOG_CAP_BYTES = 262_144; // bounded tail retained per pane (256 KiB)

const isHostManagedStartup = (env: NodeJS.ProcessEnv): boolean =>
  env[HOST_MANAGED_STARTUP_ENV] === HOST_MANAGED_STARTUP_VALUE;

const managedDir = (runDir: string): string => join(runDir, MANAGED_DIR_NAME);

// The single shared delivery barrier: absent at launch; the host creates it (with the task)
// only after verification, and both agents' bootstraps block on this exact path.
const managedTaskBarrierPath = (runDir: string): string =>
  join(managedDir(runDir), MANAGED_TASK_BARRIER);

const managedPaneLogPath = (runDir: string, agent: Agent): string =>
  join(managedDir(runDir), `${agent}.pane.log`);

const spawnDetachedProcess = (
  argv: string[],
  env: NodeJS.ProcessEnv,
  spawnFn: typeof spawn = spawn
): void => {
  const child = spawnFn(argv, {
    detached: DETACH_CHILD_PROCESS,
    env,
    stderr: "ignore",
    stdin: "ignore",
    stdout: "ignore",
  });
  child.unref?.();
};

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

const quotedClaudeTmuxBridgeTool = (
  serverName: string,
  tool: BridgeTool
): string => `"mcp__${serverName}__${tool}"`;

const pairedBridgeGuidance = (
  agent: Agent,
  _runId: string,
  serverName: string
): string => {
  if (agent === "claude") {
    return [
      `Your bridge MCP server is "${serverName}". Use ${quotedClaudeTmuxBridgeTool(serverName, "send_message")} with target: "codex" for Codex-facing messages, including replies to inbound Codex channel messages; do not send Codex-facing responses as a human-facing message.`,
      `Use ${quotedClaudeTmuxBridgeTool(serverName, "bridge_status")} or ${quotedClaudeTmuxBridgeTool(serverName, "receive_messages")} only if delivery looks stuck.`,
    ].join("\n");
  }

  return [
    `Use the MCP tool ${quotedBridgeTool(agent, "send_message")} with target: "claude" for Claude-facing messages, not a human-facing message.`,
    `Use ${quotedBridgeTool(agent, "bridge_status")} or ${quotedBridgeTool(agent, "receive_messages")} only if delivery looks stuck.`,
  ].join("\n");
};

const pairedWorkflowGuidance = (opts: Options, agent: Agent): string => {
  const primary = capitalize(opts.agent);
  const peer = capitalize(peerAgent(opts.agent));

  if (agent === opts.agent) {
    return [
      `You are the main worker. ${peer} reviews and helps on request.`,
      "Implement and verify first, then ask for review.",
      "Keep iterating until your own review and the peer review both pass.",
      "After both pass, handle the PR yourself: create a draft PR or send a follow-up commit to the existing PR.",
    ].join("\n");
  }

  return [
    `${primary} is the main worker. You are the reviewer/support agent.`,
    "Do not take over the task or create the PR yourself.",
    `When ${primary} asks, do a real review against the task, proof requirements, and repo state.`,
    "Send either clear actionable feedback or an explicit approval.",
  ].join("\n");
};

const buildPrimaryPrompt = (
  task: string,
  opts: Options,
  runId: string,
  serverName: string
): string => {
  const peer = capitalize(peerAgent(opts.agent));
  const parts = [
    `Agent-to-agent pair programming: you are the primary ${capitalize(opts.agent)} agent for this run.`,
    `Task:\n${task.trim()}`,
    `Your peer is ${peer}. Do the initial pass yourself, then use ${quotedBridgeTool(opts.agent, "send_message")} when you want review or targeted help from ${peer}.`,
  ];
  appendProofPrompt(parts, opts.proof);
  parts.push(SPAWN_TEAM_WITH_WORKTREE_ISOLATION);
  parts.push(pairedBridgeGuidance(opts.agent, runId, serverName));
  parts.push(pairedWorkflowGuidance(opts, opts.agent));
  parts.push(
    `Inspect the repo and start. Ask ${peer} for review once you have concrete work or a specific question.`
  );
  return parts.join("\n\n");
};

const buildPeerPrompt = (
  task: string,
  opts: Options,
  agent: Agent,
  runId: string,
  serverName: string
): string => {
  const primary = capitalize(opts.agent);
  const parts = [
    `Agent-to-agent pair programming: ${primary} is the primary agent for this run.`,
    `Task:\n${task.trim()}`,
    `You are ${capitalize(agent)}. Do not start implementing or verifying this task on your own.`,
  ];
  appendProofPrompt(parts, opts.proof);
  parts.push(pairedBridgeGuidance(agent, runId, serverName));
  parts.push(pairedWorkflowGuidance(opts, agent));
  parts.push(
    `Wait for ${primary} to send you a targeted request or review ask.`
  );
  return parts.join("\n\n");
};

// The per-agent HOLD directive (behavior 3): block on the shared barrier, then perform exactly
// the task it delivers. Carries NO project task and NO source-task pointer.
const buildManagedHoldDirective = (barrierPath: string): string => {
  const quoted = quoteShellArg(barrierPath);
  return [
    "STARTUP HOLD (host-managed launch): your task has NOT been delivered yet. The host verifies",
    "this run's launched model/effort and run identity first, then delivers your task.",
    "Take NO action -- no edits, commits, messages, file reads, or other tool calls -- until then.",
    "As your FIRST and ONLY action now, run exactly this command, wait for it to return, then",
    "perform exactly the task it prints:",
    "",
    `  while [ ! -f ${quoted} ]; do sleep 1; done; cat ${quoted}`,
    "",
    "Do not proceed past that command until it returns your task.",
  ].join("\n");
};

// The bootstrap a FRESH managed agent is launched with instead of its task prompt: the same
// role + bridge + workflow framing as the normal prompt, but the task section is replaced by
// the hold directive. No project task or pointer is present (behavior 3).
const buildManagedBootstrapPrompt = (
  opts: Options,
  agent: Agent,
  runId: string,
  serverName: string,
  barrierPath: string
): string => {
  const isPrimary = agent === opts.agent;
  const parts: string[] = [];
  if (isPrimary) {
    parts.push(
      `Agent-to-agent pair programming: you are the primary ${capitalize(opts.agent)} agent for this run.`
    );
  } else {
    parts.push(
      `Agent-to-agent pair programming: ${capitalize(opts.agent)} is the primary agent for this run. You are ${capitalize(agent)}.`
    );
  }
  parts.push(buildManagedHoldDirective(barrierPath));
  parts.push(pairedBridgeGuidance(agent, runId, serverName));
  parts.push(pairedWorkflowGuidance(opts, agent));
  return parts.join("\n\n");
};

const buildInteractivePrimaryPrompt = (
  opts: Options,
  runId: string,
  serverName: string
): string => {
  const peer = capitalize(peerAgent(opts.agent));
  const parts = [
    `Agent-to-agent pair programming: you are the primary ${capitalize(opts.agent)} agent for this run.`,
    "No task has been assigned yet.",
    `Your peer is ${peer}. Use ${quotedBridgeTool(opts.agent, "send_message")} for review or help once the human gives you a task.`,
  ];
  appendProofPrompt(parts, opts.proof);
  parts.push(
    `${SPAWN_TEAM_WITH_WORKTREE_ISOLATION} Apply that once the human gives you a concrete task.`
  );
  parts.push(pairedBridgeGuidance(opts.agent, runId, serverName));
  parts.push(pairedWorkflowGuidance(opts, opts.agent));
  parts.push(
    `If the human asks for plan mode, write PLAN.md first, ask ${peer} for a plan review, iterate on PLAN.md, then ask the human to review the plan before implementing.`
  );
  parts.push(
    `Wait for the first human task. Do not implement until one arrives. Once it does, coordinate directly with ${peer} and keep the paired review workflow intact. Do not send a message to ${peer} until then.`
  );
  return parts.join("\n\n");
};

const buildInteractivePeerPrompt = (
  opts: Options,
  agent: Agent,
  runId: string,
  serverName: string
): string => {
  const primary = capitalize(opts.agent);
  const parts = [
    `Agent-to-agent pair programming: ${primary} is the primary agent for this run.`,
    "No task has been assigned yet.",
    `You are ${capitalize(agent)}. Stay idle until ${primary} sends a specific request or the human clearly assigns you separate work.`,
  ];
  appendProofPrompt(parts, opts.proof);
  parts.push(pairedBridgeGuidance(agent, runId, serverName));
  parts.push(pairedWorkflowGuidance(opts, agent));
  parts.push(
    `If ${primary} asks for a plan review, review PLAN.md only, suggest concrete fixes, and wait for the next request.`
  );
  parts.push(
    `Wait for ${primary} to provide a concrete task or review request. Do not send a message to ${primary} yet. If the human clearly assigns you separate work in this pane, treat that as a new task. If you are answering ${primary}, use the bridge tools instead of a human-facing reply.`
  );
  return parts.join("\n\n");
};

const buildLaunchPrompt = (
  launch: PairedTmuxLaunch,
  agent: Agent,
  runId: string,
  serverName: string
): string => {
  const task = launch.task?.trim();
  if (!task) {
    return launch.opts.agent === agent
      ? buildInteractivePrimaryPrompt(launch.opts, runId, serverName)
      : buildInteractivePeerPrompt(launch.opts, agent, runId, serverName);
  }
  return launch.opts.agent === agent
    ? buildPrimaryPrompt(task, launch.opts, runId, serverName)
    : buildPeerPrompt(task, launch.opts, agent, runId, serverName);
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

// tmux `-t` prefix/fnmatch-matches a session name, so a bare name can adopt or destroy an
// unrelated session that merely shares a prefix. The `=` operator forces an exact match; every
// path that checks for, attaches, captures, or kills THIS run's session targets it exactly.
const exactTarget = (target: string): string => `=${target}`;

const sessionExists = (
  session: string,
  spawnFn: TmuxDeps["spawn"]
): boolean => {
  const result = spawnFn(["tmux", "has-session", "-t", exactTarget(session)]);
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
    ? "[loop] starting paired tmux workspace..."
    : "[loop] starting tmux session...";

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

const registerClaudeChannelServerForRun = (
  deps: TmuxDeps,
  serverName: string,
  runDir: string
): void => {
  registerClaudeChannelServer(deps.launchArgv, serverName, runDir, (args) =>
    deps.spawn(args)
  );
};

const cleanupFailedPairedSessionStart = (
  deps: TmuxDeps,
  session: string,
  serverName: string,
  runId: string
): void => {
  try {
    if (sessionExists(session, deps.spawn)) {
      deps.spawn(["tmux", "kill-session", "-t", exactTarget(session)]);
    }
  } catch {
    // Best-effort cleanup after a failed paired startup.
  }
  for (const name of new Set([
    serverName,
    legacyClaudeChannelServerName(runId),
  ])) {
    removeClaudeChannelServer(name, (args) => deps.spawn(args), deps.log);
  }
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
    { codexLaunch: { orphanOnExit: true } },
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

const normalizePaneText = (text: string): string =>
  text.replace(/\s+/g, " ").trim();

const detectClaudePrompt = (text: string): "bypass" | "confirm" | undefined => {
  const normalized = normalizePaneText(text);
  if (
    normalized.includes(CLAUDE_BYPASS_PROMPT) ||
    (normalized.includes(CLAUDE_BYPASS_MODE) &&
      normalized.includes(CLAUDE_BYPASS_ACCEPT) &&
      normalized.includes(CLAUDE_EXIT_OPTION))
  ) {
    return "bypass";
  }
  if (normalized.includes(CLAUDE_TRUST_PROMPT)) {
    return "confirm";
  }
  if (
    normalized.includes(CLAUDE_DEV_CHANNELS_PROMPT) &&
    normalized.includes(CLAUDE_DEV_CHANNELS_CONFIRM)
  ) {
    return "confirm";
  }
  return undefined;
};

const unblockClaudePane = async (
  session: string,
  deps: TmuxDeps
): Promise<void> => {
  const pane = `${session}:0.0`;
  let handledPrompt = false;
  let lastSnapshot = "";
  let quietPolls = 0;
  let sawOutput = false;

  for (let attempt = 0; attempt < CLAUDE_PROMPT_MAX_POLLS; attempt += 1) {
    const snapshot = normalizePaneText(deps.capturePane(pane));
    const prompt = detectClaudePrompt(snapshot);
    if (prompt === "confirm") {
      deps.sendKeys(pane, ["Enter"]);
      handledPrompt = true;
      lastSnapshot = "";
      quietPolls = 0;
      await deps.sleep(CLAUDE_PROMPT_POLL_DELAY_MS);
      continue;
    }
    if (prompt === "bypass") {
      deps.sendKeys(pane, ["Down"]);
      await deps.sleep(CLAUDE_PROMPT_POLL_DELAY_MS);
      deps.sendKeys(pane, ["Enter"]);
      handledPrompt = true;
      lastSnapshot = "";
      quietPolls = 0;
      await deps.sleep(CLAUDE_PROMPT_POLL_DELAY_MS);
      continue;
    }

    if (snapshot) {
      sawOutput = true;
    }
    quietPolls = snapshot === lastSnapshot ? quietPolls + 1 : 0;
    lastSnapshot = snapshot;
    if (handledPrompt && quietPolls >= CLAUDE_PROMPT_SETTLE_POLLS) {
      return;
    }
    if (sawOutput && quietPolls >= CLAUDE_PROMPT_SETTLE_POLLS) {
      return;
    }
    if (attempt + 1 >= CLAUDE_PROMPT_MAX_POLLS) {
      return;
    }
    await deps.sleep(CLAUDE_PROMPT_POLL_DELAY_MS);
  }
};

// Arm a bounded, 0600 tail capture on a pane (behavior 2). Deletes any stale log first so the
// host's post-detach poll can only observe THIS arm, buffers the last CAP bytes, and publishes
// <log> atomically via rename at EOF (pane death or host detach). umask 077 in the sink. The
// host detaches, waits for <log>, reads a redacted tail, deletes it, and fails closed if <log>
// never appears. tail(1) keeps a bounded window; the externally-guaranteed properties are the
// hard byte cap, the atomic publish, and that no raw log persists past the host's verdict.
const armManagedPaneCapture = (
  deps: TmuxDeps,
  pane: string,
  logPath: string
): void => {
  rmSync(logPath, { force: true });
  rmSync(`${logPath}.part`, { force: true });
  const part = quoteShellArg(`${logPath}.part`);
  const final = quoteShellArg(logPath);
  const sink = `umask 077; tail -c ${MANAGED_PANE_LOG_CAP_BYTES} > ${part} 2>/dev/null; mv -f ${part} ${final}`;
  runTmuxCommand(
    deps,
    ["tmux", "pipe-pane", "-t", pane, sink],
    "Failed to arm managed pane capture"
  );
};

// Host-managed pane startup: create IDLE shells, set remain-on-exit on this run's window BEFORE
// either agent can exit, arm a bounded tail capture per pane, then respawn each pane with its
// agent command (behavior 2). The caller skips unblockClaudePane (behavior 1).
const startPanesHostManaged = (
  deps: TmuxDeps,
  session: string,
  runDir: string,
  claudeCommand: string,
  codexCommand: string
): void => {
  mkdirSync(managedDir(runDir), { recursive: true, mode: 0o700 });
  runTmuxCommand(deps, [
    "tmux",
    "new-session",
    "-d",
    ...buildSessionSizeArgs(deps),
    "-s",
    session,
    "-c",
    deps.cwd,
  ]);
  runTmuxCommand(deps, [
    "tmux",
    "set-window-option",
    "-t",
    `${session}:0`,
    "remain-on-exit",
    "on",
  ]);
  runTmuxCommand(
    deps,
    ["tmux", "split-window", "-h", "-t", `${session}:0`, "-c", deps.cwd],
    "Failed to split tmux window"
  );
  // The CAPTURE pipe is exact-targeted (Codex: capture is a path that establishes retention for
  // this run); the surrounding establish ops act on the session we just created by exact name,
  // which tmux resolves exact-first, so they need no `=`.
  armManagedPaneCapture(
    deps,
    exactTarget(`${session}:0.0`),
    managedPaneLogPath(runDir, "claude")
  );
  armManagedPaneCapture(
    deps,
    exactTarget(`${session}:0.1`),
    managedPaneLogPath(runDir, "codex")
  );
  runTmuxCommand(deps, [
    "tmux",
    "respawn-pane",
    "-k",
    "-t",
    `${session}:0.0`,
    "-c",
    deps.cwd,
    claudeCommand,
  ]);
  runTmuxCommand(
    deps,
    [
      "tmux",
      "respawn-pane",
      "-k",
      "-t",
      `${session}:0.1`,
      "-c",
      deps.cwd,
      codexCommand,
    ],
    "Failed to start Codex pane"
  );
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
  const claudeChannelServer = resolveClaudeChannelServerName(
    storage.runId,
    storage.repoId,
    manifest.claudeChannelServer
  );
  registerClaudeChannelServerForRun(deps, claudeChannelServer, storage.runDir);
  try {
    const env = [
      `${RUN_BASE_ENV}=${runBase}`,
      `${RUN_ID_ENV}=${storage.runId}`,
    ];
    const hostManaged = isHostManagedStartup(deps.env);
    // Host-managed startup's HOLD + startup capture are a FRESH-launch feature: the host
    // finalizer that verifies, then detaches/cleans the capture only runs on a fresh launch
    // (agent-loop-start). A managed RESUME (both vendor identities present) has no such owner, so
    // it must NOT arm capture (which would otherwise publish a raw log with nobody to detach or
    // delete it); it still skips the consent keystroke. So capture/HOLD panes are fresh-only;
    // resume (and the default path) use the ordinary pane startup.
    const freshManaged = hostManaged && !hadClaudeSession && !hadCodexThread;
    const barrierPath = managedTaskBarrierPath(storage.runDir);
    // The prompt each pane is launched with: a RESUMED agent gets none; a FRESH agent gets its
    // task prompt normally, OR -- in host-managed mode -- a role/bridge BOOTSTRAP that carries
    // no project task and blocks on the host-created barrier (behavior 3). The full task prompt
    // is only built on the default path; in managed mode the host owns the task.
    const launchPromptFor = (
      agent: Agent,
      had: boolean
    ): string | undefined => {
      if (had) {
        return undefined;
      }
      if (hostManaged) {
        return buildManagedBootstrapPrompt(
          launch.opts,
          agent,
          storage.runId,
          claudeChannelServer,
          barrierPath
        );
      }
      return buildLaunchPrompt(
        launch,
        agent,
        storage.runId,
        claudeChannelServer
      );
    };
    const claudeCommand = buildShellCommand([
      "env",
      ...env,
      ...buildClaudeCommand(
        claudeSessionId,
        resolveTmuxModel("claude", launch.opts),
        claudeChannelServer,
        hadClaudeSession,
        launchPromptFor("claude", hadClaudeSession)
      ),
    ]);
    const codexCommand = buildShellCommand([
      "env",
      ...env,
      ...buildCodexCommand(
        codexProxyUrl,
        resolveTmuxModel("codex", launch.opts),
        launch.opts.codexMcpConfigArgs ?? [],
        launchPromptFor("codex", hadCodexThread)
      ),
    ]);

    if (freshManaged) {
      startPanesHostManaged(
        deps,
        session,
        storage.runDir,
        claudeCommand,
        codexCommand
      );
    } else {
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
    }
    deps.spawn([
      "tmux",
      "select-layout",
      "-t",
      `${session}:0`,
      "even-horizontal",
    ]);
    // Behavior 1: in managed mode the host sends no synthetic consent keystrokes; a genuine
    // prompt is left for the operator. The default path keeps the existing auto-unblock.
    if (!hostManaged) {
      await unblockClaudePane(session, deps);
    }
    const primaryPane =
      launch.opts.agent === "claude" ? `${session}:0.0` : `${session}:0.1`;
    deps.spawn(["tmux", "select-pane", "-t", primaryPane]);
    return session;
  } catch (error: unknown) {
    cleanupFailedPairedSessionStart(
      deps,
      session,
      claudeChannelServer,
      storage.runId
    );
    throw error;
  }
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
    const result = spawnSync(["tmux", "attach", "-t", exactTarget(session)], {
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
    spawnDetachedProcess(
      [
        ...buildLaunchArgv(),
        CODEX_TMUX_PROXY_SUBCOMMAND,
        runDir,
        remoteUrl,
        threadId,
        String(port),
      ],
      process.env
    );
    return waitForCodexTmuxProxy(port);
  },
  closePersistentCodexSession,
  releasePersistentCodexSession,
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
  const handedOff = attachSessionIfInteractive(session, deps);
  if (pairedLaunch && handedOff) {
    if (sessionExists(session, deps.spawn)) {
      deps.releasePersistentCodexSession();
    } else {
      await deps.closePersistentCodexSession();
    }
  }
  return handedOff;
};

export const tmuxInternals = {
  buildClaudeCommand,
  buildClaudeChannelServerConfig,
  buildClaudeChannelServerName: claudeChannelServerName,
  buildCodexCommand,
  buildInteractivePeerPrompt,
  buildInteractivePrimaryPrompt,
  buildLaunchArgv,
  buildLaunchPrompt,
  buildManagedBootstrapPrompt,
  buildPeerPrompt,
  buildPrimaryPrompt,
  buildRunName,
  buildShellCommand,
  exactTarget,
  sessionExists,
  spawnDetachedProcess,
  isHostManagedStartup,
  isSessionConflict,
  managedDir,
  managedPaneLogPath,
  managedTaskBarrierPath,
  quoteShellArg,
  sanitizeBase,
  stripTmuxFlag,
  worktreeAvailable,
};

export const HOST_MANAGED_STARTUP_ENV_NAME = HOST_MANAGED_STARTUP_ENV;
