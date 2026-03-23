import { expect, mock, test } from "bun:test";
import { resolve } from "node:path";
import type { Options } from "../../src/loop/types";

const projectRoot = process.cwd();
const mainPath = resolve(projectRoot, "src/loop/main.ts");
const pairedLoopPath = resolve(projectRoot, "src/loop/paired-loop.ts");
const singleLoopPath = resolve(projectRoot, "src/loop/single-loop.ts");

const makeOptions = (overrides: Partial<Options> = {}): Options => ({
  agent: "codex",
  codexModel: "test-model",
  doneSignal: "<done/>",
  format: "raw",
  maxIterations: 1,
  proof: "verify",
  ...overrides,
});

test("runLoop dispatches paired mode to the paired runner", async () => {
  mock.restore();
  const runPairedLoop = mock(async () => undefined);
  const runSingleLoop = mock(async () => undefined);
  mock.module(pairedLoopPath, () => ({ runPairedLoop }));
  mock.module(singleLoopPath, () => ({ runSingleLoop }));

  const { runLoop } = await import(mainPath);
  const opts = makeOptions({ pairedMode: true });
  await runLoop("Ship feature", opts);

  expect(runPairedLoop).toHaveBeenCalledTimes(1);
  expect(runPairedLoop).toHaveBeenCalledWith("Ship feature", opts);
  expect(runSingleLoop).not.toHaveBeenCalled();
});

test("runLoop dispatches default mode to the single runner", async () => {
  mock.restore();
  const runPairedLoop = mock(async () => undefined);
  const runSingleLoop = mock(async () => undefined);
  mock.module(pairedLoopPath, () => ({ runPairedLoop }));
  mock.module(singleLoopPath, () => ({ runSingleLoop }));

  const { runLoop } = await import(mainPath);
  const opts = makeOptions();
  await runLoop("Ship feature", opts);

  expect(runSingleLoop).toHaveBeenCalledTimes(1);
  expect(runSingleLoop).toHaveBeenCalledWith("Ship feature", opts);
  expect(runPairedLoop).not.toHaveBeenCalled();
});
