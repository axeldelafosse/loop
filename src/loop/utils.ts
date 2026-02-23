import { existsSync, statSync } from "node:fs";
import { file } from "bun";
import { NEWLINE_RE } from "./constants";

export const isFile = (path: string): boolean =>
  existsSync(path) && statSync(path).isFile();

export const hasSignal = (text: string, signal: string): boolean =>
  text
    .split(NEWLINE_RE)
    .map((line) => line.trim())
    .some(
      (line) =>
        line === signal ||
        line === `"${signal}"` ||
        line.includes(`"${signal}"`)
    );

export const readPrompt = async (input: string): Promise<string> => {
  if (!isFile(input)) {
    return input;
  }
  return await file(input).text();
};
