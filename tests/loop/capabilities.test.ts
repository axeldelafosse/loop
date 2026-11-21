import { expect, test } from "bun:test";
import {
  CAPABILITIES_FLAG,
  HOST_MANAGED_STARTUP_CAPABILITY,
  LOOP_CAPABILITIES,
  renderCapabilities,
} from "../../src/loop/capabilities";

test("host-managed-startup capability is an exact machine-readable token", () => {
  expect(HOST_MANAGED_STARTUP_CAPABILITY).toBe("host-managed-startup=1");
  expect(LOOP_CAPABILITIES).toContain(HOST_MANAGED_STARTUP_CAPABILITY);
  expect(CAPABILITIES_FLAG).toBe("--capabilities");
});

const CAPABILITY_TOKEN_RE = /^[a-z0-9-]+=[A-Za-z0-9.]+$/;

test("renderCapabilities prints one exact token per line", () => {
  const lines = renderCapabilities().split("\n");
  expect(lines).toContain("host-managed-startup=1");
  for (const line of lines) {
    expect(line).toMatch(CAPABILITY_TOKEN_RE);
  }
});
