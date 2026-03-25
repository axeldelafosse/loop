---
name: clean-vm
description: "Safely clean the local loop VM by reporting and removing stale loop runs, inactive Next.js or Storybook servers, optional browser windows, and unused loop-created worktrees without disturbing active tmux-backed sessions."
---

# Clean VM

Use this skill when repeated loop, Claude, or Codex runs leave the machine in a bad state.
Start with the bundled script. It does a dry run by default and only mutates the machine with `--apply`.

## Default Workflow

1. Run a dry run first:

```bash
python3 .agents/skills/clean-vm/scripts/clean_vm.py
```

2. Review the report. The script only targets:

- loop manifests under `~/.loop/runs/<repoId>`
- loop helper processes tied to stale run dirs
- Next.js and Storybook servers running inside stale loop worktrees
- loop-created worktrees from `git worktree list --porcelain`

3. Apply the cleanup once the plan looks safe:

```bash
python3 .agents/skills/clean-vm/scripts/clean_vm.py --apply
```

4. Only close browser windows when the user explicitly wants browser cleanup:

```bash
python3 .agents/skills/clean-vm/scripts/clean_vm.py --apply --browsers
```

## Safety Rules

- Always inspect the dry run before using `--apply`.
- Treat loop manifests in `~/.loop/runs` as the source of truth for paired runs.
- Keep any run whose manifest state is `submitted`, `working`, `reviewing`, or `input-required` and whose `pid` or `tmuxSession` is still live.
- Never mass-kill `claude`, `codex`, or `node`. Kill only per PID after the script proves the process belongs to stale loop state.
- Never remove the main worktree, the worktree containing the current `pwd`, or a dirty worktree.
- The script does not auto-force worktree removal. If a plain `git worktree remove` fails, it reports the failure and leaves escalation to a manual follow-up.
- Treat any live tmux session as in use even if the manifest looks stale.
- Browser cleanup is opt-in and macOS-only.

## What the Script Checks

- repo identity via `git rev-parse --git-common-dir`, using the same repo id scheme as loop
- run manifests under `~/.loop/runs`
- tmux liveness with exact session targets like `tmux has-session -t =<name>` plus a live-pane check from `tmux list-panes`
- helper processes whose command line references a stale run dir
- dev servers matching `next dev`, `next-server`, `storybook`, or `start-storybook`
- worktrees from `git worktree list --porcelain`

## Manual Fallback

If the script cannot classify something safely, leave it alone and inspect it manually:

```bash
tmux ls 2>/dev/null
tmux list-panes -a -F '#{session_name} #{pane_dead} #{pane_current_command} #{pane_current_path}' 2>/dev/null
git worktree list --porcelain
lsof -nP -iTCP -sTCP:LISTEN | grep -E 'next|storybook|node'
ps -axo pid=,tty=,command= | grep -E 'claude|codex|next dev|storybook'
```

Useful loop states:

- active: `submitted`, `working`, `reviewing`, `input-required`
- inactive: `completed`, `failed`, `stopped`

If a manifest claims to be active but its `pid` is gone and its exact tmux session is missing or every pane in that exact session is dead, treat it as stale.

## Report

End with a short cleanup report that includes:

- processes killed, with PID and reason
- dev servers stopped, with cwd and reason
- browser actions taken or skipped
- worktrees pruned or removed
- anything suspicious you left alone because it was active, dirty, or ambiguous

If any item is ambiguous, prefer `skipped` over `cleaned`.
