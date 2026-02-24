import { expect, test } from "bun:test";
import { REVIEW_FAIL, REVIEW_PASS } from "../../src/loop/constants";
import {
  buildPlanPrompt,
  buildPlanReviewPrompt,
  buildReviewPrompt,
  buildWorkPrompt,
} from "../../src/loop/prompts";

test("buildPlanPrompt asks for PLAN.md", () => {
  const prompt = buildPlanPrompt("  ship feature  ");

  expect(prompt).toContain("Task:\nship feature");
  expect(prompt).toContain("Create or update PLAN.md");
  expect(prompt).toContain("Do not implement code yet.");
});

test("buildPlanReviewPrompt asks to review PLAN.md only", () => {
  const prompt = buildPlanReviewPrompt("  ship feature  ");

  expect(prompt).toContain("Task:\nship feature");
  expect(prompt).toContain("Review PLAN.md");
  expect(prompt).toContain("Update PLAN.md directly if needed.");
  expect(prompt).toContain("Only edit PLAN.md in this step.");
});

test("buildWorkPrompt keeps task, optional sections, and done instruction", () => {
  const prompt = buildWorkPrompt(
    "  ship feature  ",
    "<promise>DONE</promise>",
    "run tests",
    "address nits"
  );

  expect(prompt).toContain("ship feature");
  expect(prompt).toContain("Review feedback:\naddress nits");
  expect(prompt).toContain("Proof requirements:\nrun tests");
  expect(prompt).toContain(
    'append "<promise>DONE</promise>" on its own final line.'
  );
  expect(prompt).toContain("worktree isolation");
});

test("buildWorkPrompt does not duplicate proof when task already contains it", () => {
  const prompt = buildWorkPrompt("task\n\nrun tests", "<done/>", "run tests");

  expect(prompt).not.toContain("Proof requirements:");
});

test("buildWorkPrompt keeps proof when only a substring appears in task", () => {
  const prompt = buildWorkPrompt(
    "task\n\nwe should test more",
    "<done/>",
    "test"
  );
  expect(prompt).toContain("Proof requirements:\ntest");
});

test("buildReviewPrompt includes strict review signal instructions", () => {
  const prompt = buildReviewPrompt("  do task  ", "<done/>", "must pass ci");

  expect(prompt).toContain("Task:\ndo task");
  expect(prompt).toContain(
    `If review is needed, end your response with exactly "${REVIEW_FAIL}"`
  );
  expect(prompt).toContain(
    `If the work is complete, end with exactly "${REVIEW_PASS}"`
  );
  expect(prompt).toContain("final non-empty line");
  expect(prompt).toContain("Nothing may follow this line.");
  expect(prompt).toContain("No extra content after this line.");
  expect(prompt).toContain(`"${REVIEW_PASS}"`);
  expect(prompt).toContain(
    "concrete file paths, commands, and code locations that must change."
  );
  expect(prompt).toContain("Proof requirements:\nmust pass ci");
  expect(prompt).toContain("worktree isolation");
  expect(prompt).toContain("must not include");
  expect(prompt).toContain(
    "The final line must be one of the two review signals"
  );
});

test("buildReviewPrompt omits proof requirements when proof is empty", () => {
  const prompt = buildReviewPrompt("do task", "<done/>", "");

  expect(prompt).not.toContain("Proof requirements:");
});
