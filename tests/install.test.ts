import { expect, test } from "bun:test";
import { installInternals } from "../src/install";

test("tmux install hint uses brew on macOS", () => {
  expect(installInternals.tmuxInstallHint("darwin")).toBe("brew install tmux");
});

test("tmux install hint stays generic on Linux", () => {
  expect(installInternals.tmuxInstallHint("linux")).toBe(
    "your package manager (for example: apt install tmux)"
  );
});

test("tmux nudge explains why bare loop fails without tmux", () => {
  expect(installInternals.tmuxNudgeLines("linux")).toEqual([
    "",
    "Note: tmux is not installed.",
    "The default 'loop' command opens a paired tmux workspace and will fail until tmux is installed.",
    "Install tmux with: your package manager (for example: apt install tmux)",
  ]);
});
