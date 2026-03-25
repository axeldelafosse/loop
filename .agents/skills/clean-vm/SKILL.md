---
name: clean-vm
description: Safely clean a local development VM when repeated loop, Claude, or Codex runs leave behind stale tmux sessions, orphaned agent processes, inactive Next.js or Storybook servers, closed-browser clutter, or unused git worktrees. Use this skill for machine cleanup, port/process triage, and reclaiming loop-created worktrees without disrupting active work.
---

# Clean VM

Use this skill when the machine has stale local dev state and you need a careful cleanup pass.
Prefer proving an item is inactive over killing it by name.

## Safety Rules

- Start with detection. Do not kill or remove anything until you can explain why it is stale.
- Treat loop manifests in `~/.loop/runs/*/*/manifest.json` as the source of truth for paired runs.
- A loop run is active when its manifest state is `submitted`, `working`, `reviewing`, or `input-required` and either its `pid` is alive or its `tmuxSession` still exists.
- Never kill or remove anything tied to an attached tmux session.
- Never remove the current repo checkout or the worktree containing `pwd`.
- Never delete a dirty worktree automatically. Report it and leave it alone unless the user explicitly asks to discard changes.
- Avoid broad `pkill` patterns. Prefer per-PID `kill -TERM` after inspection.
- Browser closure is destructive. Only do it when the user explicitly wants browser cleanup as part of the VM reset.

## Workflow

### 1. Snapshot loop state

Collect the current state first.

```bash
tmux ls 2>/dev/null
tmux list-panes -a -F '#{session_name} #{pane_dead} #{pane_current_command} #{pane_current_path}' 2>/dev/null
find ~/.loop/runs -maxdepth 5 -name manifest.json 2>/dev/null
git worktree list --porcelain
```

For loop manifests, inspect `cwd`, `pid`, `state`, `updatedAt`, and `tmuxSession`.
Useful states from loop are:

- active: `submitted`, `working`, `reviewing`, `input-required`
- inactive: `completed`, `failed`, `stopped`

If a manifest claims to be active but both the `pid` and `tmuxSession` are gone, treat it as stale.
If a manifest still looks active but `updatedAt` is very old, treat it as suspicious and report it before killing anything that still has a live PID.

### 2. Classify Claude and Codex processes

Prefer loop-aware checks before process-name matching.

For each manifest candidate:

1. Check whether the `pid` is still alive.
2. Check whether the `tmuxSession` still exists with `tmux has-session -t <name>`.
3. If both are gone, the run is stale.

For non-loop Claude or Codex processes, only kill them if you can prove they are orphaned or tied to stale loop state.
Inspect first:

```bash
pgrep -af '(^|/)(claude|codex)( |$)'
ps -o pid=,ppid=,etime=,tty=,command= -p <pid>
lsof -a -d cwd -p <pid>
```

Safer rule:

- kill only when the process is detached from a live tmux session, not tied to an active manifest, and clearly belongs to stale local work
- otherwise report it and leave it running

When killing, use:

```bash
kill -TERM <pid>
sleep 2
kill -0 <pid> 2>/dev/null && kill -KILL <pid>
```

### 3. Clean inactive Next.js and Storybook servers

Only target dev servers that are not part of active work.
Inspect listening processes and map them back to a cwd before killing them.

```bash
lsof -nP -iTCP -sTCP:LISTEN | grep -E 'node|next|storybook'
pgrep -af 'next dev|next-server|storybook|start-storybook'
lsof -a -d cwd -p <pid>
tmux list-panes -a -F '#{session_name} #{pane_dead} #{pane_current_command} #{pane_current_path}' 2>/dev/null
```

Good cleanup candidates:

- server process cwd belongs to a loop worktree whose tmux session is gone
- server process cwd is not open in any live tmux pane
- server process cwd belongs to a repo/worktree with no active manifest
- long-lived local dev server with no attached tmux and no recent interactive owner

Do not kill a server just because its command contains `node`.

### 4. Close browser windows only on explicit cleanup requests

This is macOS-only and destructive. Skip it on non-macOS hosts or if the user did not ask for browser cleanup.

Use AppleScript and report failures instead of retrying aggressively:

```bash
osascript -e 'tell application "System Events" to if exists process "Google Chrome" then tell application "Google Chrome" to close every window'
osascript -e 'tell application "System Events" to if exists process "Safari" then tell application "Safari" to close every window'
```

If automation permissions block the command, report that and continue.

### 5. Remove unused worktrees carefully

Use `git worktree list --porcelain` to classify worktrees.

Safe removals:

- entries already marked `prunable`
- missing loop-created worktrees after `git worktree prune`
- clean loop-created worktrees whose matching run is stale, whose tmux session is gone, and whose path is not open in a live tmux pane

Inspect before removing:

```bash
git worktree list --porcelain
git -C <path> status --short
tmux list-panes -a -F '#{session_name} #{pane_dead} #{pane_current_path}' 2>/dev/null
```

Rules:

- never remove the main worktree
- never remove the worktree that contains the current shell cwd
- never remove a worktree referenced by an active manifest `cwd`
- if the worktree is dirty, report it and skip it

Cleanup commands:

```bash
git worktree prune
git worktree remove <path>
git worktree remove --force <path>
```

Use `--force` only after a plain `git worktree remove <path>` fails because the worktree is locked or still registered elsewhere. A dirty `git status --short` result still means `skip`, even if `--force` would succeed.

## Report

End with a short cleanup report that includes:

- processes killed, with PID and reason
- dev servers stopped, with cwd and reason
- browser actions taken or skipped
- worktrees pruned or removed
- anything suspicious you left alone because it was active, dirty, or ambiguous

If any item is ambiguous, prefer `skipped` over `cleaned`.
