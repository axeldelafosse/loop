import { afterEach, expect, mock, test } from "bun:test";
import { buildCodexBridgeConfigArgs } from "../../src/loop/bridge";
import type { Options } from "../../src/loop/types";

interface RequestFrame {
  error?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
  result?: unknown;
}

type AppServerModule = typeof import("../../src/loop/codex-app-server");

interface TestStream {
  close: () => void;
  enqueue: (line: string) => void;
  stream: ReadableStream<Uint8Array>;
}

interface TestProcess {
  close: () => void;
  killSignals: string[];
  pid: number;
  writes: string[];
}

type ResponseWriter = (frame: Record<string, unknown>) => void;
type RequestHandler = (request: RequestFrame, write: ResponseWriter) => void;
const LOCAL_WS_URL_RE = /^ws:\/\/127\.0\.0\.1:\d+$/;

const noopRequestHandler: RequestHandler = () => {
  // noop
};

const createStream = (): TestStream => {
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  return {
    close: () => {
      controller?.close();
    },
    enqueue: (line) => {
      controller?.enqueue(new TextEncoder().encode(line));
    },
    stream,
  };
};

let modulePromise: Promise<AppServerModule> | undefined;
let moduleExports: AppServerModule | undefined;
let codexAppServerInternals: AppServerModule["codexAppServerInternals"];
let processes: TestProcess[] = [];
let currentHandler: RequestHandler = noopRequestHandler;
let lastSpawnCommand: string[] = [];

const makeStreamResponse = (
  request: RequestFrame,
  write: ResponseWriter
): void => {
  currentHandler(request, write);
};

const installSpawn = (appServerModule: AppServerModule): void => {
  appServerModule.codexAppServerInternals.setSpawnFn(
    (_command: unknown, _options: unknown): unknown => {
      lastSpawnCommand = Array.isArray(_command)
        ? _command.map((part) => String(part))
        : [];
      const writes: string[] = [];
      const killSignals: string[] = [];
      const pid = 10_000 + processes.length + 1;
      const stdout = createStream();
      const stderr = createStream();
      let exitedResolve = () => undefined;
      const exited = new Promise<number>((resolve) => {
        exitedResolve = resolve;
      });
      let closed = false;

      const close = (): void => {
        if (closed) {
          return;
        }
        closed = true;
        stdout.close();
        stderr.close();
        exitedResolve(0);
      };

      const emit = (frame: Record<string, unknown>): void => {
        stdout.enqueue(`${JSON.stringify(frame)}\n`);
      };

      const child = {
        exited,
        kill: (signal?: string) => {
          killSignals.push(signal ?? "SIGTERM");
          close();
        },
        pid,
        stdin: {
          write: (chunk: string): void => {
            const lines = chunk.split("\n");
            for (const raw of lines) {
              if (!raw.trim()) {
                continue;
              }
              writes.push(raw);
              const request = JSON.parse(raw) as RequestFrame;
              makeStreamResponse(request, emit);
            }
          },
        },
        stderr: stderr.stream,
        stdout: stdout.stream,
      };
      processes.push({ close, killSignals, pid, writes });
      return child;
    }
  );
};

const installConnectWs = (appServerModule: AppServerModule): void => {
  appServerModule.codexAppServerInternals.setConnectWsFn(() => {
    const client: import("../../src/loop/ws-client").WsClient = {
      onmessage: undefined,
      onclose: undefined,
      send: (data: string) => {
        for (const raw of data.split("\n")) {
          if (!raw.trim()) {
            continue;
          }
          const proc = processes.at(-1);
          if (proc) {
            proc.writes.push(raw);
          }
          const request = JSON.parse(raw) as RequestFrame;
          makeStreamResponse(request, (frame) => {
            queueMicrotask(() => {
              client.onmessage?.(JSON.stringify(frame));
            });
          });
        }
      },
      close: () => {
        // noop for tests
      },
    };
    return Promise.resolve(client);
  });
};

const getModule = async (): Promise<AppServerModule> => {
  if (!modulePromise) {
    modulePromise = import(
      `../../src/loop/codex-app-server?test=${Date.now()}-${Math.random()}`
    );
  }
  moduleExports = await modulePromise;
  codexAppServerInternals = moduleExports.codexAppServerInternals;
  installSpawn(moduleExports);
  installConnectWs(moduleExports);
  return moduleExports;
};

const makeOptions = (): Options => ({
  agent: "codex",
  doneSignal: "<done/>",
  format: "raw",
  maxIterations: 1,
  codexModel: "test-model",
  proof: "proof",
});

const latestWrites = (): string[] => {
  return processes.at(-1)?.writes ?? [];
};

const latestProcess = (): TestProcess | undefined => processes.at(-1);

const resetState = async (): Promise<void> => {
  const appServer = await getModule();
  await appServer.closeAppServer();
  for (const process of processes) {
    process.close();
  }
  moduleExports = undefined;
  modulePromise = undefined;
  processes = [];
  currentHandler = noopRequestHandler;
  lastSpawnCommand = [];
  appServer.codexAppServerInternals.restoreSpawnFn();
  appServer.codexAppServerInternals.restoreConnectWsFn();
};

afterEach(async () => {
  await resetState();
  mock.restore();
});

test("parseLine returns strict JSON frames only", async () => {
  await getModule();
  expect(codexAppServerInternals.parseLine('{"ok":true}')).toEqual({
    ok: true,
  });
  expect(codexAppServerInternals.parseLine("not-json")).toBeUndefined();
  expect(codexAppServerInternals.parseLine('  {"ok":1}\n')).toEqual({ ok: 1 });
});

test("parseText flattens nested text payloads", async () => {
  await getModule();
  expect(
    codexAppServerInternals.parseText({
      content: [{ text: "  one " }, { content: [{ text: "two" }, ""] }],
    })
  ).toBe("one\ntwo");
});

test("startAppServer fails fast when initialize returns an error", async () => {
  const appServer = await getModule();
  currentHandler = (request, write) => {
    if (request.method === "initialize") {
      write({ id: request.id, error: { message: "unsupported transport" } });
    }
  };

  await expect(appServer.startAppServer()).rejects.toBeInstanceOf(
    appServer.CodexAppServerFallbackError
  );
  expect(latestWrites().length).toBeGreaterThan(0);
});

test("startAppServer forwards config overrides into the app-server command", async () => {
  const appServer = await getModule();
  currentHandler = (request, write) => {
    if (request.method === "initialize") {
      write({ id: request.id, result: {} });
    }
  };

  await appServer.startAppServer({
    configValues: ['mcp_servers.bridge.command="/bin/echo"'],
    persistentThread: true,
  });

  expect(lastSpawnCommand.slice(0, 5)).toEqual([
    "codex",
    "-c",
    'mcp_servers.bridge.command="/bin/echo"',
    "app-server",
    "--listen",
  ]);
  expect(lastSpawnCommand[5]).toContain("ws://0.0.0.0:");
});

test("startAppServer exposes the app-server websocket URL", async () => {
  const appServer = await getModule();
  currentHandler = (request, write) => {
    if (request.method === "initialize") {
      write({ id: request.id, result: {} });
    }
  };

  await appServer.startAppServer();
  expect(appServer.getCodexAppServerUrl()).toMatch(LOCAL_WS_URL_RE);

  await appServer.closeAppServer();
  expect(appServer.getCodexAppServerUrl()).toBe("");
});

test("startAppServer normalizes codex bridge config args before spawning", async () => {
  const appServer = await getModule();
  currentHandler = (request, write) => {
    if (request.method === "initialize") {
      write({ id: request.id, result: {} });
    }
  };

  await appServer.startAppServer({
    configValues: buildCodexBridgeConfigArgs("/tmp/loop-run", "codex"),
  });

  expect(lastSpawnCommand.filter((value) => value === "-c")).toHaveLength(2);
  expect(lastSpawnCommand).toContain("app-server");
  expect(lastSpawnCommand).not.toContain("-c,-c");
  const bridgeArgs = lastSpawnCommand.slice(
    lastSpawnCommand.indexOf("-c"),
    lastSpawnCommand.indexOf("app-server")
  );
  expect(bridgeArgs).toEqual([
    "-c",
    expect.stringContaining("mcp_servers.loop-bridge.command="),
    "-c",
    expect.stringContaining("mcp_servers.loop-bridge.args="),
  ]);
});

test("runCodexTurn promotes thread/start unsupported errors to fallback errors", async () => {
  const appServer = await getModule();
  currentHandler = (request, write) => {
    if (request.method === "initialize") {
      write({ id: request.id, result: {} });
      return;
    }
    if (request.method === "thread/start") {
      write({ id: request.id, error: { message: "method not found" } });
    }
  };

  await expect(
    appServer.runCodexTurn("say hi", makeOptions(), {
      onParsed: () => undefined,
      onRaw: () => undefined,
    })
  ).rejects.toBeInstanceOf(appServer.CodexAppServerFallbackError);
});

test("runCodexTurn promotes turn/start unsupported errors to fallback errors", async () => {
  const appServer = await getModule();
  currentHandler = (request, write) => {
    if (request.method === "initialize") {
      write({ id: request.id, result: {} });
      return;
    }
    if (request.method === "thread/start") {
      write({ id: request.id, result: { thread: { id: "thread-1" } } });
      return;
    }
    if (request.method === "turn/start") {
      write({ id: request.id, error: { message: "unknown method" } });
    }
  };

  await expect(
    appServer.runCodexTurn("say hi", makeOptions(), {
      onParsed: () => undefined,
      onRaw: () => undefined,
    })
  ).rejects.toBeInstanceOf(appServer.CodexAppServerFallbackError);
});

test("persistent codex threads are reused across turns", async () => {
  const appServer = await getModule();
  let threadStarts = 0;
  let turnStarts = 0;
  currentHandler = (request, write) => {
    if (request.method === "initialize") {
      write({ id: request.id, result: {} });
      return;
    }
    if (request.method === "thread/start") {
      threadStarts += 1;
      write({ id: request.id, result: { thread: { id: "thread-1" } } });
      return;
    }
    if (request.method === "turn/start") {
      turnStarts += 1;
      const turnId = `turn-${turnStarts}`;
      write({ id: request.id, result: { turn: { id: turnId } } });
      setTimeout(() => {
        write({
          method: "turn/completed",
          params: { turnId, turn: { id: turnId, status: "completed" } },
        });
      }, 0);
    }
  };

  await appServer.startAppServer({ persistentThread: true });
  await appServer.runCodexTurn("first", makeOptions(), {
    onParsed: () => undefined,
    onRaw: () => undefined,
  });
  await appServer.runCodexTurn("second", makeOptions(), {
    onParsed: () => undefined,
    onRaw: () => undefined,
  });

  expect(threadStarts).toBe(1);
  expect(turnStarts).toBe(2);
});

test("startAppServer eagerly creates a persistent thread when given a model", async () => {
  const appServer = await getModule();
  let threadStarts = 0;
  currentHandler = (request, write) => {
    if (request.method === "initialize") {
      write({ id: request.id, result: {} });
      return;
    }
    if (request.method === "thread/start") {
      threadStarts += 1;
      write({ id: request.id, result: { thread: { id: "thread-1" } } });
    }
  };

  await appServer.startAppServer({
    persistentThread: true,
    threadModel: "test-model",
  });

  expect(threadStarts).toBe(1);
  expect(appServer.getLastCodexThreadId()).toBe("thread-1");
});

test("bridge-configured planning keeps the paired Codex thread alive for startup", async () => {
  const appServer = await getModule();
  let threadStarts = 0;
  let turnStarts = 0;
  currentHandler = (request, write) => {
    if (request.method === "initialize") {
      write({ id: request.id, result: {} });
      return;
    }
    if (request.method === "thread/start") {
      threadStarts += 1;
      write({ id: request.id, result: { thread: { id: "thread-1" } } });
      return;
    }
    if (request.method === "turn/start") {
      turnStarts += 1;
      const turnId = `turn-${turnStarts}`;
      write({ id: request.id, result: { turn: { id: turnId } } });
      setTimeout(() => {
        write({
          method: "turn/completed",
          params: { turnId, turn: { id: turnId, status: "completed" } },
        });
      }, 0);
    }
  };

  const bridgeArgs = buildCodexBridgeConfigArgs("/tmp/loop-run", "codex");
  const opts: Options = {
    ...makeOptions(),
    codexMcpConfigArgs: bridgeArgs,
    pairedMode: true,
  };

  await appServer.startAppServer({
    configValues: bridgeArgs,
    persistentThread: true,
  });
  const result = await appServer.runCodexTurn(
    "Plan mode:\nTask:\nship feature",
    opts,
    {
      onParsed: () => undefined,
      onRaw: () => undefined,
    }
  );

  expect(result.exitCode).toBe(0);
  expect(processes).toHaveLength(1);
  expect(lastSpawnCommand.slice(0, bridgeArgs.length + 2)).toEqual([
    "codex",
    ...bridgeArgs,
    "app-server",
  ]);

  await appServer.startAppServer({
    configValues: bridgeArgs,
    persistentThread: true,
    threadModel: "test-model",
  });

  expect(processes).toHaveLength(1);
  expect(threadStarts).toBe(1);
  expect(turnStarts).toBe(1);
  expect(appServer.getLastCodexThreadId()).toBe("thread-1");
});

test("runCodexTurn recovers after unexpected exit", async () => {
  const appServer = await getModule();
  currentHandler = (request, write) => {
    if (request.method === "initialize") {
      write({ id: request.id, result: {} });
      return;
    }
    if (request.method === "thread/start") {
      write({ id: request.id, result: { thread: { id: "thread-1" } } });
      return;
    }
    if (request.method === "turn/start") {
      write({ id: request.id, result: { turn: { id: "turn-1" } } });
      processes.at(-1)?.close();
      return;
    }
  };

  await expect(
    appServer.runCodexTurn("say hi", makeOptions(), {
      onParsed: () => undefined,
      onRaw: () => undefined,
    })
  ).rejects.toBeInstanceOf(appServer.CodexAppServerFallbackError);

  currentHandler = (request, write) => {
    if (request.method === "initialize") {
      write({ id: request.id, result: {} });
      return;
    }
    if (request.method === "thread/start") {
      write({ id: request.id, result: { thread: { id: "thread-2" } } });
      return;
    }
    if (request.method === "turn/start") {
      write({ id: request.id, result: { turn: { id: "turn-2" } } });
      setTimeout(() => {
        write({
          method: "turn/completed",
          params: {
            turnId: "turn-2",
            turn: { id: "turn-2", status: "completed" },
          },
        });
      }, 0);
    }
  };

  const result = await appServer.runCodexTurn("say hi", makeOptions(), {
    onParsed: () => undefined,
    onRaw: () => undefined,
  });

  const frames = latestWrites().map((line) => JSON.parse(line));
  expect(result.exitCode).toBe(0);
  expect(frames.some((frame) => frame.method === "initialize")).toBe(true);
  expect(frames.some((frame) => frame.method === "thread/start")).toBe(true);
});

test("runCodexTurn parses successful deltas and completion", async () => {
  const appServer = await getModule();
  currentHandler = (request, write) => {
    if (request.method === "initialize") {
      write({ id: request.id, result: {} });
      return;
    }
    if (request.method === "thread/start") {
      write({ id: request.id, result: { thread: { id: "thread-1" } } });
      return;
    }
    if (request.method === "turn/start") {
      write({ id: request.id, result: { turn: { id: "turn-1" } } });
      setTimeout(() => {
        write({
          method: "item/agentMessage/delta",
          params: {
            turnId: "turn-1",
            delta: "hello",
          },
        });
        write({
          method: "item/completed",
          params: {
            item: { type: "agentMessage", content: [{ text: " there" }] },
          },
        });
        write({
          method: "turn/completed",
          params: {
            turnId: "turn-1",
            turn: { id: "turn-1", status: "completed" },
          },
        });
      }, 0);
    }
  };

  const parsedLines: string[] = [];
  const rawLines: string[] = [];
  const result = await appServer.runCodexTurn("say hi", makeOptions(), {
    onParsed: (text) => parsedLines.push(text),
    onRaw: (text) => rawLines.push(text),
  });

  expect(result.exitCode).toBe(0);
  expect(result.parsed).toContain("hello");
  expect(result.parsed).toContain("there");
  expect(parsedLines).toContain("hello");
  expect(parsedLines.some((line) => line.includes("there"))).toBe(true);
  expect(result.combined).toContain("item/agentMessage/delta");
  expect(rawLines.length).toBeGreaterThan(0);
  expect(rawLines.join(" ")).toContain("item/agentMessage/delta");
  expect(rawLines.join(" ")).toContain("turn/completed");
});

test("runCodexTurn ignores foreign subagent turn notifications", async () => {
  const appServer = await getModule();
  currentHandler = (request, write) => {
    if (request.method === "initialize") {
      write({ id: request.id, result: {} });
      return;
    }
    if (request.method === "thread/start") {
      write({ id: request.id, result: { thread: { id: "thread-1" } } });
      return;
    }
    if (request.method === "turn/start") {
      write({ id: request.id, result: { turn: { id: "turn-1" } } });
      setTimeout(() => {
        write({
          method: "error",
          params: {
            turnId: "sub-turn-1",
            error: { message: "subagent failed" },
          },
        });
        write({
          method: "turn/completed",
          params: {
            turnId: "sub-turn-1",
            turn: {
              id: "sub-turn-1",
              status: "failed",
              error: { message: "subagent turn failed" },
            },
          },
        });
        write({
          method: "item/agentMessage/delta",
          params: {
            turnId: "turn-1",
            delta: "parent turn finished",
          },
        });
        write({
          method: "turn/completed",
          params: {
            turnId: "turn-1",
            turn: { id: "turn-1", status: "completed" },
          },
        });
      }, 0);
    }
  };

  const result = await appServer.runCodexTurn("say hi", makeOptions(), {
    onParsed: () => undefined,
    onRaw: () => undefined,
  });

  expect(result.exitCode).toBe(0);
  expect(result.parsed).toContain("parent turn finished");
  expect(result.parsed).not.toContain("subagent failed");
});

test("runCodexTurn maps failed turns to non-zero exit", async () => {
  const appServer = await getModule();
  currentHandler = (request, write) => {
    if (request.method === "initialize") {
      write({ id: request.id, result: {} });
      return;
    }
    if (request.method === "thread/start") {
      write({ id: request.id, result: { thread: { id: "thread-1" } } });
      return;
    }
    if (request.method === "turn/start") {
      write({ id: request.id, result: { turn: { id: "turn-1" } } });
      setTimeout(() => {
        write({
          method: "turn/completed",
          params: {
            turnId: "turn-1",
            turn: {
              id: "turn-1",
              status: "failed",
              error: { message: "policy blocked" },
            },
          },
        });
      }, 0);
    }
  };

  const result = await appServer.runCodexTurn("say hi", makeOptions(), {
    onParsed: () => undefined,
    onRaw: () => undefined,
  });

  expect(result.exitCode).toBe(1);
  expect(result.parsed).toContain("policy blocked");
});

test("runCodexTurn maps root-level failed status to non-zero exit", async () => {
  const appServer = await getModule();
  currentHandler = (request, write) => {
    if (request.method === "initialize") {
      write({ id: request.id, result: {} });
      return;
    }
    if (request.method === "thread/start") {
      write({ id: request.id, result: { thread: { id: "thread-1" } } });
      return;
    }
    if (request.method === "turn/start") {
      write({ id: request.id, result: { turn: { id: "turn-1" } } });
      setTimeout(() => {
        write({
          method: "turn/completed",
          params: {
            turnId: "turn-1",
            status: "failed",
            error: { message: "root error" },
          },
        });
      }, 0);
    }
  };

  const result = await appServer.runCodexTurn("say hi", makeOptions(), {
    onParsed: () => undefined,
    onRaw: () => undefined,
  });

  expect(result.exitCode).toBe(1);
  expect(result.parsed).toContain("root error");
});

test("runCodexTurn accepts snake_case agent message item type", async () => {
  const appServer = await getModule();
  currentHandler = (request, write) => {
    if (request.method === "initialize") {
      write({ id: request.id, result: {} });
      return;
    }
    if (request.method === "thread/start") {
      write({ id: request.id, result: { thread: { id: "thread-1" } } });
      return;
    }
    if (request.method === "turn/start") {
      write({ id: request.id, result: { turn: { id: "turn-1" } } });
      setTimeout(() => {
        write({
          method: "item/completed",
          params: {
            item: {
              type: "agent_message",
              content: [{ text: "works with snake_case" }],
            },
          },
        });
        write({
          method: "turn/completed",
          params: {
            turnId: "turn-1",
            turn: { id: "turn-1", status: "completed" },
          },
        });
      }, 0);
    }
  };

  const result = await appServer.runCodexTurn("say hi", makeOptions(), {
    onParsed: () => undefined,
    onRaw: () => undefined,
  });

  expect(result.exitCode).toBe(0);
  expect(result.parsed).toContain("works with snake_case");
});

test("runCodexTurn responds to approval requests", async () => {
  const appServer = await getModule();
  currentHandler = (request, write) => {
    if (request.method === "initialize") {
      write({ id: request.id, result: {} });
      return;
    }
    if (request.method === "thread/start") {
      write({ id: request.id, result: { thread: { id: "thread-1" } } });
      return;
    }
    if (request.method === "turn/start") {
      write({ id: request.id, result: { turn: { id: "turn-1" } } });
      setTimeout(() => {
        write({
          id: 101,
          method: "item/commandExecution/requestApproval",
          params: {
            command: "rm -rf /",
          },
        });
        write({
          method: "turn/completed",
          params: {
            turnId: "turn-1",
            turn: { id: "turn-1", status: "completed" },
          },
        });
      }, 0);
    }
  };

  const result = await appServer.runCodexTurn(
    "dangerous command",
    makeOptions(),
    {
      onParsed: () => undefined,
      onRaw: () => undefined,
    }
  );

  const responses = latestWrites().map(
    (line) => JSON.parse(line) as RequestFrame
  );
  const accepted = responses.some(
    (entry) =>
      (typeof entry.id === "number" || typeof entry.id === "string") &&
      String(entry.id) === "101" &&
      (entry.result as Record<string, unknown>)?.decision === "accept"
  );
  expect(accepted).toBe(true);
  expect(result.exitCode).toBe(0);
});

test("runCodexTurn falls back to exec mode when thread/start is unsupported", async () => {
  const appServer = await getModule();
  currentHandler = (request, write) => {
    if (request.method === "initialize") {
      write({ id: request.id, result: {} });
      return;
    }
    if (request.method === "thread/start") {
      write({
        id: request.id,
        error: { message: "method not found: thread/start" },
      });
    }
  };

  await expect(
    appServer.runCodexTurn("say hi", makeOptions(), {
      onParsed: () => undefined,
      onRaw: () => undefined,
    })
  ).rejects.toBeInstanceOf(appServer.CodexAppServerFallbackError);
});

test("runCodexTurn falls back to exec mode when turn/start is unsupported", async () => {
  const appServer = await getModule();
  currentHandler = (request, write) => {
    if (request.method === "initialize") {
      write({ id: request.id, result: {} });
      return;
    }
    if (request.method === "thread/start") {
      write({ id: request.id, result: { thread: { id: "thread-1" } } });
      return;
    }
    if (request.method === "turn/start") {
      write({
        id: request.id,
        error: { message: "unsupported: turn/start" },
      });
    }
  };

  await expect(
    appServer.runCodexTurn("say hi", makeOptions(), {
      onParsed: () => undefined,
      onRaw: () => undefined,
    })
  ).rejects.toBeInstanceOf(appServer.CodexAppServerFallbackError);
});

test("interruptAppServer kills detached process group when pid is available", async () => {
  const appServer = await getModule();
  currentHandler = (request, write) => {
    if (request.method === "initialize") {
      write({ id: request.id, result: {} });
    }
  };

  const originalKill = process.kill;
  const killCalls: Array<{ pid: number; signal: NodeJS.Signals | number }> = [];
  const killSpy = ((
    pid: number,
    signal: NodeJS.Signals | number = "SIGTERM"
  ): boolean => {
    killCalls.push({ pid, signal });
    return true;
  }) as typeof process.kill;
  (process as { kill: typeof process.kill }).kill = killSpy;

  try {
    await appServer.startAppServer();
    const proc = latestProcess();
    expect(proc).toBeDefined();
    appServer.interruptAppServer("SIGTERM");
    expect(killCalls).toContainEqual({
      pid: -(proc?.pid ?? 0),
      signal: "SIGTERM",
    });
    expect(proc?.killSignals.length).toBe(0);
  } finally {
    process.kill = originalKill;
  }
});

test("persistent codex thread survives an unexpected app-server restart", async () => {
  const appServer = await getModule();
  let threadStarts = 0;
  const turnThreadIds: string[] = [];
  currentHandler = (request, write) => {
    if (request.method === "initialize") {
      write({ id: request.id, result: {} });
      return;
    }
    if (request.method === "thread/start") {
      threadStarts += 1;
      write({ id: request.id, result: { thread: { id: "thread-1" } } });
      return;
    }
    if (request.method === "turn/start") {
      turnThreadIds.push(
        String(
          (request.params as { threadId?: unknown } | undefined)?.threadId ?? ""
        )
      );
      write({ id: request.id, result: { turn: { id: "turn-1" } } });
      setTimeout(() => {
        const latest = processes.at(-1);
        latest?.close();
      }, 0);
    }
  };

  await appServer.startAppServer({ persistentThread: true });
  await expect(
    appServer.runCodexTurn("say hi", makeOptions(), {
      onParsed: () => undefined,
      onRaw: () => undefined,
    })
  ).rejects.toBeInstanceOf(appServer.CodexAppServerUnexpectedExitError);

  currentHandler = (request, write) => {
    if (request.method === "initialize") {
      write({ id: request.id, result: {} });
      return;
    }
    if (request.method === "thread/start") {
      throw new Error(
        "expected restart to reuse the existing persistent thread"
      );
    }
    if (request.method === "turn/start") {
      turnThreadIds.push(
        String(
          (request.params as { threadId?: unknown } | undefined)?.threadId ?? ""
        )
      );
      write({ id: request.id, result: { turn: { id: "turn-2" } } });
      setTimeout(() => {
        write({
          method: "turn/completed",
          params: {
            turnId: "turn-2",
            turn: { id: "turn-2", status: "completed" },
          },
        });
      }, 0);
    }
  };

  await appServer.startAppServer({ persistentThread: true });
  const result = await appServer.runCodexTurn("say hi", makeOptions(), {
    onParsed: () => undefined,
    onRaw: () => undefined,
  });
  expect(result.exitCode).toBe(0);
  expect(threadStarts).toBe(1);
  expect(turnThreadIds).toEqual(["thread-1", "thread-1"]);
  expect(appServer.getLastCodexThreadId()).toBe("thread-1");
});
