import { expect, test } from "bun:test";
import { bridgeToolName } from "../../src/loop/bridge-guidance";

test("bridgeToolName namespaces Codex bridge tools only", () => {
  expect(bridgeToolName("codex", "send_message")).toBe(
    "mcp__loop_bridge__send_message"
  );
  expect(bridgeToolName("codex", "bridge_status")).toBe(
    "mcp__loop_bridge__bridge_status"
  );
  expect(bridgeToolName("claude", "send_message")).toBe("send_message");
});
