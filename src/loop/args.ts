import { env } from "bun";
import {
  DEFAULT_CODEX_MODEL,
  DEFAULT_DONE_SIGNAL,
  HELP,
  LOOP_VERSION,
  VALUE_FLAGS,
} from "./constants";
import type { Agent, Format, Options, ReviewMode, ValueFlag } from "./types";

const REQUIRED_PROOF_ERROR = "Missing required --proof value.";
const EMPTY_DONE_SIGNAL_ERROR = "Invalid --done value: cannot be empty";

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

const applyValueFlag = (
  flag: ValueFlag,
  value: string,
  opts: Options
): void => {
  if (flag === "agent") {
    opts.agent = parseAgent(value);
    return;
  }
  if (flag === "prompt") {
    opts.promptInput = value;
    return;
  }
  if (flag === "max") {
    const num = Number(value);
    if (!Number.isInteger(num) || num < 1) {
      throw new Error(`Invalid --max-iterations value: ${value}`);
    }
    opts.maxIterations = num;
    return;
  }
  if (flag === "done") {
    const trimmed = value.trim();
    if (!trimmed) {
      throw new Error(EMPTY_DONE_SIGNAL_ERROR);
    }
    opts.doneSignal = trimmed;
    return;
  }
  if (flag === "proof") {
    const trimmed = value.trim();
    if (!trimmed) {
      throw new Error("Invalid --proof value: cannot be empty");
    }
    opts.proof = trimmed;
    return;
  }
  opts.format = parseFormat(value);
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

const consumeArg = (
  argv: string[],
  index: number,
  opts: Options,
  positional: string[]
): { nextIndex: number; stop: boolean } => {
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
    return { nextIndex: argv.length, stop: true };
  }

  if (arg === "--review" || arg.startsWith("--review=")) {
    return {
      nextIndex: parseReviewArg(argv, index, opts, arg) + 1,
      stop: false,
    };
  }

  if (arg === "--tmux") {
    opts.tmux = true;
    return { nextIndex: index + 1, stop: false };
  }

  if (arg === "--worktree") {
    opts.worktree = true;
    return { nextIndex: index + 1, stop: false };
  }

  const flag = VALUE_FLAGS[arg];
  if (flag) {
    const value = argv[index + 1];
    if (!value) {
      throw new Error(`Missing value for ${arg}`);
    }
    applyValueFlag(flag, value, opts);
    return { nextIndex: index + 2, stop: false };
  }

  if (arg.startsWith("-")) {
    throw new Error(`Unknown argument: ${arg}`);
  }

  positional.push(arg);
  return { nextIndex: index + 1, stop: false };
};

export const parseArgs = (argv: string[]): Options => {
  const opts: Options = {
    agent: "codex",
    doneSignal: DEFAULT_DONE_SIGNAL,
    proof: "",
    format: "pretty",
    maxIterations: Number.POSITIVE_INFINITY,
    model: env.LOOP_CODEX_MODEL ?? DEFAULT_CODEX_MODEL,
    review: "claudex",
    tmux: false,
    worktree: false,
  };
  const positional: string[] = [];

  for (let index = 0; index < argv.length; ) {
    const { nextIndex, stop } = consumeArg(argv, index, opts, positional);
    index = nextIndex;
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

  if (!opts.proof) {
    throw new Error(REQUIRED_PROOF_ERROR);
  }

  return opts;
};
