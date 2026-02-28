Please keep the code dead-simple and keep the `src/loop/main.ts` file under 150 lines of code.

# Quick Commands

- Format code: `bun run fix`
- Check lint/types/style: `bun run check`
- Build executable: `bun run build`

# Coding Standards

- Keep functions small and easy to read.
- Use explicit parameter/return types when they improve clarity.
- Prefer `unknown` over `any` for unknown values.
- Use `const` by default, `let` only when reassignment is needed.
- Prefer `for...of`, optional chaining, nullish coalescing, and template literals.
- Use early returns to reduce nesting.
- Use `async/await` instead of promise chains.
- Throw `Error` objects with clear messages.
- Extract magic numbers/strings into named constants when reused.

# CLI-Specific Notes

- `console.log`/`console.error` are valid for user-facing CLI output.
- Remove temporary debugging output before finalizing changes.
- Validate external input (CLI args, files, and subprocess output).

# Testing

- Keep assertions inside `test()`/`it()` blocks.
- Prefer async/await over done callbacks.
- Do not commit `.only` or `.skip`.
- Prefer module-level mocks (for example `mock.module(...)`) over adding DI-only test seams when possible.
- Keep tests in the top-level `tests/` directory (mirror `src/` structure); do not co-locate `*.test.ts` inside `src/`.

# Review Focus Beyond Biome

- Business logic correctness
- Edge cases and failure paths
- Clear naming and maintainable control flow
