import { expect, test } from "bun:test";
import {
  buildLoopName,
  checkGitState,
  type GitResult,
} from "../../src/loop/git";

const ok = (stdout: string): GitResult => ({ exitCode: 0, stderr: "", stdout });
const fail = (): GitResult => ({ exitCode: 1, stderr: "", stdout: "" });

test("returns warning when on a non-main branch", () => {
  const result = checkGitState({
    runGit: (args) => {
      if (args[0] === "rev-parse") {
        return ok("feature-xyz");
      }
      throw new Error(`unexpected: ${args.join(" ")}`);
    },
  });
  expect(result).toBe('[loop] heads up: on branch "feature-xyz", not main');
});

test("returns warning when local main is behind remote", () => {
  const result = checkGitState({
    runGit: (args) => {
      if (args[0] === "rev-parse") {
        return ok("main");
      }
      if (args[0] === "rev-list") {
        return ok("3");
      }
      throw new Error(`unexpected: ${args.join(" ")}`);
    },
  });
  expect(result).toBe("[loop] heads up: local main is 3 commits behind remote");
});

test("returns warning when local master is behind remote", () => {
  const result = checkGitState({
    runGit: (args) => {
      if (args[0] === "rev-parse") {
        return ok("master");
      }
      if (args[0] === "rev-list") {
        return ok("1");
      }
      throw new Error(`unexpected: ${args.join(" ")}`);
    },
  });
  expect(result).toBe(
    "[loop] heads up: local master is 1 commit behind remote"
  );
});

test("returns undefined when on main and up to date", () => {
  const result = checkGitState({
    runGit: (args) => {
      if (args[0] === "rev-parse") {
        return ok("main");
      }
      if (args[0] === "rev-list") {
        return ok("0");
      }
      throw new Error(`unexpected: ${args.join(" ")}`);
    },
  });
  expect(result).toBeUndefined();
});

test("returns undefined when not in a git repo", () => {
  const result = checkGitState({ runGit: () => fail() });
  expect(result).toBeUndefined();
});

test("returns undefined when no upstream is configured", () => {
  const result = checkGitState({
    runGit: (args) => {
      if (args[0] === "rev-parse") {
        return ok("main");
      }
      if (args[0] === "rev-list") {
        return fail();
      }
      throw new Error(`unexpected: ${args.join(" ")}`);
    },
  });
  expect(result).toBeUndefined();
});

test("buildLoopName rejects unsafe run ids", () => {
  expect(() => buildLoopName("repo", "foo..bar")).toThrow("Invalid run id");
});

test("buildLoopName keeps safe run ids unchanged", () => {
  expect(buildLoopName("repo", "alpha-1")).toBe("repo-loop-alpha-1");
});
