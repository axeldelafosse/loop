import {
  access,
  chmod,
  copyFile,
  mkdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const BIN_DIR = join(homedir(), ".local", "bin");
const IS_WINDOWS = process.platform === "win32";
const LOOP_BINARY_NAME = IS_WINDOWS ? "loop.exe" : "loop";
const CLAUDE_ALIAS_NAME = IS_WINDOWS ? "claude-loop.cmd" : "claude-loop";
const CODEX_ALIAS_NAME = IS_WINDOWS ? "codex-loop.cmd" : "codex-loop";
const CANDIDATE_BINARIES = IS_WINDOWS
  ? ["loop.exe", "loop"]
  : ["loop", "loop.exe"];

const findBuiltBinary = async (): Promise<string> => {
  for (const name of CANDIDATE_BINARIES) {
    const candidate = resolve(process.cwd(), name);
    try {
      await access(candidate);
      return candidate;
    } catch {
      // try next candidate
    }
  }
  throw new Error("Built binary not found. Run `bun run build` first.");
};

const installUnixAlias = async (
  name: string,
  onlyFlag: string
): Promise<void> => {
  const target = join(BIN_DIR, name);
  const content =
    "#!/bin/sh\n" +
    `exec "$(dirname "$0")/${LOOP_BINARY_NAME}" ${onlyFlag} "$@"\n`;
  await rm(target, { force: true });
  await writeFile(target, content, "utf8");
  await chmod(target, 0o755);
  console.log(`Installed ${name} -> ${target}`);
};

const installWindowsAlias = async (
  name: string,
  onlyFlag: string
): Promise<void> => {
  const target = join(BIN_DIR, name);
  const content = `@echo off\r\n"%~dp0${LOOP_BINARY_NAME}" ${onlyFlag} %*\r\n`;
  await rm(target, { force: true });
  await writeFile(target, content, "utf8");
  console.log(`Installed ${name} -> ${target}`);
};

const installAliases = async (): Promise<void> => {
  if (IS_WINDOWS) {
    await installWindowsAlias(CLAUDE_ALIAS_NAME, "--claude-only");
    await installWindowsAlias(CODEX_ALIAS_NAME, "--codex-only");
    return;
  }
  await installUnixAlias(CLAUDE_ALIAS_NAME, "--claude-only");
  await installUnixAlias(CODEX_ALIAS_NAME, "--codex-only");
};

const installBinary = async (): Promise<void> => {
  const source = await findBuiltBinary();
  const target = join(BIN_DIR, LOOP_BINARY_NAME);

  await mkdir(BIN_DIR, { recursive: true });
  await rm(target, { force: true });

  if (IS_WINDOWS) {
    await copyFile(source, target);
    console.log(`Installed loop -> ${target}`);
    await installAliases();
    return;
  }

  try {
    await symlink(source, target);
  } catch {
    await copyFile(source, target);
  }

  console.log(`Installed loop -> ${target}`);
  await installAliases();
};

installBinary().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[loop] install failed: ${message}`);
  process.exit(1);
});
