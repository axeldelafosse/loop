import { expect, test } from "bun:test";
import { codexTmuxProxyInternals } from "../../src/loop/codex-tmux-proxy";

const bridgeMessage = {
  at: "2026-03-29T00:00:00.000Z",
  id: "msg-1",
  kind: "message" as const,
  message: "Please review the latest diff.",
  source: "claude" as const,
  target: "codex" as const,
};

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

test("codex tmux proxy records turn ids from turn/start responses", () => {
  const turnIds = new Set<string>(["turn-1"]);

  codexTmuxProxyInternals.noteStartedTurn(turnIds, {
    turn: { id: "turn-2" },
  });

  expect([...turnIds]).toEqual(["turn-1", "turn-2"]);
  expect(codexTmuxProxyInternals.latestActiveTurnId(turnIds)).toBe("turn-2");
});

test("codex tmux proxy keeps the newest active turn id", () => {
  const activeTurns = new Set(["turn-1", "turn-2"]);

  expect(codexTmuxProxyInternals.latestActiveTurnId(activeTurns)).toBe(
    "turn-2"
  );
  expect(codexTmuxProxyInternals.latestActiveTurnId(new Set())).toBe(undefined);
});

test("codex tmux proxy steers bridge messages into an active turn", () => {
  expect(
    codexTmuxProxyInternals.buildBridgeInjectionFrame(
      -1,
      "thread-1",
      bridgeMessage,
      "turn-active"
    )
  ).toEqual({
    id: -1,
    method: "turn/steer",
    params: {
      expectedTurnId: "turn-active",
      input: [
        {
          text: "Please review the latest diff.",
          text_elements: [],
          type: "text",
        },
      ],
      threadId: "thread-1",
    },
  });
});

test("codex tmux proxy starts a new turn when no active turn exists", () => {
  expect(
    codexTmuxProxyInternals.buildBridgeInjectionFrame(
      -1,
      "thread-1",
      bridgeMessage
    )
  ).toEqual({
    id: -1,
    method: "turn/start",
    params: {
      input: [
        {
          text: "Please review the latest diff.",
          text_elements: [],
          type: "text",
        },
      ],
      threadId: "thread-1",
    },
  });
});

test("codex tmux proxy only pauses bridge drain when it cannot steer", () => {
  expect(
    codexTmuxProxyInternals.shouldPauseBridgeDrain(false, undefined, 0)
  ).toBe(false);
  expect(
    codexTmuxProxyInternals.shouldPauseBridgeDrain(true, "turn-active", 0)
  ).toBe(false);
  expect(
    codexTmuxProxyInternals.shouldPauseBridgeDrain(true, undefined, 0)
  ).toBe(true);
  expect(
    codexTmuxProxyInternals.shouldPauseBridgeDrain(false, undefined, 1)
  ).toBe(true);
});
