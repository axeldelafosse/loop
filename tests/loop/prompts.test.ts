import { expect, test } from "bun:test";
import { REVIEW_FAIL, REVIEW_PASS } from "../../src/loop/constants";
import {
  buildPlanPrompt,
  buildReviewPrompt,
  buildWorkPrompt,
} from "../../src/loop/prompts";

test("buildPlanPrompt asks for PLAN.md", () => {
  const prompt = buildPlanPrompt("  ship feature  ");

  expect(prompt).toContain("Task:\nship feature");
  expect(prompt).toContain("Create or update PLAN.md");
  expect(prompt).toContain("Do not implement code yet.");
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

test("buildReviewPrompt includes pass and fail instructions and verification", () => {
  const prompt = buildReviewPrompt("  do task  ", "<done/>", "must pass ci");

  expect(prompt).toContain("Task:\ndo task");
  expect(prompt).toContain(`end with "${REVIEW_FAIL}" on its own final line`);
  expect(prompt).toContain(`end with "${REVIEW_PASS}" on its own final line`);
  expect(prompt).toContain("Proof requirements:\nmust pass ci");
  expect(prompt).toContain("worktree isolation");
  expect(prompt).toContain('Do not use "<done/>" in your final line.');
});
