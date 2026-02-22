import { afterEach, expect, test } from "bun:test";
import { parseArgs } from "../../src/loop/args";
import {
  DEFAULT_CODEX_MODEL,
  DEFAULT_DONE_SIGNAL,
  LOOP_VERSION,
} from "../../src/loop/constants";

const ORIGINAL_LOOP_CODEX_MODEL = process.env.LOOP_CODEX_MODEL;
const originalExit = process.exit;
const originalLog = console.log;

const clearModelEnv = (): void => {
  Reflect.deleteProperty(process.env, "LOOP_CODEX_MODEL");
};

const restoreModelEnv = (): void => {
  if (ORIGINAL_LOOP_CODEX_MODEL === undefined) {
    clearModelEnv();
    return;
  }
  process.env.LOOP_CODEX_MODEL = ORIGINAL_LOOP_CODEX_MODEL;
};

afterEach(() => {
  restoreModelEnv();
  process.exit = originalExit;
  console.log = originalLog;
});

test("parseArgs prints version and exits when --version is passed", () => {
  let code: number | undefined;
  console.log = ((_: string) => {
    expect(_).toBe(`loop v${LOOP_VERSION}`);
  }) as typeof console.log;
  process.exit = ((exitCode?: number): never => {
    code = exitCode;
    throw new Error("exit");
  }) as typeof process.exit;

  expect(() => {
    parseArgs(["--version"]);
  }).toThrow("exit");

  expect(code).toBe(0);
});

test("parseArgs prints version and exits when -v is passed", () => {
  let code: number | undefined;
  console.log = ((_: string) => {
    expect(_).toBe(`loop v${LOOP_VERSION}`);
  }) as typeof console.log;
  process.exit = ((exitCode?: number): never => {
    code = exitCode;
    throw new Error("exit");
  }) as typeof process.exit;

  expect(() => {
    parseArgs(["-v"]);
  }).toThrow("exit");

  expect(code).toBe(0);
});

test("parseArgs throws when required proof is missing", () => {
  expect(() => parseArgs([])).toThrow("Missing required --proof value.");
});

test("parseArgs returns expected defaults when proof is provided", () => {
  clearModelEnv();
  const opts = parseArgs(["--proof", "verify with tests"]);

  expect(opts.agent).toBe("codex");
  expect(opts.doneSignal).toBe(DEFAULT_DONE_SIGNAL);
  expect(opts.proof).toBe("verify with tests");
  expect(opts.format).toBe("pretty");
  expect(opts.maxIterations).toBe(Number.POSITIVE_INFINITY);
  expect(opts.model).toBe(DEFAULT_CODEX_MODEL);
  expect(opts.promptInput).toBeUndefined();
  expect(opts.review).toBe("claudex");
  expect(opts.tmux).toBe(false);
  expect(opts.worktree).toBe(false);
});

test("parseArgs uses LOOP_CODEX_MODEL when present", () => {
  process.env.LOOP_CODEX_MODEL = "test-model";
  const opts = parseArgs(["--proof", "verify with tests"]);

  expect(opts.model).toBe("test-model");
});

test("parseArgs handles all value flags and explicit reviewer", () => {
  const opts = parseArgs([
    "--agent",
    "claude",
    "--prompt",
    "PLAN.md",
    "--max-iterations",
    "3",
    "--done",
    "<done/>",
    "--proof",
    "verify this",
    "--format",
    "pretty",
    "--review=claudex",
  ]);

  expect(opts.agent).toBe("claude");
  expect(opts.promptInput).toBe("PLAN.md");
  expect(opts.maxIterations).toBe(3);
  expect(opts.doneSignal).toBe("<done/>");
  expect(opts.proof).toBe("verify this");
  expect(opts.format).toBe("pretty");
  expect(opts.review).toBe("claudex");
});

test("parseArgs treats bare --review as claudex when no reviewer follows", () => {
  const opts = parseArgs(["--review", "ship it", "--proof", "verify"]);

  expect(opts.review).toBe("claudex");
  expect(opts.promptInput).toBe("ship it");
});

test("parseArgs uses reviewer after --review when valid", () => {
  const opts = parseArgs(["--review", "claude", "--proof", "verify"]);

  expect(opts.review).toBe("claude");
});

test("parseArgs enables tmux mode with --tmux", () => {
  const opts = parseArgs(["--tmux", "--proof", "verify"]);

  expect(opts.tmux).toBe(true);
});

test("parseArgs enables worktree mode with --worktree", () => {
  const opts = parseArgs(["--worktree", "--proof", "verify"]);

  expect(opts.worktree).toBe(true);
});

test("parseArgs joins positional prompt words", () => {
  const opts = parseArgs(["--proof", "verify", "fix", "the", "bug"]);

  expect(opts.promptInput).toBe("fix the bug");
});

test("parseArgs rejects empty proof values", () => {
  expect(() => parseArgs(["--proof", "   "])).toThrow(
    "Invalid --proof value: cannot be empty"
  );
});

test("parseArgs rejects empty done signals", () => {
  expect(() => parseArgs(["--done", "   ", "--proof", "verify"])).toThrow(
    "Invalid --done value: cannot be empty"
  );
});

test("parseArgs throws for unknown flags", () => {
  expect(() => parseArgs(["--unknown"])).toThrow("Unknown argument: --unknown");
});

test("parseArgs throws when a value flag is missing its value", () => {
  expect(() => parseArgs(["--prompt"])).toThrow("Missing value for --prompt");
});

test("parseArgs throws for invalid max iteration value", () => {
  expect(() => parseArgs(["--max-iterations", "0"])).toThrow(
    "Invalid --max-iterations value: 0"
  );
});

test("parseArgs throws for fractional max iteration value", () => {
  expect(() => parseArgs(["--max-iterations", "2.5"])).toThrow(
    "Invalid --max-iterations value: 2.5"
  );
});

test("parseArgs trims done signal value", () => {
  const opts = parseArgs(["--done", "  <done/>  ", "--proof", "verify"]);
  expect(opts.doneSignal).toBe("<done/>");
});

test("parseArgs throws when positional prompt is provided with --prompt", () => {
  expect(() =>
    parseArgs(["--proof", "verify", "--prompt", "PLAN.md", "extra"])
  ).toThrow("Unexpected positional prompt when --prompt is already set.");
});
