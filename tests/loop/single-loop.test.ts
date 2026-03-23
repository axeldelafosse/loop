import { afterEach, expect, mock, test } from "bun:test";
import { resolve } from "node:path";
import type { Options, RunResult } from "../../src/loop/types";

const projectRoot = process.cwd();
const iterationPath = resolve(projectRoot, "src/loop/iteration.ts");

const makeOptions = (overrides: Partial<Options> = {}): Options => ({
  agent: "codex",
  codexModel: "test-model",
  doneSignal: "<done/>",
  format: "raw",
  maxIterations: 1,
  pairedMode: false,
  proof: "verify",
  ...overrides,
});

const makeResult = (parsed: string): RunResult => ({
  combined: "",
  exitCode: 0,
  parsed,
});

let importNonce = 0;
const tryRunAgent = mock(
  async (
    _agent: string,
    _prompt: string,
    _opts: Options,
    _sessionId?: string
  ): Promise<RunResult> => makeResult("<done/>")
);

const loadSingleLoop = () => {
  mock.module(iterationPath, () => ({
    doneText: (value: string) => `done signal "${value}"`,
    formatFollowUp: mock(() => ({ log: "", notes: "" })),
    iterationCooldown: mock(async () => undefined),
    logIterationHeader: mock(() => undefined),
    logSessionHint: mock(() => undefined),
    tryRunAgent,
  }));
  importNonce += 1;
  return import(`../../src/loop/single-loop.ts?single-loop=${importNonce}`);
};

afterEach(() => {
  mock.restore();
  tryRunAgent.mockReset();
  tryRunAgent.mockResolvedValue(makeResult("<done/>"));
});

test("runSingleLoop uses the resumed session id on the first turn and stops on done", async () => {
  const { runSingleLoop } = await loadSingleLoop();
  const opts = makeOptions({ sessionId: "session-1" });

  await runSingleLoop("Ship feature", opts);

  expect(tryRunAgent).toHaveBeenCalledTimes(1);
  expect(tryRunAgent).toHaveBeenCalledWith(
    "codex",
    expect.stringContaining("Ship feature"),
    opts,
    "session-1"
  );
});
