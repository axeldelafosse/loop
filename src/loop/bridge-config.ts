import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { BRIDGE_SERVER, BRIDGE_SUBCOMMAND } from "./bridge-constants";
import { sanitizeBase } from "./git";
import { buildLaunchArgv } from "./launch";
import type { Agent } from "./types";

const CODEX_AUTO_APPROVED_BRIDGE_TOOLS = [
  "send_message",
  "bridge_status",
  "receive_messages",
] as const;
const CODEX_BRIDGE_APPROVAL_MODE = "approve";
const REPO_ID_HASH_SUFFIX_RE = /-[0-9a-f]{12}$/;

const ensureParentDir = (path: string): void => {
  mkdirSync(dirname(path), { recursive: true });
};

const stringifyToml = (value: string): string => JSON.stringify(value);

interface BridgeServerConfig {
  args: string[];
  command: string;
  type: "stdio";
}

const buildBridgeServerConfig = (
  runDir: string,
  source: Agent,
  launchArgv: string[]
): BridgeServerConfig => {
  const [command, ...baseArgs] = launchArgv;
  return {
    args: [...baseArgs, BRIDGE_SUBCOMMAND, runDir, source],
    command,
    type: "stdio",
  };
};

const buildBridgeFileConfig = (
  serverName: string,
  config: BridgeServerConfig
): { mcpServers: Record<string, BridgeServerConfig> } => ({
  mcpServers: {
    [serverName]: config,
  },
});

export const legacyClaudeChannelServerName = (runId: string): string =>
  `${BRIDGE_SERVER}-${sanitizeBase(runId)}`;

const readableRepoSegment = (repoId?: string): string | undefined => {
  const value = repoId?.trim();
  if (!value) {
    return undefined;
  }
  return sanitizeBase(value.replace(REPO_ID_HASH_SUFFIX_RE, ""));
};

export const legacyRepoScopedClaudeChannelServerName = (
  runId: string,
  repoId: string
): string => `${BRIDGE_SERVER}-${sanitizeBase(repoId)}-${sanitizeBase(runId)}`;

export const claudeChannelServerName = (
  runId: string,
  repoId?: string
): string => {
  const repoSegment = readableRepoSegment(repoId);
  return repoSegment
    ? `${BRIDGE_SERVER}-${repoSegment}-${sanitizeBase(runId)}`
    : legacyClaudeChannelServerName(runId);
};

export const generatedClaudeChannelServerNames = (
  runId: string,
  repoId?: string
): string[] => {
  const names = [legacyClaudeChannelServerName(runId)];
  if (!repoId?.trim()) {
    return names;
  }
  return Array.from(
    new Set([
      claudeChannelServerName(runId, repoId),
      legacyRepoScopedClaudeChannelServerName(runId, repoId),
      ...names,
    ])
  );
};

export const resolveClaudeChannelServerName = (
  runId: string,
  repoId: string | undefined,
  storedName?: string
): string => {
  const nextServer = claudeChannelServerName(runId, repoId);
  if (!storedName?.trim()) {
    return nextServer;
  }
  return generatedClaudeChannelServerNames(runId, repoId).includes(storedName)
    ? nextServer
    : storedName;
};

export const buildClaudeChannelServerConfig = (
  launchArgv: string[],
  runDir: string
): string =>
  JSON.stringify(buildBridgeServerConfig(runDir, "claude", launchArgv));

export const buildCodexBridgeConfigArgs = (
  runDir: string,
  source: Agent
): string[] => {
  const config = buildBridgeServerConfig(runDir, source, buildLaunchArgv());
  const approvalArgs = CODEX_AUTO_APPROVED_BRIDGE_TOOLS.flatMap((tool) => [
    "-c",
    `mcp_servers.${BRIDGE_SERVER}.tools.${tool}.approval_mode=${stringifyToml(
      CODEX_BRIDGE_APPROVAL_MODE
    )}`,
  ]);
  return [
    "-c",
    `mcp_servers.${BRIDGE_SERVER}.command=${stringifyToml(config.command)}`,
    "-c",
    `mcp_servers.${BRIDGE_SERVER}.args=${JSON.stringify(config.args)}`,
    ...approvalArgs,
  ];
};

export const ensureClaudeBridgeConfig = (
  runDir: string,
  source: Agent,
  serverName = BRIDGE_SERVER
): string => {
  const path = join(runDir, `${source}-mcp.json`);
  ensureParentDir(path);
  writeFileSync(
    path,
    `${JSON.stringify(
      buildBridgeFileConfig(
        serverName,
        buildBridgeServerConfig(runDir, source, buildLaunchArgv())
      ),
      null,
      2
    )}\n`,
    "utf8"
  );
  return path;
};
