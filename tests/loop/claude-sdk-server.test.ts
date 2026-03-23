import { afterEach, expect, test } from "bun:test";
import type { serve, spawn } from "bun";
import {
  claudeSdkInternals,
  closeClaudeSdk,
  runClaudeTurn,
  startClaudeSdk,
} from "../../src/loop/claude-sdk-server";
import type { Options } from "../../src/loop/types";

type JsonRecord = Record<string, unknown>;
type SendFrame = (frame: JsonRecord) => void;
type UserMessageHandler = (args: {
  content: string;
  index: number;
  send: SendFrame;
}) => void;
interface WebsocketHandlers {
  close: (ws: FakeSocket, code: number, reason: string) => void;
  message: (ws: FakeSocket, data: string | ArrayBuffer) => void;
  open: (ws: FakeSocket) => void;
}

interface FakeSocket {
  close: () => void;
  data: { role: "claude" | "frontend" };
  send: (data: string) => void;
}

const makeOptions = (): Options => ({
  agent: "claude",
  doneSignal: "<done/>",
  format: "raw",
  maxIterations: 1,
  codexModel: "test-model",
  proof: "proof",
});

let lastSpawnCommand: string[] = [];
let spawnCount = 0;
let disconnectActiveClaude: (() => void) | undefined;

const asRecord = (value: unknown): JsonRecord => {
  if (typeof value === "object" && value !== null) {
    return value as JsonRecord;
  }
  return {};
};

const installHarness = (onUserMessage: UserMessageHandler): string[] => {
  const userMessages: string[] = [];
  let handlers: WebsocketHandlers | undefined;
  let fakePid = 30_000;

  const serveMock = ((options: unknown): unknown => {
    handlers = asRecord(asRecord(options).websocket) as WebsocketHandlers;
    return {
      stop: () => {
        handlers = undefined;
      },
    };
  }) as unknown as (
    ...args: Parameters<typeof serve>
  ) => ReturnType<typeof serve>;

  const spawnMock = ((_command: unknown, _options: unknown): unknown => {
    if (!handlers) {
      throw new Error("expected websocket handlers before spawn");
    }
    lastSpawnCommand = Array.isArray(_command)
      ? _command.map((part) => String(part))
      : [];
    spawnCount += 1;

    const currentHandlers = handlers;
    let stdoutController:
      | ReadableStreamDefaultController<Uint8Array>
      | undefined;
    let stderrController:
      | ReadableStreamDefaultController<Uint8Array>
      | undefined;
    const stdout = new ReadableStream<Uint8Array>({
      start(controller) {
        stdoutController = controller;
      },
    });
    const stderr = new ReadableStream<Uint8Array>({
      start(controller) {
        stderrController = controller;
      },
    });

    let exitedResolve = (_code: number): void => undefined;
    const exited = new Promise<number>((resolve) => {
      exitedResolve = resolve;
    });

    let socketClosed = false;
    let childClosed = false;

    const socket: FakeSocket = {
      data: { role: "claude" },
      close: () => {
        if (socketClosed) {
          return;
        }
        socketClosed = true;
        currentHandlers.close(socket, 1000, "closed");
      },
      send: (raw) => {
        for (const line of raw.split("\n")) {
          if (!line.trim()) {
            continue;
          }
          const frame = asRecord(JSON.parse(line));
          const send: SendFrame = (out) => {
            currentHandlers.message(socket, `${JSON.stringify(out)}\n`);
          };
          if (
            frame.type === "control_request" &&
            asRecord(frame.request).subtype === "initialize"
          ) {
            send({
              type: "control_response",
              response: { request_id: frame.request_id, subtype: "success" },
            });
            send({ type: "system", subtype: "init", session_id: "session-1" });
            continue;
          }
          if (frame.type === "user") {
            const content = String(asRecord(frame.message).content ?? "");
            userMessages.push(content);
            onUserMessage({
              content,
              index: userMessages.length - 1,
              send,
            });
          }
        }
      },
    };
    disconnectActiveClaude = () => {
      socket.close();
    };

    queueMicrotask(() => {
      currentHandlers.open(socket);
    });

    const closeChild = (): void => {
      if (childClosed) {
        return;
      }
      childClosed = true;
      socket.close();
      try {
        stdoutController?.close();
      } catch {
        // ignore close errors in tests
      }
      try {
        stderrController?.close();
      } catch {
        // ignore close errors in tests
      }
      exitedResolve(0);
    };

    return {
      exited,
      kill: (_signal?: string) => {
        closeChild();
        return true;
      },
      pid: fakePid++,
      stderr,
      stdout,
    };
  }) as unknown as (
    ...args: Parameters<typeof spawn>
  ) => ReturnType<typeof spawn>;

  claudeSdkInternals.setServeFn(serveMock);
  claudeSdkInternals.setSpawnFn(spawnMock);
  return userMessages;
};

afterEach(async () => {
  await closeClaudeSdk();
  disconnectActiveClaude = undefined;
  lastSpawnCommand = [];
  spawnCount = 0;
  claudeSdkInternals.restoreSpawnFn();
  claudeSdkInternals.restoreServeFn();
  claudeSdkInternals.restoreCountChildProcessesFn();
  claudeSdkInternals.restoreChildPollIntervalMs();
  claudeSdkInternals.restoreWaitTimeoutMs();
});

test("startClaudeSdk uses the provided model", async () => {
  installHarness(() => undefined);

  await startClaudeSdk("claude-review");

  const modelArgIndex = lastSpawnCommand.indexOf("--model");
  expect(modelArgIndex).toBeGreaterThan(-1);
  expect(lastSpawnCommand[modelArgIndex + 1]).toBe("claude-review");
});

test("startClaudeSdk forwards mcp config when provided", async () => {
  installHarness(() => undefined);

  await startClaudeSdk("claude-review", undefined, {
    mcpConfig: "/tmp/loop-bridge.json",
    persistent: true,
  });

  const mcpArgIndex = lastSpawnCommand.indexOf("--mcp-config");
  expect(mcpArgIndex).toBeGreaterThan(-1);
  expect(lastSpawnCommand[mcpArgIndex + 1]).toBe("/tmp/loop-bridge.json");
});

test("runClaudeTurn resolves immediately when no background task is detected", async () => {
  const userMessages = installHarness(({ index, send }) => {
    if (index !== 0) {
      return;
    }
    send({
      type: "assistant",
      message: { content: [{ type: "text", text: "done" }] },
    });
    send({ type: "result", is_error: false });
  });

  const result = await runClaudeTurn("ship it", makeOptions(), {
    onDelta: () => undefined,
    onParsed: () => undefined,
    onRaw: () => undefined,
  });

  expect(userMessages).toEqual(["ship it"]);
  expect(result.exitCode).toBe(0);
  expect(result.parsed).toBe("done");
});

test("runClaudeTurn drains background Task workers then sends continuation", async () => {
  let pollCount = 0;
  claudeSdkInternals.setChildPollIntervalMs(1);
  claudeSdkInternals.setCountChildProcessesFn(() => {
    pollCount += 1;
    return pollCount < 3 ? 1 : 0;
  });

  const userMessages = installHarness(({ index, send }) => {
    if (index === 0) {
      send({
        type: "control_request",
        request_id: "tool-1",
        request: {
          subtype: "can_use_tool",
          tool_name: "Task",
          input: { run_in_background: true },
        },
      });
      send({ type: "result", is_error: false });
      return;
    }
    if (index === 1) {
      send({
        type: "assistant",
        message: { content: [{ type: "text", text: "final answer" }] },
      });
      send({ type: "result", is_error: false });
    }
  });

  const result = await runClaudeTurn("do work", makeOptions(), {
    onDelta: () => undefined,
    onParsed: () => undefined,
    onRaw: () => undefined,
  });

  expect(pollCount).toBeGreaterThanOrEqual(3);
  expect(userMessages[1]).toBe(claudeSdkInternals.BACKGROUND_TASK_CONTINUATION);
  expect(result.parsed).toBe("final answer");
});

test("persistent Claude sessions stay attached across turns", async () => {
  const userMessages = installHarness(({ send }) => {
    send({
      type: "assistant",
      message: { content: [{ type: "text", text: "ok" }] },
    });
    send({ type: "result", is_error: false });
  });

  await startClaudeSdk("claude-review", undefined, { persistent: true });

  const first = await runClaudeTurn("first", makeOptions(), {
    onDelta: () => undefined,
    onParsed: () => undefined,
    onRaw: () => undefined,
  });
  const second = await runClaudeTurn("second", makeOptions(), {
    onDelta: () => undefined,
    onParsed: () => undefined,
    onRaw: () => undefined,
  });

  expect(first.parsed).toBe("ok");
  expect(second.parsed).toBe("ok");
  expect(userMessages).toEqual(["first", "second"]);
  expect(spawnCount).toBe(1);
});

test("startClaudeSdk restarts a persistent session when the model changes", async () => {
  installHarness(() => undefined);

  await startClaudeSdk("claude-work", undefined, { persistent: true });
  await startClaudeSdk("claude-review", undefined, { persistent: true });

  const modelArgIndex = lastSpawnCommand.indexOf("--model");
  const resumeArgIndex = lastSpawnCommand.indexOf("--resume");
  expect(spawnCount).toBe(2);
  expect(modelArgIndex).toBeGreaterThan(-1);
  expect(lastSpawnCommand[modelArgIndex + 1]).toBe("claude-review");
  expect(resumeArgIndex).toBeGreaterThan(-1);
  expect(lastSpawnCommand[resumeArgIndex + 1]).toBe("session-1");
});

test("startClaudeSdk resumes a persistent session after unexpected disconnect", async () => {
  const userMessages = installHarness(({ index, send }) => {
    if (index === 0) {
      queueMicrotask(() => {
        disconnectActiveClaude?.();
      });
      return;
    }
    send({
      type: "assistant",
      message: { content: [{ type: "text", text: "ok" }] },
    });
    send({ type: "result", is_error: false });
  });

  await startClaudeSdk("claude-review", undefined, { persistent: true });
  expect(disconnectActiveClaude).toBeDefined();

  await expect(
    runClaudeTurn("first", makeOptions(), {
      onDelta: () => undefined,
      onParsed: () => undefined,
      onRaw: () => undefined,
    })
  ).rejects.toThrow("claude sdk connection closed unexpectedly");

  await new Promise((resolve) => setTimeout(resolve, 0));

  await startClaudeSdk("claude-review", undefined, { persistent: true });

  const resumeArgIndex = lastSpawnCommand.indexOf("--resume");
  expect(spawnCount).toBe(2);
  expect(resumeArgIndex).toBeGreaterThan(-1);
  expect(lastSpawnCommand[resumeArgIndex + 1]).toBe("session-1");

  const result = await runClaudeTurn("second", makeOptions(), {
    onDelta: () => undefined,
    onParsed: () => undefined,
    onRaw: () => undefined,
  });

  expect(result.parsed).toBe("ok");
  expect(userMessages).toEqual(["first", "second"]);
});

test("non-Task tools with run_in_background do not trigger drain mode", async () => {
  let pollCount = 0;
  claudeSdkInternals.setChildPollIntervalMs(1);
  claudeSdkInternals.setCountChildProcessesFn(() => {
    pollCount += 1;
    return 1;
  });

  const userMessages = installHarness(({ index, send }) => {
    if (index !== 0) {
      return;
    }
    send({
      type: "control_request",
      request_id: "tool-2",
      request: {
        subtype: "can_use_tool",
        tool_name: "Bash",
        input: { run_in_background: true },
      },
    });
    send({ type: "result", is_error: false });
  });

  await runClaudeTurn("do work", makeOptions(), {
    onDelta: () => undefined,
    onParsed: () => undefined,
    onRaw: () => undefined,
  });

  expect(userMessages).toEqual(["do work"]);
  expect(pollCount).toBe(0);
});

test("timeout rejects even while background workers are still present", async () => {
  claudeSdkInternals.setWaitTimeoutMs(25);
  claudeSdkInternals.setChildPollIntervalMs(1);
  claudeSdkInternals.setCountChildProcessesFn(() => 1);

  installHarness(({ index, send }) => {
    if (index !== 0) {
      return;
    }
    send({
      type: "control_request",
      request_id: "tool-3",
      request: {
        subtype: "can_use_tool",
        tool_name: "Task",
        input: { run_in_background: true },
      },
    });
    send({ type: "result", is_error: false });
  });

  await expect(
    runClaudeTurn("do work", makeOptions(), {
      onDelta: () => undefined,
      onParsed: () => undefined,
      onRaw: () => undefined,
    })
  ).rejects.toThrow("claude sdk turn timed out");
});
