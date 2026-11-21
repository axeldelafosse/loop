// Machine-readable capability tokens a host integration can rely on. Printed by
// `loop --capabilities`, one exact token per line. The host MUST match an exact token
// fail-closed (never a version substring) before depending on the feature.
export const CAPABILITIES_FLAG = "--capabilities";

// Opt-in host-managed startup: the host sets LOOP_HOST_MANAGED_STARTUP=1 and loop then skips
// automatic consent keystrokes, initializes pane retention/capture at creation, and holds each
// fresh agent on a host-created task barrier until the host verifies the launch (see tmux.ts).
export const HOST_MANAGED_STARTUP_CAPABILITY = "host-managed-startup=1";

export const LOOP_CAPABILITIES: readonly string[] = [
  HOST_MANAGED_STARTUP_CAPABILITY,
];

export const renderCapabilities = (): string => LOOP_CAPABILITIES.join("\n");
