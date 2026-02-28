import { existsSync, statSync } from "node:fs";
import { file } from "bun";
import { NEWLINE_RE } from "./constants";

export const isFile = (path: string): boolean =>
  existsSync(path) && statSync(path).isFile();

export const hasSignal = (text: string, signal: string): boolean => {
  const quoted = `"${signal}"`;
  return text.split(NEWLINE_RE).some((raw) => {
    const line = raw.trim();
    return line === signal || line === quoted || line.includes(quoted);
  });
};

export const readPrompt = async (input: string): Promise<string> => {
  if (!isFile(input)) {
    return input;
  }
  return await file(input).text();
};
