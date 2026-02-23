import { existsSync, statSync } from "node:fs";
import { file } from "bun";
import { NEWLINE_RE } from "./constants";

type ReviewDecisionLike =
  | {
      approved?: boolean;
      consensusFail?: boolean;
      notes?: unknown;
    }
  | Record<string, unknown>;

const APPROVED_STATUSES = new Set([
  "approved",
  "pass",
  "passed",
  "yes",
  "ok",
  "success",
]);
const REQUEST_CHANGES_STATUSES = new Set([
  "requestchanges",
  "changesrequested",
  "changes_requested",
  "request_changes",
  "fail",
  "failed",
  "rejected",
  "blocked",
]);

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseStatusValue = (value: unknown): boolean | undefined => {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return value !== 0;
  }
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim().toLowerCase().replace(/["']/g, "");
  const compact = normalized.replace(/[^a-z_]/g, "");

  if (APPROVED_STATUSES.has(compact)) {
    return true;
  }
  if (
    compact === "reviewpassreview" ||
    compact.endsWith("reviewpass") ||
    compact.startsWith("pass")
  ) {
    return true;
  }
  if (REQUEST_CHANGES_STATUSES.has(compact)) {
    return false;
  }
  if (
    compact === "reviewfailreview" ||
    compact.endsWith("reviewfail") ||
    compact.startsWith("fail") ||
    compact.includes("changesrequested")
  ) {
    return false;
  }
  return undefined;
};

const parseStatusFromRecord = (
  value: Record<string, unknown>
): boolean | undefined => {
  const status = value.status ?? value.state ?? value.result;
  const direct = isObject(status)
    ? parseStatusFromRecord(status)
    : parseStatusValue(status);
  if (direct !== undefined) {
    return direct;
  }
  if (value.review !== undefined && isObject(value.review)) {
    return parseStatusFromRecord(value.review);
  }
  if (value.outcome !== undefined) {
    return parseStatusValue(value.outcome);
  }
  return undefined;
};

export interface ReviewDecision {
  approved: boolean;
  consensusFail: boolean;
  notes: string;
}

export const normalizeReviewDecision = (value: unknown): ReviewDecision => {
  if (!isObject(value)) {
    return { approved: false, consensusFail: false, notes: "" };
  }

  const candidate = value as ReviewDecisionLike;
  const approved =
    typeof candidate.approved === "boolean"
      ? candidate.approved
      : parseStatusFromRecord(value);

  let notesValue: unknown;
  if (isObject(value) && typeof value.notes === "string") {
    notesValue = value.notes;
  } else if (isObject(value) && typeof value.note === "string") {
    notesValue = value.note;
  } else if (isObject(value) && typeof value.message === "string") {
    notesValue = value.message;
  } else {
    notesValue = undefined;
  }

  const notes = typeof notesValue === "string" ? notesValue : "";

  return {
    approved: approved ?? false,
    consensusFail: candidate.consensusFail === true,
    notes,
  };
};

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
