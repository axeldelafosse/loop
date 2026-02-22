# loop

Dead simple Bun CLI that runs `codex` and `claude` in a loop. The [main loop](https://github.com/axeldelafosse/loop/blob/main/src/loop/main.ts#L14) is ~50 lines of easy-to-read code.

## What this is

This _is_ a "meta agent loop" to help coding agents become long-running agents. Stop baby sitting your agents: let them iterate on tasks with clear proof requirements until they are done. Run multiple reviews to continue the feedback loop.

This _is not_ an "agent harness" and the goal isn't to re-invent the wheel: `loop` leverages existing agent harnesses like `codex` and `claude`, with their own implementation of the "agent teams" orchestration. The models are getting better very quickly and they are highly optimized for their respective harnesses.

## What it does

- Runs `codex` or `claude` with a PLAN.md and a proof
- Loops until agent proved that the tasks were completed successfully
- Runs a review pass with both `codex` and `claude` before exiting
- Addresses the comments automatically
- Creates a draft PR

## Setup

**IMPORTANT**: you SHOULD run this inside a VM. It is NOT safe to run this on your host machine. The agents are running in YOLO mode!

- Use Docker or [Lume](https://cua.ai/docs/lume/guide/getting-started/introduction) to create a sandbox VM
- Install nvm, node, npm and bun
- If you plan to use Playwright: `bun x playwright install chromium`
- Install [Codex](https://github.com/openai/codex) and [Claude](https://code.claude.com/docs/en/overview#get-started)
- Install Claude "Agent teams" and Codex "Multi-agents" experimental features
- Install git and gh CLI
- Create a GitHub fine-grained personal access token
- Once you are done, take a snapshot of your "golden image" (e.g. `lume clone`)
- Now you can even set up Tailscale to SSH remotely to your sandbox

## Requirements

- `codex` and/or `claude` installed and logged in
- [Bun](https://bun.com) to build/run from source. Prebuilt binaries do not require Bun.

## Install prebuilt binary

```bash
curl -fsSL https://raw.githubusercontent.com/axeldelafosse/loop/main/install.sh | bash
```

Installer currently supports macOS and Linux and installs to `~/.local/bin/loop` by default.

## Quick start

```bash
# run from source
./loop.ts --prompt "Implement feature X" --proof "Use X skill to verify your changes"

# open live panel of running claude/codex instances
./loop.ts

# build executable
bun run build
./loop --prompt "Implement feature X" --proof "Use X skill to verify your changes"

# same live panel behavior on built binary
./loop
```

Some notes:

- You can pass prompt text positionally (`loop "Implement feature X"`) or via `--prompt`.
- `--proof` is required and should describe how to prove the task works (tests, commands, and checks to run). You should be super specific based on the prompt.
- If the input is plain text (not a `.md` path), `loop` first runs a planning step to create `PLAN.md`, then uses `PLAN.md` for the main loop.
- Running with no args opens the live panel. To run the loop with `PLAN.md`, pass at least `--proof`.
- If no prompt is provided and options are present, `loop` will use `PLAN.md` if it exists.

## Install globally (symlink)

```bash
bun run install:global
loop --help
```

This creates `~/.local/bin/loop` on Unix and `~/.local/bin/loop.exe` on Windows.

If `loop` is not found, add this to `~/.zshrc`:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

Then reload your shell:

```bash
source ~/.zshrc
```

## CI/CD

- CI runs on every push and pull request (`.github/workflows/ci.yml`)
- Releases run on every push to `main` (`.github/workflows/release.yml`)
- Release artifacts include compiled binaries for Linux, macOS (x64 + arm64), and Windows
- Release version comes from `package.json` (`v${version}`)
- If that tag already exists, release is skipped automatically

Example release:

```bash
# bump version
npm version patch

# push commit + tag created by npm version
git push origin main
git push --tags
```

## Auto-update

Prebuilt binaries check for updates automatically on startup and download new versions in the background. The update is applied on the next startup.

```bash
# manually check for updates
loop update

# same thing (alias)
loop upgrade
```

When running from source (`bun src/loop.ts`), auto-update is disabled — use `git pull` instead.

## Options

- `-a, --agent <claude|codex>`: agent to run (default: `codex`)
- `-p, --prompt <text|.md file>`: prompt text or a `.md` prompt file path. Plain text auto-creates `PLAN.md` first.
- `--proof <text>`: required proof criteria for task completion
- `-m, --max-iterations <number>`: max loop count (default: infinite)
- `-d, --done <signal>`: done signal string (default: `<promise>DONE</promise>`)
- `--format <pretty|raw>`: output format (default: `pretty`)
- `--review [claude|codex|claudex]`: run a review when done (default: `claudex`; bare `--review` also uses `claudex`). With `claudex`, both reviews run in parallel, then both comments are passed back to the original agent so it can decide what to address. If both reviews found the same issue, that is a stronger signal to fix it.
- `--tmux`: run `loop` in a detached tmux session so it survives SSH disconnects (auto-attaches when interactive). Session name format: `repo-loop-X`
- `--worktree`: create and run inside a fresh git worktree + branch automatically. Worktree/branch format: `repo-loop-X`
- `-h, --help`: help

## Examples

```bash
# use PLAN.md automatically
./loop --proof "Use X skill to verify your changes"

# two iteration, raw JSON/event output
./loop -m 2 --proof "Use X skill to verify your changes" "Implement feature X" --format raw

# plain text prompt: auto-creates PLAN.md, then runs from PLAN.md
./loop --proof "Use X skill to verify your changes" "Implement feature X"

# run with claude
./loop --proof "Use X skill to verify your changes" --agent claude --prompt PLAN.md

# run review with a single reviewer
./loop --proof "Use X skill to verify your changes" "Implement feature X" --review codex

# run claudex reviewers when done (default behavior)
./loop --proof "Use X skill to verify your changes" "Implement feature X" --review claudex

# run in detached tmux session (good for SSH)
./loop --tmux --proof "Use X skill to verify your changes" "Implement feature X"

# run in a fresh git worktree automatically
./loop --worktree --proof "Use X skill to verify your changes" "Implement feature X"

# run in detached tmux session in a fresh git worktree automatically
./loop --tmux --worktree --proof "Use X skill to verify your changes" "Implement feature X"
```

## License

[MIT](LICENSE.md)
