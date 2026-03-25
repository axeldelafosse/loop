#!/usr/bin/env python3

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import signal
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

ACTIVE_STATES = {"submitted", "working", "reviewing", "input-required"}
AGENT_RE = re.compile(r"(^|/)(claude|codex)(\s|$)")
LOOP_HELPER_MARKERS = ("__bridge-mcp", "__codex-tmux-proxy")
SAFE_NAME_RE = re.compile(r"[^a-z0-9-]+")
SERVER_RE = re.compile(r"next dev|next-server|storybook|start-storybook")


class CleanVmError(Exception):
    pass


@dataclass
class RepoContext:
    repo_id: str
    repo_root: Path
    start_cwd: Path


@dataclass
class ProcessInfo:
    pid: int
    tty: str
    command: str


@dataclass
class RunInfo:
    cwd: Optional[Path]
    pid: Optional[int]
    pid_alive: bool
    run_dir: Path
    run_id: str
    state: str
    tmux_alive: bool
    tmux_session: str

    @property
    def active(self) -> bool:
        return self.state in ACTIVE_STATES and (self.pid_alive or self.tmux_alive)


@dataclass
class WorktreeInfo:
    path: Path
    prunable: bool
    run_id: Optional[str]


def run_command(
    args: list[str], cwd: Optional[Path] = None
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        args,
        capture_output=True,
        cwd=str(cwd) if cwd else None,
        text=True,
    )


def sanitize_base(value: str) -> str:
    cleaned = SAFE_NAME_RE.sub("-", value.lower()).strip("-")
    return cleaned or "loop"


def git_output(repo: Path, args: list[str]) -> str:
    result = run_command(["git", *args], cwd=repo)
    if result.returncode == 0:
        return result.stdout.strip()
    message = result.stderr.strip() or result.stdout.strip() or "git command failed"
    raise CleanVmError(message)


def resolve_repo(start: Path) -> RepoContext:
    repo_root = Path(
        git_output(start, ["rev-parse", "--path-format=absolute", "--show-toplevel"])
    ).resolve()
    common_dir = Path(
        git_output(start, ["rev-parse", "--path-format=absolute", "--git-common-dir"])
    ).resolve()
    label = common_dir.parent.name
    seed = str(common_dir)
    repo_id = f"{sanitize_base(label)}-{hashlib.sha256(seed.encode()).hexdigest()[:12]}"
    return RepoContext(
        repo_id=repo_id,
        repo_root=repo_root,
        start_cwd=start.resolve(),
    )


def pid_exists(pid: Optional[int]) -> bool:
    if not pid or pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    return True


def tmux_session_exists(session: str) -> bool:
    if not session:
        return False
    return run_command(["tmux", "has-session", "-t", session]).returncode == 0


def parse_int(value: object) -> Optional[int]:
    if isinstance(value, int):
        return value
    if isinstance(value, str) and value.isdigit():
        return int(value)
    return None


def parse_string(value: object) -> str:
    return value if isinstance(value, str) else ""


def normalize_run_state(state: str) -> str:
    if state in ACTIVE_STATES:
        return state
    if state in {"active", "running"}:
        return "working"
    if state == "done":
        return "completed"
    return state


def is_inside(root: Path, child: Optional[Path]) -> bool:
    if child is None:
        return False
    try:
        child.resolve().relative_to(root.resolve())
    except ValueError:
        return False
    return True


def paths_overlap(left: Optional[Path], right: Optional[Path]) -> bool:
    if left is None or right is None:
        return False
    return is_inside(left, right) or is_inside(right, left)


def ancestor_pids() -> set[int]:
    protected: set[int] = set()
    pid = os.getpid()
    while pid > 1 and pid not in protected:
        protected.add(pid)
        result = run_command(["ps", "-o", "ppid=", "-p", str(pid)])
        parent = result.stdout.strip()
        if not parent.isdigit():
            break
        next_pid = int(parent)
        if next_pid == pid:
            break
        pid = next_pid
    return protected


def process_cwd(pid: int) -> Optional[Path]:
    result = run_command(["lsof", "-a", "-d", "cwd", "-Fn", "-p", str(pid)])
    if result.returncode != 0:
        return None
    for line in result.stdout.splitlines():
        if line.startswith("n"):
            return Path(line[1:]).resolve()
    return None


def process_list() -> list[ProcessInfo]:
    result = run_command(["ps", "-axo", "pid=,tty=,command="])
    items: list[ProcessInfo] = []
    for line in result.stdout.splitlines():
        parts = line.strip().split(None, 2)
        if len(parts) != 3 or not parts[0].isdigit():
            continue
        items.append(ProcessInfo(pid=int(parts[0]), tty=parts[1], command=parts[2]))
    return items


def live_tmux_paths() -> list[Path]:
    result = run_command(
        ["tmux", "list-panes", "-a", "-F", "#{pane_dead} #{pane_current_path}"]
    )
    if result.returncode != 0:
        return []
    paths: list[Path] = []
    for line in result.stdout.splitlines():
        parts = line.strip().split(None, 1)
        if len(parts) != 2 or parts[0] != "0":
            continue
        paths.append(Path(parts[1]).resolve())
    return paths


def load_runs(context: RepoContext) -> tuple[list[RunInfo], list[str]]:
    repo_runs = Path.home() / ".loop" / "runs" / context.repo_id
    runs: list[RunInfo] = []
    warnings: list[str] = []
    if not repo_runs.exists():
        return runs, warnings
    for path in sorted(repo_runs.glob("*/manifest.json")):
        try:
            data = json.loads(path.read_text())
        except Exception as exc:
            warnings.append(f"skipped invalid manifest {path}: {exc}")
            continue
        cwd_value = parse_string(data.get("cwd"))
        tmux_session = parse_string(data.get("tmuxSession") or data.get("tmux_session"))
        pid = parse_int(data.get("pid"))
        runs.append(
            RunInfo(
                cwd=Path(cwd_value).resolve() if cwd_value else None,
                pid=pid,
                pid_alive=pid_exists(pid),
                run_dir=path.parent,
                run_id=parse_string(data.get("runId") or data.get("run_id")) or path.parent.name,
                state=normalize_run_state(
                    parse_string(data.get("state") or data.get("status")) or "unknown"
                ),
                tmux_alive=tmux_session_exists(tmux_session),
                tmux_session=tmux_session,
            )
        )
    return runs, warnings


def parse_worktree_run_id(path: Path) -> Optional[str]:
    if "-loop-" not in path.name:
        return None
    run_id = path.name.split("-loop-", 1)[1]
    return run_id or None


def load_worktrees(context: RepoContext) -> list[WorktreeInfo]:
    output = git_output(context.repo_root, ["worktree", "list", "--porcelain"])
    worktrees: list[WorktreeInfo] = []
    block: dict[str, str] = {}
    for line in [*output.splitlines(), ""]:
        if line:
            key, _, value = line.partition(" ")
            block[key] = value
            continue
        path_value = block.get("worktree")
        if path_value:
            path = Path(path_value).resolve()
            worktrees.append(
                WorktreeInfo(
                    path=path,
                    prunable="prunable" in block,
                    run_id=parse_worktree_run_id(path),
                )
            )
        block = {}
    return worktrees


def classify_worktrees(
    context: RepoContext, runs: list[RunInfo], tmux_paths: list[Path]
) -> tuple[list[tuple[WorktreeInfo, str]], list[str], bool]:
    active_run_ids = {run.run_id for run in runs if run.active}
    active_cwds = [run.cwd for run in runs if run.active and run.cwd]
    removable: list[tuple[WorktreeInfo, str]] = []
    notes: list[str] = []
    needs_prune = False
    for worktree in load_worktrees(context):
        if worktree.path == context.repo_root:
            notes.append(f"kept main worktree {worktree.path}")
            continue
        if is_inside(worktree.path, context.start_cwd):
            notes.append(f"kept current worktree {worktree.path}")
            continue
        if any(is_inside(worktree.path, cwd) for cwd in active_cwds):
            notes.append(f"kept active worktree {worktree.path}")
            continue
        if any(is_inside(worktree.path, path) for path in tmux_paths):
            notes.append(f"kept worktree open in tmux {worktree.path}")
            continue
        if tmux_session_exists(worktree.path.name):
            notes.append(f"kept tmux-backed worktree {worktree.path}")
            continue
        if worktree.prunable:
            needs_prune = True
            notes.append(f"prunable worktree {worktree.path}")
            continue
        if worktree.run_id is None:
            notes.append(f"skipped non-loop worktree {worktree.path}")
            continue
        if worktree.run_id in active_run_ids:
            notes.append(f"kept run-backed worktree {worktree.path}")
            continue
        status = run_command(["git", "-C", str(worktree.path), "status", "--porcelain"])
        if status.stdout.strip():
            notes.append(f"skipped dirty worktree {worktree.path}")
            continue
        removable.append((worktree, "loop worktree is stale and clean"))
    return removable, notes, needs_prune


def classify_run_processes(
    runs: list[RunInfo],
    protected: set[int],
    processes: list[ProcessInfo],
    tmux_paths: list[Path],
) -> tuple[list[tuple[int, str]], list[str]]:
    active_roots = [run.cwd for run in runs if run.active and run.cwd]
    kill: dict[int, str] = {}
    notes: list[str] = []
    for run in runs:
        if run.active:
            notes.append(f"kept active run {run.run_id}")
            continue
        if run.pid and run.pid not in protected and pid_exists(run.pid) and not run.tmux_alive:
            cwd = process_cwd(run.pid)
            if any(is_inside(root, cwd) for root in active_roots) or any(
                paths_overlap(cwd, path) for path in tmux_paths
            ):
                notes.append(f"left stale run pid {run.pid} alone because it is in active work")
            else:
                kill[run.pid] = f"stale loop run {run.run_id} ({run.state})"
        for process in processes:
            if process.pid in protected or process.pid == run.pid:
                continue
            if str(run.run_dir) not in process.command or run.tmux_alive:
                continue
            cwd = process_cwd(process.pid)
            if any(is_inside(root, cwd) for root in active_roots) or any(
                paths_overlap(cwd, path) for path in tmux_paths
            ):
                continue
            if cwd is None and not any(
                marker in process.command for marker in LOOP_HELPER_MARKERS
            ):
                notes.append(
                    f"left helper process {process.pid} alone because its cwd is unknown"
                )
                continue
            kill[process.pid] = f"helper for stale run {run.run_id}"
    return sorted(kill.items()), notes


def classify_agent_processes(
    runs: list[RunInfo], protected: set[int], processes: list[ProcessInfo]
) -> list[str]:
    active_roots = [run.cwd for run in runs if run.active and run.cwd]
    notes: list[str] = []
    for process in processes:
        if process.pid in protected or not AGENT_RE.search(process.command):
            continue
        cwd = process_cwd(process.pid)
        if any(is_inside(root, cwd) for root in active_roots):
            continue
        notes.append(f"left standalone agent process {process.pid} alone")
    return notes


def classify_servers(
    removable_worktrees: list[tuple[WorktreeInfo, str]],
    runs: list[RunInfo],
    protected: set[int],
    processes: list[ProcessInfo],
    tmux_paths: list[Path],
) -> tuple[list[tuple[int, str]], list[str]]:
    removable_roots = [worktree.path for worktree, _ in removable_worktrees]
    active_roots = [run.cwd for run in runs if run.active and run.cwd]
    kill: list[tuple[int, str]] = []
    notes: list[str] = []
    for process in processes:
        if process.pid in protected or not SERVER_RE.search(process.command):
            continue
        cwd = process_cwd(process.pid)
        if cwd is None:
            notes.append(f"left server {process.pid} alone because cwd is unknown")
            continue
        if any(paths_overlap(cwd, path) for path in tmux_paths):
            notes.append(f"kept tmux-backed server {process.pid} in {cwd}")
            continue
        if any(is_inside(root, cwd) for root in active_roots):
            notes.append(f"kept active server {process.pid} in {cwd}")
            continue
        matched = False
        for root in removable_roots:
            if is_inside(root, cwd):
                kill.append((process.pid, f"server in stale worktree {root}"))
                matched = True
                break
        if not matched:
            notes.append(f"left server {process.pid} alone in {cwd}")
    return kill, notes


def terminate_pid(pid: int, apply: bool) -> str:
    if not apply:
        return "would kill"
    try:
        os.kill(pid, signal.SIGTERM)
    except OSError:
        return "already gone"
    time.sleep(1)
    if pid_exists(pid):
        try:
            os.kill(pid, signal.SIGKILL)
        except OSError:
            return "already gone"
    return "killed"


def prune_worktrees(context: RepoContext, apply: bool) -> str:
    if not apply:
        return "would run git worktree prune"
    result = run_command(["git", "worktree", "prune"], cwd=context.repo_root)
    if result.returncode == 0:
        return "ran git worktree prune"
    message = result.stderr.strip() or result.stdout.strip() or "git worktree prune failed"
    return f"failed git worktree prune: {message}"


def remove_worktree(context: RepoContext, path: Path, apply: bool) -> str:
    if not apply:
        return f"would remove {path}"
    first = run_command(["git", "worktree", "remove", str(path)], cwd=context.repo_root)
    if first.returncode == 0:
        return f"removed {path}"
    message = first.stderr.strip() or first.stdout.strip() or "git worktree remove failed"
    return f"failed to remove {path}: {message}"


def close_browsers(apply: bool) -> list[str]:
    if sys.platform != "darwin":
        return ["skipped browser cleanup on non-macOS host"]
    actions: list[str] = []
    for app in ("Google Chrome", "Safari"):
        if not apply:
            actions.append(f"would close {app} windows")
            continue
        result = run_command(
            [
                "osascript",
                "-e",
                f'tell application "System Events" to set appRunning to exists process "{app}"',
                "-e",
                f'if appRunning then tell application "{app}" to close every window',
            ]
        )
        if result.returncode == 0:
            actions.append(f"closed {app} windows")
            continue
        message = result.stderr.strip() or result.stdout.strip() or "unknown error"
        actions.append(f"failed to close {app} windows: {message}")
    return actions


def print_section(title: str, lines: list[str]) -> None:
    print(f"{title}:")
    if not lines:
        print("  none")
        return
    for line in lines:
        print(f"  - {line}")


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Clean stale loop runs, servers, browsers, and worktrees."
    )
    parser.add_argument("--apply", action="store_true", help="Apply cleanup changes.")
    parser.add_argument(
        "--browsers",
        action="store_true",
        help="Close Safari and Chrome windows on macOS.",
    )
    parser.add_argument(
        "--repo",
        default=".",
        help="Repo path or worktree path for the loop checkout to inspect.",
    )
    args = parser.parse_args()

    try:
        context = resolve_repo(Path(args.repo))
    except CleanVmError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    runs, warnings = load_runs(context)
    processes = process_list()
    protected = ancestor_pids()
    tmux_paths = live_tmux_paths()

    removable_worktrees, worktree_notes, needs_prune = classify_worktrees(
        context, runs, tmux_paths
    )
    run_kills, run_notes = classify_run_processes(
        runs, protected, processes, tmux_paths
    )
    agent_notes = classify_agent_processes(runs, protected, processes)
    server_kills, server_notes = classify_servers(
        removable_worktrees, runs, protected, processes, tmux_paths
    )

    process_actions: list[str] = []
    for pid, reason in [*run_kills, *server_kills]:
        process_actions.append(f"{terminate_pid(pid, args.apply)} pid {pid}: {reason}")

    worktree_actions: list[str] = []
    if needs_prune:
        worktree_actions.append(prune_worktrees(context, args.apply))
    for worktree, reason in removable_worktrees:
        outcome = remove_worktree(context, worktree.path, args.apply)
        worktree_actions.append(f"{outcome} ({reason})")

    browser_actions = (
        close_browsers(args.apply) if args.browsers else ["skipped browser cleanup"]
    )

    print(f"mode: {'apply' if args.apply else 'dry-run'}")
    print(f"repo: {context.repo_root}")
    print(f"repo id: {context.repo_id}")
    print_section("runs", warnings + run_notes)
    print_section("processes", process_actions + agent_notes)
    print_section("servers", server_notes)
    print_section("worktrees", worktree_actions + worktree_notes)
    print_section("browsers", browser_actions)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
