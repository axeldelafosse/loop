import { createInterface } from "node:readline/promises";
import { markBridgeMessage, readPendingBridgeMessages } from "./bridge";
import { getLastClaudeSessionId } from "./claude-sdk-server";
import { getLastCodexThreadId } from "./codex-app-server";
import {
  doneText,
  formatFollowUp,
  iterationCooldown,
  logIterationHeader,
} from "./iteration";
import {
  applyPairedOptions,
  canResumePairedManifest,
  preparePairedOptions as preparePairedOptionsImpl,
  resolvePreparedRunState,
} from "./paired-options";
import { runDraftPrStep } from "./pr";
import { buildWorkPrompt } from "./prompts";
import { createRunReviewWithPrompt, resolveReviewers } from "./review";
import {
  createRunManifest,
  type RunManifest,
  type RunStorage,
  touchRunManifest,
  updateRunManifest,
  writeRunManifest,
} from "./run-state";
import {
  runAgent,
  runReviewerAgent,
  startPersistentAgentSession,
} from "./runner";
import type {
  Agent,
  Options,
  ReviewFailure,
  ReviewMode,
  RunResult,
} from "./types";
import { hasSignal } from "./utils";

const MAX_BRIDGE_HOPS = 12;

interface PairedState {
  manifest: RunManifest;
  options: Options;
  storage: RunStorage;
  usedResume: Record<Agent, boolean>;
}

interface PairedLoopDependencies {
  startPersistentAgentSession: typeof startPersistentAgentSession;
}

const pairedLoopDefaultDeps: PairedLoopDependencies = {
  startPersistentAgentSession,
};

let pairedLoopDeps = pairedLoopDefaultDeps;

export const preparePairedOptions = (
  opts: Options,
  cwd = process.cwd()
): void => {
  preparePairedOptionsImpl(opts, cwd);
};

export const pairedLoopInternals = {
  resetDeps(): void {
    pairedLoopDeps = pairedLoopDefaultDeps;
  },
  setDeps(deps: Partial<PairedLoopDependencies>): void {
    pairedLoopDeps = { ...pairedLoopDefaultDeps, ...deps };
  },
};

const capitalize = (value: string): string =>
  value.slice(0, 1).toUpperCase() + value.slice(1);

const resolvePairedReviewers = (
  review: ReviewMode | undefined,
  agent: Agent
): Agent[] => resolveReviewers(review, agent);

const pairedResumeHint = (runId: string): void => {
  console.error(`[loop] to resume paired run: loop --run-id ${runId}`);
};

const bridgeGuidance = (agent: Agent): string => {
  const peer = agent === "claude" ? "Codex" : "Claude";
  return [
    "Paired mode:",
    `You are in a persistent Claude/Codex pair. Use the MCP tool "send_to_agent" when you want ${peer} to act, review, or answer.`,
    'Do not ask the human to relay messages between agents. Use "bridge_status" if you need the current bridge state.',
  ].join("\n");
};

const bridgeToolGuidance = [
  'You can use the MCP tools "send_to_agent" and "bridge_status" for direct Claude/Codex coordination.',
  "Do not ask the human to relay messages between agents.",
].join("\n");

const reviewDeliveryGuidance = (reviewer: Agent, opts: Options): string => {
  if (reviewer === opts.agent) {
    return "If review is needed, keep the actionable notes in your review body before the final review signal.";
  }

  return `If review is needed, send the actionable notes to ${capitalize(opts.agent)} with "send_to_agent" before returning your final review signal.`;
};

const reviewToolGuidance = (reviewer: Agent, opts: Options): string =>
  reviewer === opts.agent
    ? "Use the review body itself for follow-up notes. No bridge message is needed for a self-review."
    : bridgeToolGuidance;

const formatSelfReviewNotes = (
  failures: ReviewFailure[],
  agent: Agent
): string =>
  failures
    .filter((failure) => failure.reviewer === agent)
    .map((failure) => `[${failure.reviewer}] ${failure.reason.trim()}`)
    .join("\n\n");

const reviewBridgePrompt = (
  task: string,
  opts: Options,
  reviewer: Agent = opts.agent
): string =>
  [
    `Review this completed work for the task below and verify it in the current repo.\n\nTask:\n${task.trim()}`,
    "Focus your review on unstaged changes (the diff produced by `git diff`). Run checks/tests/commands as needed.",
    opts.proof ? `Proof requirements:\n${opts.proof.trim()}` : "",
    reviewDeliveryGuidance(reviewer, opts),
    `If review is needed, end your response with exactly "<review>FAIL</review>" on the final non-empty line. Nothing may follow this line.`,
    `If the work is complete, end with exactly "<review>PASS</review>" on the final non-empty line. No extra content after this line.`,
    reviewToolGuidance(reviewer, opts),
  ]
    .filter(Boolean)
    .join("\n\n");

const forwardBridgePrompt = (source: Agent, message: string): string =>
  [
    `Message from ${capitalize(source)} via the loop bridge:`,
    message.trim(),
    "Treat this as direct agent-to-agent coordination. Reply with send_to_agent only when you have something useful for the other agent to act on. Do not acknowledge receipt without new information.",
  ].join("\n\n");

const updateIds = (state: PairedState): void => {
  const next = touchRunManifest(
    {
      ...state.manifest,
      claudeSessionId:
        getLastClaudeSessionId() || state.manifest.claudeSessionId || "",
      codexThreadId:
        getLastCodexThreadId() || state.manifest.codexThreadId || "",
      pid: process.pid,
    },
    new Date().toISOString()
  );
  state.manifest = next;
  writeRunManifest(state.storage.manifestPath, next);
};

const nextResumeId = (state: PairedState, agent: Agent): string | undefined => {
  if (state.usedResume[agent]) {
    return undefined;
  }
  state.usedResume[agent] = true;
  const value =
    agent === "claude"
      ? state.manifest.claudeSessionId
      : state.manifest.codexThreadId;
  return value || undefined;
};

const tryRunPairedAgent = async (
  state: PairedState,
  agent: Agent,
  prompt: string,
  kind: "review" | "work" = "work"
): Promise<RunResult | undefined> => {
  const sessionId = nextResumeId(state, agent);
  try {
    const result =
      kind === "review"
        ? await runReviewerAgent(agent, prompt, state.options, sessionId)
        : await runAgent(agent, prompt, state.options, sessionId);
    updateIds(state);
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`\n[loop] ${agent} error: ${message}`);
    pairedResumeHint(state.storage.runId);
    return undefined;
  }
};

const drainBridge = async (
  state: PairedState
): Promise<{ deliveredToPrimary: number }> => {
  let deliveredToPrimary = 0;

  for (let hop = 0; hop < MAX_BRIDGE_HOPS; hop += 1) {
    const message = readPendingBridgeMessages(state.storage.runDir)[0];
    if (!message) {
      return { deliveredToPrimary };
    }

    console.log(`\n[loop] bridge ${message.source} -> ${message.target}`);
    const result = await tryRunPairedAgent(
      state,
      message.target,
      forwardBridgePrompt(message.source, message.message)
    );
    if (!result) {
      return { deliveredToPrimary };
    }
    if (result.exitCode !== 0) {
      console.error(
        `[loop] bridge delivery to ${message.target} exited with code ${result.exitCode}. leaving message queued.`
      );
      return { deliveredToPrimary };
    }

    markBridgeMessage(state.storage.runDir, message, "delivered");
    if (message.target === state.options.agent) {
      deliveredToPrimary += 1;
    }
  }

  console.error(
    "[loop] bridge hop limit reached. remaining messages stay queued."
  );
  return { deliveredToPrimary };
};

const prepareRunState = (opts: Options, cwd: string): PairedState => {
  const {
    allowRawSessionFallback,
    manifest: existing,
    storage,
  } = resolvePreparedRunState(opts, cwd);
  applyPairedOptions(opts, storage, existing, allowRawSessionFallback);
  const resumable = canResumePairedManifest(existing) ? existing : undefined;
  const manifest = existing
    ? touchRunManifest(
        {
          ...existing,
          claudeSessionId:
            resumable?.claudeSessionId || opts.pairedSessionIds?.claude || "",
          codexThreadId:
            resumable?.codexThreadId || opts.pairedSessionIds?.codex || "",
          cwd,
          mode: "paired",
          pid: process.pid,
          status: "running",
        },
        new Date().toISOString()
      )
    : createRunManifest({
        claudeSessionId: opts.pairedSessionIds?.claude ?? "",
        codexThreadId: opts.pairedSessionIds?.codex ?? "",
        cwd,
        mode: "paired",
        pid: process.pid,
        repoId: storage.repoId,
        runId: storage.runId,
        status: "running",
      });
  writeRunManifest(storage.manifestPath, manifest);

  return {
    manifest,
    options: opts,
    storage,
    usedResume: { claude: false, codex: false },
  };
};

const startPair = async (state: PairedState): Promise<void> => {
  const claudeKind = state.options.agent === "claude" ? "work" : "review";
  const codexKind = state.options.agent === "codex" ? "work" : "review";

  await Promise.all([
    pairedLoopDeps.startPersistentAgentSession(
      "claude",
      state.options,
      state.manifest.claudeSessionId || undefined,
      undefined,
      claudeKind
    ),
    pairedLoopDeps.startPersistentAgentSession(
      "codex",
      state.options,
      state.manifest.codexThreadId || undefined,
      undefined,
      codexKind
    ),
  ]);
  updateIds(state);
};

const createPairedReview = (state: PairedState) =>
  createRunReviewWithPrompt(reviewBridgePrompt, (reviewer, prompt, opts) =>
    runReviewerAgent(reviewer, prompt, opts, nextResumeId(state, reviewer))
  );

const runIterations = async (
  task: string,
  state: PairedState,
  reviewers: Agent[]
): Promise<boolean> => {
  let reviewNotes = "";
  const shouldReview = reviewers.length > 0;
  const { doneSignal, maxIterations } = state.options;
  const runReview = createPairedReview(state);
  console.log(`\n[loop] PLAN.md:\n\n${task}`);
  console.log(`[loop] paired run: ${state.storage.runId}`);

  for (let i = 1; i <= maxIterations; i += 1) {
    await iterationCooldown(i);
    logIterationHeader(i, maxIterations, state.options.agent);

    const preBridge = await drainBridge(state);
    if (preBridge.deliveredToPrimary > 0) {
      continue;
    }

    const prompt = [
      buildWorkPrompt(task, doneSignal, state.options.proof, reviewNotes),
      bridgeGuidance(state.options.agent),
    ].join("\n\n");
    reviewNotes = "";

    const result = await tryRunPairedAgent(state, state.options.agent, prompt);
    await drainBridge(state);
    if (!result) {
      continue;
    }

    if (result.exitCode !== 0) {
      console.error(
        `\n[loop] ${state.options.agent} exited with code ${result.exitCode}`
      );
      pairedResumeHint(state.storage.runId);
      continue;
    }

    const output = `${result.parsed}\n${result.combined}`;
    if (!hasSignal(output, doneSignal)) {
      continue;
    }

    if (!shouldReview) {
      console.log(`\n[loop] ${doneText(doneSignal)} detected, stopping.`);
      return true;
    }

    const review = await runReview(reviewers, task, state.options);
    updateIds(state);
    const reviewBridge = await drainBridge(state);
    const selfReviewNotes = formatSelfReviewNotes(
      review.failures,
      state.options.agent
    );
    if (review.approved) {
      await runDraftPrStep(task, state.options);
      console.log(
        `\n[loop] ${doneText(doneSignal)} detected and review passed, stopping.`
      );
      return true;
    }

    if (reviewBridge.deliveredToPrimary > 0) {
      if (selfReviewNotes) {
        reviewNotes = selfReviewNotes;
        console.log(
          "\n[loop] reviewer feedback delivered through bridge; keeping self-review notes in the next prompt."
        );
      } else {
        console.log("\n[loop] reviewer feedback delivered through bridge.");
      }
      continue;
    }

    const followUp = formatFollowUp(review);
    reviewNotes = followUp.notes;
    console.log(followUp.log);
  }

  return false;
};

const finishRun = (state: PairedState, status: "done" | "stopped"): void => {
  updateRunManifest(state.storage.manifestPath, (manifest) => {
    const current = manifest ?? state.manifest;
    return touchRunManifest(
      {
        ...current,
        claudeSessionId:
          getLastClaudeSessionId() || current.claudeSessionId || "",
        codexThreadId: getLastCodexThreadId() || current.codexThreadId || "",
        pid: process.pid,
        status,
      },
      new Date().toISOString()
    );
  });
};

export const runPairedLoop = async (
  task: string,
  opts: Options
): Promise<void> => {
  const reviewers = resolvePairedReviewers(opts.review, opts.agent);
  const rl = process.stdin.isTTY
    ? createInterface({ input: process.stdin, output: process.stdout })
    : undefined;
  const state = prepareRunState(opts, process.cwd());
  let loopTask = task;
  let status: "done" | "stopped" = "stopped";

  try {
    await startPair(state);
    while (true) {
      const done = await runIterations(loopTask, state, reviewers);
      if (done || !rl) {
        if (!done) {
          console.log(
            `\n[loop] reached max iterations (${opts.maxIterations}), stopping.`
          );
        }
        status = done ? "done" : "stopped";
        return;
      }
      console.log(`\n[loop] reached max iterations (${opts.maxIterations}).`);
      const answer = await rl.question(
        "\n[loop] follow-up prompt (blank to exit): "
      );
      if (!answer.trim()) {
        status = "stopped";
        return;
      }
      loopTask = `${loopTask}\n\nFollow-up:\n${answer.trim()}`;
    }
  } finally {
    finishRun(state, status);
    rl?.close();
  }
};
