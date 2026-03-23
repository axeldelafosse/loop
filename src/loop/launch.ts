import { basename, isAbsolute, resolve as resolvePath } from "node:path";

const isScriptPath = (path: string): boolean =>
  path.endsWith(".ts") ||
  path.endsWith(".tsx") ||
  path.endsWith(".js") ||
  path.endsWith(".mjs") ||
  path.endsWith(".cjs");

const isBunExecutable = (value: string): boolean => {
  const file = basename(value);
  return file === "bun" || file === "bun.exe";
};

export const buildLaunchArgv = (
  processArgv: string[] = process.argv,
  execPath: string = process.execPath
): string[] => {
  const scriptArg = processArgv[1];
  const commandPath = processArgv[0];
  if (
    !scriptArg ||
    scriptArg.startsWith("-") ||
    scriptArg.startsWith("/$bunfs/")
  ) {
    if (
      !(commandPath && isAbsolute(commandPath)) ||
      isBunExecutable(commandPath)
    ) {
      return [execPath];
    }
    return [commandPath];
  }
  const scriptPath = isAbsolute(scriptArg) ? scriptArg : resolvePath(scriptArg);
  if (isBunExecutable(execPath) || isScriptPath(scriptPath)) {
    return [execPath, scriptPath];
  }
  return commandPath ? [commandPath] : [execPath];
};

export const launchInternals = {
  buildLaunchArgv,
};
