import { expect, test } from "bun:test";
import { codexTmuxProxyInternals } from "../../src/loop/codex-tmux-proxy";

test("codex tmux proxy waits briefly for the tmux session to appear", () => {
  const now = Date.now();

  expect(
    codexTmuxProxyInternals.shouldStopForTmuxSession(
      false,
      false,
      now + 1000,
      now
    )
  ).toBe(false);
});

test("codex tmux proxy stops once the startup grace window is over", () => {
  const now = Date.now();

  expect(
    codexTmuxProxyInternals.shouldStopForTmuxSession(false, false, now - 1, now)
  ).toBe(true);
});

test("codex tmux proxy stops immediately after a seen tmux session disappears", () => {
  const now = Date.now();

  expect(
    codexTmuxProxyInternals.shouldStopForTmuxSession(
      false,
      true,
      now + 1000,
      now
    )
  ).toBe(true);
  expect(
    codexTmuxProxyInternals.shouldStopForTmuxSession(
      true,
      true,
      now + 1000,
      now
    )
  ).toBe(false);
});
