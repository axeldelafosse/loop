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
  preparePairedOptions as preparePairedOptionsImpl,
  preparePairedRun,
} from "./paired-options";
import { runDraftPrStep } from "./pr";
import { buildWorkPrompt } from "./prompts";
import { createRunReviewWithPrompt, resolveReviewers } from "./review";
import {
  appendRunTranscriptEntry,
  createRunResultEntry,
  createRunReviewEntry,
  createRunStatusEntry,
  type RunManifest,
  type RunStorage,
  setRunManifestState,
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
  RunLifecycleState,
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
    'If "bridge_status" shows pending messages addressed to you, call "receive_messages" to read them.',
  ].join("\n");
};

const bridgeToolGuidance = [
  'You can use the MCP tools "send_to_agent", "bridge_status", and "receive_messages" for direct Claude/Codex coordination.',
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
    "When reporting failures, include concrete file paths, commands, and code locations that must change.",
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

const appendTranscript = (
  state: PairedState,
  entry:
    | ReturnType<typeof createRunResultEntry>
    | ReturnType<typeof createRunReviewEntry>
    | ReturnType<typeof createRunStatusEntry>
): void => {
  appendRunTranscriptEntry(state.storage.transcriptPath, entry);
};

const transitionRunState = (
  state: PairedState,
  nextState: RunLifecycleState,
  detail?: string
): void => {
  if (state.manifest.state === nextState && !detail) {
    return;
  }
  const now = new Date().toISOString();
  const next = setRunManifestState(
    {
      ...state.manifest,
      claudeSessionId:
        getLastClaudeSessionId() || state.manifest.claudeSessionId || "",
      codexThreadId:
        getLastCodexThreadId() || state.manifest.codexThreadId || "",
      pid: process.pid,
    },
    nextState,
    now
  );
  state.manifest = next;
  writeRunManifest(state.storage.manifestPath, next);
  appendTranscript(state, createRunStatusEntry(nextState, detail, now));
};

const promptForFollowUp = async (
  state: PairedState,
  task: string,
  rl: ReturnType<typeof createInterface>
): Promise<string | undefined> => {
  const answer = (
    await rl.question("\n[loop] follow-up prompt (blank to exit): ")
  ).trim();
  if (!answer) {
    return undefined;
  }
  transitionRunState(state, "working", "follow-up prompt received");
  return `${task}\n\nFollow-up:\n${answer}`;
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
  const { manifest, storage } = preparePairedRun(opts, cwd);
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
  transitionRunState(state, "working", "paired sessions ready");
};

const createPairedReview = (state: PairedState) =>
  createRunReviewWithPrompt(reviewBridgePrompt, (reviewer, prompt, opts) =>
    runReviewerAgent(reviewer, prompt, opts, nextResumeId(state, reviewer))
  );

const handleDoneSignal = async (
  task: string,
  state: PairedState,
  reviewers: Agent[],
  runReview: ReturnType<typeof createPairedReview>
): Promise<{ done: boolean; reviewNotes: string }> => {
  appendTranscript(
    state,
    createRunResultEntry("done-signal-detected", state.options.doneSignal)
  );

  if (reviewers.length === 0) {
    transitionRunState(state, "completed", "done signal detected");
    console.log(
      `\n[loop] ${doneText(state.options.doneSignal)} detected, stopping.`
    );
    return { done: true, reviewNotes: "" };
  }

  transitionRunState(state, "reviewing", "review in progress");
  const review = await runReview(reviewers, task, state.options);
  updateIds(state);
  for (const outcome of review.reviews) {
    appendTranscript(
      state,
      createRunReviewEntry(outcome.reviewer, outcome.status, outcome.reason)
    );
  }
  const reviewBridge = await drainBridge(state);
  const selfReviewNotes = formatSelfReviewNotes(
    review.failures,
    state.options.agent
  );
  if (review.approved) {
    await runDraftPrStep(task, state.options);
    transitionRunState(state, "completed", "review approved");
    console.log(
      `\n[loop] ${doneText(state.options.doneSignal)} detected and review passed, stopping.`
    );
    return { done: true, reviewNotes: "" };
  }
  transitionRunState(state, "working", "review requested changes");

  if (reviewBridge.deliveredToPrimary > 0) {
    if (selfReviewNotes) {
      console.log(
        "\n[loop] reviewer feedback delivered through bridge; keeping self-review notes in the next prompt."
      );
      return { done: false, reviewNotes: selfReviewNotes };
    }
    console.log("\n[loop] reviewer feedback delivered through bridge.");
    return { done: false, reviewNotes: "" };
  }

  const followUp = formatFollowUp(review);
  console.log(followUp.log);
  return { done: false, reviewNotes: followUp.notes };
};

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
    const doneSignalResult = await handleDoneSignal(
      task,
      state,
      shouldReview ? reviewers : [],
      runReview
    );
    if (doneSignalResult.done) {
      return true;
    }
    reviewNotes = doneSignalResult.reviewNotes;
  }

  return false;
};

const finishRun = (
  state: PairedState,
  finalState: "completed" | "failed" | "stopped"
): void => {
  const previousState = state.manifest.state;
  const next = updateRunManifest(state.storage.manifestPath, (manifest) => {
    const currentManifest = manifest ?? state.manifest;
    const touched = touchRunManifest(
      {
        ...currentManifest,
        claudeSessionId:
          getLastClaudeSessionId() || currentManifest.claudeSessionId || "",
        codexThreadId:
          getLastCodexThreadId() || currentManifest.codexThreadId || "",
        pid: process.pid,
      },
      new Date().toISOString()
    );
    return setRunManifestState(touched, finalState, touched.updatedAt);
  });
  if (next) {
    state.manifest = next;
  }
  if (previousState !== finalState) {
    appendTranscript(state, createRunStatusEntry(finalState));
  }
  if (finalState === "failed" || finalState === "stopped") {
    appendTranscript(state, createRunResultEntry(finalState));
  }
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
  let finalState: "completed" | "failed" | "stopped" = "stopped";

  try {
    appendTranscript(state, createRunStatusEntry(state.manifest.state));
    if (state.manifest.state === "input-required") {
      if (!rl) {
        console.log("[loop] follow-up prompt required; rerun interactively.");
        finalState = "stopped";
        return;
      }
      const nextTask = await promptForFollowUp(state, loopTask, rl);
      if (!nextTask) {
        finalState = "stopped";
        return;
      }
      loopTask = nextTask;
    }
    await startPair(state);
    while (true) {
      const done = await runIterations(loopTask, state, reviewers);
      if (done || !rl) {
        if (!done) {
          appendTranscript(
            state,
            createRunResultEntry("max-iterations-reached")
          );
          console.log(
            `\n[loop] reached max iterations (${opts.maxIterations}), stopping.`
          );
        }
        finalState = done ? "completed" : "stopped";
        return;
      }
      appendTranscript(state, createRunResultEntry("max-iterations-reached"));
      transitionRunState(state, "input-required", "awaiting follow-up prompt");
      console.log(`\n[loop] reached max iterations (${opts.maxIterations}).`);
      const nextTask = await promptForFollowUp(state, loopTask, rl);
      if (!nextTask) {
        finalState = "stopped";
        return;
      }
      loopTask = nextTask;
    }
  } catch (error) {
    finalState = "failed";
    throw error;
  } finally {
    finishRun(state, finalState);
    rl?.close();
  }
};
