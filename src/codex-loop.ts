#!/usr/bin/env bun
import { runCli } from "./cli";

const main = async (): Promise<void> => {
  await runCli(["--codex-only", ...process.argv.slice(2)]);
};

if (import.meta.main) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[loop] error: ${message}`);
    process.exit(1);
  });
}
