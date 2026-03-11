import { env } from "bun";
import {
  DEFAULT_CODEX_MODEL,
  DEFAULT_DONE_SIGNAL,
  DEFAULT_MAX_ITERATIONS,
  HELP,
  LOOP_VERSION,
  VALUE_FLAGS,
} from "./constants";
import type {
  Agent,
  Format,
  Options,
  PlanReviewMode,
  ReviewMode,
  ValueFlag,
} from "./types";

const EMPTY_DONE_SIGNAL_ERROR = "Invalid --done value: cannot be empty";
const ONLY_MODE_CONFLICT_ERROR =
  "Cannot combine --claude-only with --codex-only.";

const parseAgent = (value: string): Agent => {
  if (value === "claude" || value === "codex") {
    return value;
  }
  throw new Error(`Invalid --agent value: ${value}`);
};

const parseFormat = (value: string): Format => {
  if (value === "pretty" || value === "raw") {
    return value;
  }
  throw new Error(`Invalid --format value: ${value}`);
};

const parseReviewValue = (value: string): ReviewMode => {
  if (value === "claude" || value === "codex" || value === "claudex") {
    return value;
  }
  throw new Error(`Invalid --review value: ${value}`);
};

const parsePlanReviewValue = (value: string | undefined): PlanReviewMode => {
  if (
    value === "other" ||
    value === "claude" ||
    value === "codex" ||
    value === "none"
  ) {
    return value;
  }
  throw new Error(`Invalid --review-plan value: ${value}`);
};

const requireTrimmedValue = (value: string, message: string): string => {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(message);
  }
  return trimmed;
};

const requireFlagValue = (arg: string, value: string | undefined): string => {
  if (!value || value === "--" || value.startsWith("-")) {
    throw new Error(`Missing value for ${arg}`);
  }
  return value;
};

const applyValueFlag = (
  flag: ValueFlag,
  value: string,
  opts: Options
): void => {
  switch (flag) {
    case "agent":
      opts.agent = parseAgent(value);
      return;
    case "prompt":
      opts.promptInput = value;
      return;
    case "max": {
      const num = Number(value);
      if (!Number.isInteger(num) || num < 1) {
        throw new Error(`Invalid --max-iterations value: ${value}`);
      }
      opts.maxIterations = num;
      return;
    }
    case "done":
      opts.doneSignal = requireTrimmedValue(value, EMPTY_DONE_SIGNAL_ERROR);
      return;
    case "proof":
      opts.proof = requireTrimmedValue(
        value,
        "Invalid --proof value: cannot be empty"
      );
      return;
    case "codexModel":
      opts.codexModel = requireTrimmedValue(
        value,
        "Invalid --codex-model value: cannot be empty"
      );
      return;
    case "codexReviewerModel":
      opts.codexReviewerModel = requireTrimmedValue(
        value,
        "Invalid --codex-reviewer-model value: cannot be empty"
      );
      return;
    case "claudeReviewerModel":
      opts.claudeReviewerModel = requireTrimmedValue(
        value,
        "Invalid --claude-reviewer-model value: cannot be empty"
      );
      return;
    case "session":
      opts.sessionId = requireTrimmedValue(
        value,
        "Invalid --session value: cannot be empty"
      );
      return;
    case "format":
      opts.format = parseFormat(value);
      return;
    default: {
      const exhaustive: never = flag;
      throw new Error(`Unhandled value flag: ${exhaustive}`);
    }
  }
};

const applyOnlyMode = (agent: Agent, opts: Options): void => {
  opts.agent = agent;
  opts.review = agent;
  opts.reviewPlan = agent;
};

const parseOnlyModeFlag = (arg: string): Agent | undefined => {
  if (arg === "--claude-only") {
    return "claude";
  }
  if (arg === "--codex-only") {
    return "codex";
  }
  return undefined;
};

const resolveOnlyMode = (current: Agent | undefined, next: Agent): Agent => {
  if (current && current !== next) {
    throw new Error(ONLY_MODE_CONFLICT_ERROR);
  }
  return next;
};

const parseReviewArg = (
  argv: string[],
  index: number,
  opts: Options,
  arg: string
): number => {
  if (arg.startsWith("--review=")) {
    opts.review = parseReviewValue(arg.slice("--review=".length));
    return index;
  }

  const next = argv[index + 1];
  if (next === "claude" || next === "codex" || next === "claudex") {
    opts.review = next;
    return index + 1;
  }

  opts.review = "claudex";
  return index;
};

const parsePlanReviewArg = (
  argv: string[],
  index: number,
  opts: Options,
  arg: string
): number => {
  if (arg.startsWith("--review-plan=")) {
    opts.reviewPlan = parsePlanReviewValue(arg.slice("--review-plan=".length));
    return index;
  }

  const next = argv[index + 1];
  try {
    opts.reviewPlan = parsePlanReviewValue(next);
    return index + 1;
  } catch {
    opts.reviewPlan = "other";
    return index;
  }
};

const parseModelArg = (
  argv: string[],
  index: number,
  opts: Options,
  arg: string
): number | undefined => {
  if (arg.startsWith("--codex-model=")) {
    applyValueFlag("codexModel", arg.slice("--codex-model=".length), opts);
    return index + 1;
  }
  if (arg.startsWith("--codex-reviewer-model=")) {
    applyValueFlag(
      "codexReviewerModel",
      arg.slice("--codex-reviewer-model=".length),
      opts
    );
    return index + 1;
  }
  if (arg.startsWith("--claude-reviewer-model=")) {
    applyValueFlag(
      "claudeReviewerModel",
      arg.slice("--claude-reviewer-model=".length),
      opts
    );
    return index + 1;
  }
  if (
    arg === "--codex-model" ||
    arg === "--codex-reviewer-model" ||
    arg === "--claude-reviewer-model"
  ) {
    applyValueFlag(
      VALUE_FLAGS[arg],
      requireFlagValue(arg, argv[index + 1]),
      opts
    );
    return index + 2;
  }
};

const consumeArg = (
  argv: string[],
  index: number,
  opts: Options,
  positional: string[],
  onlyAgent: Agent | undefined
): { nextIndex: number; stop: boolean; onlyAgent: Agent | undefined } => {
  const arg = argv[index];

  if (arg === "-v" || arg === "--version") {
    console.log(`loop v${LOOP_VERSION}`);
    process.exit(0);
  }

  if (arg === "-h" || arg === "--help") {
    console.log(HELP);
    process.exit(0);
  }

  if (arg === "--") {
    positional.push(...argv.slice(index + 1));
    return { nextIndex: argv.length, stop: true, onlyAgent };
  }

  const modelNextIndex = parseModelArg(argv, index, opts, arg);
  if (modelNextIndex !== undefined) {
    return { nextIndex: modelNextIndex, stop: false, onlyAgent };
  }

  const modeAgent = parseOnlyModeFlag(arg);
  if (modeAgent) {
    applyOnlyMode(modeAgent, opts);
    return {
      nextIndex: index + 1,
      stop: false,
      onlyAgent: resolveOnlyMode(onlyAgent, modeAgent),
    };
  }

  if (arg === "--review" || arg.startsWith("--review=")) {
    return {
      nextIndex: parseReviewArg(argv, index, opts, arg) + 1,
      stop: false,
      onlyAgent,
    };
  }

  if (arg === "--review-plan" || arg.startsWith("--review-plan=")) {
    return {
      nextIndex: parsePlanReviewArg(argv, index, opts, arg) + 1,
      stop: false,
      onlyAgent,
    };
  }

  if (arg === "--tmux") {
    opts.tmux = true;
    return { nextIndex: index + 1, stop: false, onlyAgent };
  }

  if (arg === "--worktree") {
    opts.worktree = true;
    return { nextIndex: index + 1, stop: false, onlyAgent };
  }

  const flag = VALUE_FLAGS[arg];
  if (flag) {
    const value = argv[index + 1];
    if (!value) {
      throw new Error(`Missing value for ${arg}`);
    }
    applyValueFlag(flag, value, opts);
    return { nextIndex: index + 2, stop: false, onlyAgent };
  }

  if (arg.startsWith("-")) {
    throw new Error(`Unknown argument: ${arg}`);
  }

  positional.push(arg);
  return { nextIndex: index + 1, stop: false, onlyAgent };
};

export const parseArgs = (argv: string[]): Options => {
  const opts: Options = {
    agent: "codex",
    doneSignal: DEFAULT_DONE_SIGNAL,
    proof: "",
    format: "pretty",
    maxIterations: DEFAULT_MAX_ITERATIONS,
    codexModel: env.LOOP_CODEX_MODEL ?? DEFAULT_CODEX_MODEL,
    review: "claudex",
    tmux: false,
    worktree: false,
  };
  const positional: string[] = [];
  let onlyAgent: Agent | undefined;

  for (let index = 0; index < argv.length; ) {
    const {
      nextIndex,
      stop,
      onlyAgent: nextOnlyAgent,
    } = consumeArg(argv, index, opts, positional, onlyAgent);
    index = nextIndex;
    onlyAgent = nextOnlyAgent;
    if (stop) {
      break;
    }
  }

  if (positional.length > 0) {
    if (opts.promptInput) {
      throw new Error(
        "Unexpected positional prompt when --prompt is already set."
      );
    }
    opts.promptInput = positional.join(" ");
  }

  return opts;
};
