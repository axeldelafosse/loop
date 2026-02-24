import { expect, test } from "bun:test";
import { createCodexRenderer } from "../../src/loop/codex-render";

const makeRenderer = (format: "pretty" | "raw" = "pretty") => {
  const writes: string[] = [];
  const renderer = createCodexRenderer({
    format,
    write: (text) => {
      writes.push(text);
    },
  });
  return { renderer, writes };
};

test("completed message concatenates content parts without inserting newlines", () => {
  const { renderer, writes } = makeRenderer();
  renderer.onRawLine(
    JSON.stringify({
      method: "item/completed",
      params: {
        item: {
          type: "agentMessage",
          content: [{ text: "Hello " }, { text: "world" }],
        },
      },
    })
  );

  expect(renderer.getParsed()).toBe("Hello world");
  expect(writes.join("")).toBe("Hello world");
});

test("delta extraction prioritizes delta over text", () => {
  const { renderer } = makeRenderer();
  renderer.onRawLine(
    JSON.stringify({
      method: "item/agentMessage/delta",
      params: {
        delta: {
          delta: "delta-first",
          text: "text-fallback",
        },
      },
    })
  );

  expect(renderer.getParsed()).toBe("delta-first");
});

test("completed extraction prioritizes text over delta", () => {
  const { renderer } = makeRenderer();
  renderer.onRawLine(
    JSON.stringify({
      method: "item/completed",
      params: {
        item: {
          delta: "delta-fallback",
          text: "text-first",
          type: "agentMessage",
        },
      },
    })
  );

  expect(renderer.getParsed()).toBe("text-first");
});

test("completed whitespace-only content is ignored", () => {
  const { renderer, writes } = makeRenderer();
  renderer.onRawLine(
    JSON.stringify({
      method: "item/completed",
      params: {
        item: {
          type: "agentMessage",
          content: [{ text: "   " }, { text: "" }],
        },
      },
    })
  );

  expect(renderer.getParsed()).toBe("");
  expect(writes).toEqual([]);
});

test("raw mode writes each incoming line with a trailing newline", () => {
  const { renderer, writes } = makeRenderer("raw");
  renderer.onRawLine('{"method":"ping"}');

  expect(writes).toEqual(['{"method":"ping"}\n']);
});
