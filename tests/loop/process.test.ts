import { expect, mock, test } from "bun:test";
import type { spawn } from "bun";
import {
  DETACH_CHILD_PROCESS,
  type KillSignal,
  killChildProcess,
} from "../../src/loop/process";

interface MockChildProcess {
  kill: ReturnType<typeof mock<(signal: KillSignal) => boolean>>;
  pid?: number;
}

const asChildProcess = (child: MockChildProcess): ReturnType<typeof spawn> =>
  child as unknown as ReturnType<typeof spawn>;

test("killChildProcess no-ops when child is undefined", () => {
  const originalKill = process.kill;
  const processKillSpy = mock(() => true) as typeof process.kill;
  (process as { kill: typeof process.kill }).kill = processKillSpy;

  try {
    killChildProcess(undefined, "SIGTERM");
    expect(processKillSpy).not.toHaveBeenCalled();
  } finally {
    process.kill = originalKill;
  }
});

test("killChildProcess uses process group signaling when detached mode is supported", () => {
  const childKillSpy = mock<(signal: KillSignal) => boolean>(() => true);
  const child = asChildProcess({ kill: childKillSpy, pid: 1234 });
  const originalKill = process.kill;
  const processKillSpy = mock(() => true) as typeof process.kill;
  (process as { kill: typeof process.kill }).kill = processKillSpy;

  try {
    killChildProcess(child, "SIGTERM");
    if (DETACH_CHILD_PROCESS) {
      expect(processKillSpy).toHaveBeenCalledWith(-1234, "SIGTERM");
      expect(childKillSpy).not.toHaveBeenCalled();
      return;
    }
    expect(processKillSpy).not.toHaveBeenCalled();
    expect(childKillSpy).toHaveBeenCalledWith("SIGTERM");
  } finally {
    process.kill = originalKill;
  }
});

test("killChildProcess falls back to direct child kill when group kill throws", () => {
  if (!DETACH_CHILD_PROCESS) {
    return;
  }

  const childKillSpy = mock<(signal: KillSignal) => boolean>(() => true);
  const child = asChildProcess({ kill: childKillSpy, pid: 4321 });
  const originalKill = process.kill;
  const processKillSpy = mock(() => {
    throw new Error("group kill not available");
  }) as typeof process.kill;
  (process as { kill: typeof process.kill }).kill = processKillSpy;

  try {
    killChildProcess(child, "SIGKILL");
    expect(processKillSpy).toHaveBeenCalledWith(-4321, "SIGKILL");
    expect(childKillSpy).toHaveBeenCalledWith("SIGKILL");
  } finally {
    process.kill = originalKill;
  }
});
