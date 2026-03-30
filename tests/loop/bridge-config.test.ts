import { expect, test } from "bun:test";
import {
  claudeChannelServerName,
  legacyClaudeChannelServerName,
} from "../../src/loop/bridge-config";

test("claudeChannelServerName drops the repo hash suffix from storage ids", () => {
  expect(claudeChannelServerName("55", "loop-0d5b6b77c881")).toBe(
    "loop-bridge-loop-55"
  );
});

test("claudeChannelServerName preserves readable repo ids", () => {
  expect(claudeChannelServerName("55", "repo-123")).toBe(
    "loop-bridge-repo-123-55"
  );
});

test("claudeChannelServerName falls back to the legacy run-scoped name", () => {
  expect(claudeChannelServerName("55")).toBe(
    legacyClaudeChannelServerName("55")
  );
});
