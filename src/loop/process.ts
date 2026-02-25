import type { spawn } from "bun";

type ExitSignal = "SIGINT" | "SIGTERM";
export type KillSignal = ExitSignal | "SIGKILL";
export type ChildProcess = ReturnType<typeof spawn>;

export const DETACH_CHILD_PROCESS = process.platform !== "win32";

export const killChildProcess = (
  child: ChildProcess | undefined,
  signal: KillSignal
): void => {
  if (!child) {
    return;
  }
  const pid = child.pid;
  if (DETACH_CHILD_PROCESS && typeof pid === "number" && pid > 0) {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      // Fall back to direct child signaling if group kill is unavailable.
    }
  }
  child.kill(signal);
};
