import { runSingleLoop } from "./single-loop";
import type { Options } from "./types";

export const runLoop = async (task: string, opts: Options): Promise<void> => {
  if (opts.pairedMode) {
    const { runPairedLoop } = await import("./paired-loop");
    await runPairedLoop(task, opts);
    return;
  }
  await runSingleLoop(task, opts);
};
