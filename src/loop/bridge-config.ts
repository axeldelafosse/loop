import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { BRIDGE_SERVER, BRIDGE_SUBCOMMAND } from "./bridge-constants";
import { buildLaunchArgv } from "./launch";
import type { Agent } from "./types";

const ensureParentDir = (path: string): void => {
  mkdirSync(dirname(path), { recursive: true });
};

const stringifyToml = (value: string): string => JSON.stringify(value);

export const buildCodexBridgeConfigArgs = (
  runDir: string,
  source: Agent
): string[] => {
  const [command, ...baseArgs] = buildLaunchArgv();
  const args = [...baseArgs, BRIDGE_SUBCOMMAND, runDir, source];
  return [
    "-c",
    `mcp_servers.${BRIDGE_SERVER}.command=${stringifyToml(command)}`,
    "-c",
    `mcp_servers.${BRIDGE_SERVER}.args=${JSON.stringify(args)}`,
  ];
};

export const ensureClaudeBridgeConfig = (
  runDir: string,
  source: Agent
): string => {
  const [command, ...baseArgs] = buildLaunchArgv();
  const path = join(runDir, `${source}-mcp.json`);
  ensureParentDir(path);
  writeFileSync(
    path,
    `${JSON.stringify(
      {
        mcpServers: {
          [BRIDGE_SERVER]: {
            args: [...baseArgs, BRIDGE_SUBCOMMAND, runDir, source],
            command,
            type: "stdio",
          },
        },
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  return path;
};
