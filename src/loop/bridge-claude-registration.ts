import { buildClaudeChannelServerConfig } from "./bridge-config";

const CLAUDE_CHANNEL_SCOPE = "local";
const MCP_ALREADY_EXISTS_RE = /already exists/i;

interface BridgeCommandResult {
  exitCode?: number | null;
  stderr?: string | Uint8Array;
}

type BridgeCommand = (args: string[]) => BridgeCommandResult;

const stderrText = (value: BridgeCommandResult["stderr"]): string => {
  if (!value) {
    return "";
  }
  if (typeof value === "string") {
    return value.trim();
  }
  return new TextDecoder().decode(value).trim();
};

const logClaudeChannelServerRemovalFailure = (
  serverName: string,
  detail: string,
  log: (line: string) => void
): void => {
  log(
    `[loop] failed to remove Claude channel server "${serverName}": ${detail}`
  );
};

export const registerClaudeChannelServer = (
  launchArgv: string[],
  serverName: string,
  runDir: string,
  runCommand: BridgeCommand
): void => {
  const result = runCommand([
    "claude",
    "mcp",
    "add-json",
    "--scope",
    CLAUDE_CHANNEL_SCOPE,
    serverName,
    buildClaudeChannelServerConfig(launchArgv, runDir),
  ]);
  const stderr = stderrText(result.stderr);
  if (result.exitCode === 0 || MCP_ALREADY_EXISTS_RE.test(stderr)) {
    return;
  }
  const suffix = stderr ? `: ${stderr}` : ".";
  throw new Error(`[loop] failed to register Claude channel server${suffix}`);
};

export const removeClaudeChannelServer = (
  serverName: string,
  runCommand: BridgeCommand,
  log: (line: string) => void = console.error
): void => {
  if (!serverName) {
    return;
  }
  try {
    const result = runCommand([
      "claude",
      "mcp",
      "remove",
      "--scope",
      CLAUDE_CHANNEL_SCOPE,
      serverName,
    ]);
    if (result.exitCode === 0) {
      return;
    }
    logClaudeChannelServerRemovalFailure(
      serverName,
      stderrText(result.stderr) || `exit code ${result.exitCode ?? "unknown"}`,
      log
    );
  } catch (error: unknown) {
    logClaudeChannelServerRemovalFailure(
      serverName,
      error instanceof Error ? error.message : String(error),
      log
    );
  }
};
