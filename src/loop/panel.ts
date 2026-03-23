import {
  closeSync,
  type Dirent,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { file, spawn } from "bun";

type Agent = "claude" | "codex";

interface AgentProcess {
  agent: Agent;
  pid: number;
}

interface LsofSnapshot {
  cwd: string;
  names: string[];
}

interface Row {
  agent: Agent;
  cwd: string;
  event: string;
  idle: string;
  pid: number;
  session: string;
  state: string;
}

interface DoneRow {
  endedAtMs: number;
  id: string;
  row: Row;
}

interface Snapshot {
  loopRuns: LoopRunEntry[];
  rows: Row[];
  tmuxRows: TmuxRow[];
  warning?: string;
}

interface LoopRunEntry {
  claudeSessionId: string;
  codexThreadId: string;
  cwd: string;
  mode: string;
  pid: number;
  repoId: string;
  runId: string;
  status: string;
  updatedAtMs: number;
}

interface TmuxRow {
  attached: boolean;
  id: string;
  session: string;
}

interface ClaudeCache {
  processToSession: Map<number, string>;
  sessionToProject: Map<string, string>;
}

const HOME = process.env.HOME ?? "";
const CLAUDE_DEBUG_DIR = join(HOME, ".claude", "debug");
const CLAUDE_PROJECTS_DIR = join(HOME, ".claude", "projects");
const LOOP_RUNS_DIR = join(HOME, ".loop", "runs");
const CODEX_SESSIONS_DIR = join(HOME, ".codex", "sessions");
const REFRESH_MS = 1000;
const ACTIVE_MS = 15_000;
const DONE_LIMIT = 30;
const LOOP_RUN_LIMIT = 30;
const SESSION_FILE_MARKER = `${join(HOME, ".codex", "sessions")}/`;
const FILE_CHUNK_BYTES = 8192;
const NEWLINE_RE = /\r?\n/;
const PS_ROW_RE = /^\s*(\d+)\s+(\d+)\s+(.+)$/;
const TOKEN_RE = /\s+/;
const TRAILING_CR_RE = /\r$/;
const TRAILING_LINE_BREAKS_RE = /[\r\n]+$/g;
const LOOP_SESSION_RE = /-loop-([A-Za-z0-9][A-Za-z0-9_-]*)$/;
const TMUX_ID_COLLATOR = new Intl.Collator(undefined, { numeric: true });

const isNodeOrBunToken = (token: string): boolean =>
  token === "node" ||
  token === "bun" ||
  token.endsWith("/node") ||
  token.endsWith("/bun");

const isCodexBinaryToken = (token: string): boolean =>
  token === "codex" ||
  token.includes("codex@") ||
  token.endsWith("/codex") ||
  token.endsWith("/bin/codex") ||
  token.endsWith("/codex.js") ||
  token.endsWith("/codex.mjs") ||
  token.endsWith("/codex-app-server") ||
  token.endsWith("/codex-app-server.js") ||
  token.includes("/openai/codex/") ||
  token.includes("/node_modules/@openai/codex") ||
  token.includes("/@openai/codex");

const isCodexAppServerToken = (token: string): boolean =>
  token === "app-server" ||
  token.includes("app-server/") ||
  token.endsWith("/app-server") ||
  token.endsWith("/app-server.js") ||
  token.endsWith("/app-server.mjs") ||
  token.includes("/codex-app-server");

const tokenizeCommand = (command: string): string[] =>
  command.split(TOKEN_RE).filter(Boolean);

const commandBinaryTokens = (tokens: string[]): string[] => {
  const first = tokens[0] ?? "";
  if (!isNodeOrBunToken(first)) {
    return [first];
  }

  return [first, ...tokens.slice(1).filter((token) => !token.startsWith("-"))];
};

const isCodexAppServerProcess = (tokens: string[]): boolean => {
  const binaryTokens = commandBinaryTokens(tokens);
  const hasAppServer = tokens.some(isCodexAppServerToken);
  const hasCodexBinary =
    binaryTokens.some(isCodexBinaryToken) ||
    binaryTokens.some(isCodexAppServerToken);
  return hasAppServer && hasCodexBinary;
};

const isCodexAppServerWrapper = (tokens: string[]): boolean => {
  const appServerIndex = tokens.findIndex(isCodexAppServerToken);
  if (appServerIndex <= 0) {
    return false;
  }
  return tokens
    .slice(0, appServerIndex)
    .some((token) => isCodexBinaryToken(token) || isNodeOrBunToken(token));
};

const isCodexEngine = (command: string, tokens: string[]): boolean =>
  command.includes("/codex/codex") || isCodexAppServerProcess(tokens);

const sleep = async (ms: number): Promise<void> =>
  await new Promise((resolve) => setTimeout(resolve, ms));

const run = async (cmd: string[], allowFailure = false): Promise<string> => {
  const proc = spawn(cmd, {
    env: process.env,
    stderr: "pipe",
    stdout: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0 && !allowFailure) {
    const details = stderr.trim() || `exit ${code}`;
    throw new Error(`[loop] command failed: ${cmd.join(" ")} (${details})`);
  }
  return stdout;
};

const parseProcessList = (text: string): AgentProcess[] => {
  const rows: Array<{ command: string; pid: number; ppid: number }> = [];
  for (const line of text.split(NEWLINE_RE)) {
    const match = line.match(PS_ROW_RE);
    if (!match) {
      continue;
    }
    rows.push({
      command: match[3],
      pid: Number(match[1]),
      ppid: Number(match[2]),
    });
  }

  const codexEngineParents = new Set<number>();
  for (const row of rows) {
    if (isCodexEngine(row.command, tokenizeCommand(row.command))) {
      codexEngineParents.add(row.ppid);
    }
  }

  const processes: AgentProcess[] = [];
  const codexEngineParentPids = new Set<number>();

  for (const row of rows) {
    const tokens = tokenizeCommand(row.command);
    if (isCodexEngine(row.command, tokens)) {
      codexEngineParentPids.add(row.ppid);
    }
  }

  for (const row of rows) {
    const command = row.command.trim();
    const tokens = tokenizeCommand(command);
    const firstToken = tokens[0] ?? "";
    const isClaude = firstToken === "claude" || firstToken.endsWith("/claude");
    const isCodex = isCodexEngine(command, tokens);
    const isCodexWrapper = isCodexAppServerWrapper(tokens);

    if (isCodexWrapper && codexEngineParentPids.has(row.pid)) {
      continue;
    }
    if (isClaude) {
      processes.push({ agent: "claude", pid: row.pid });
      continue;
    }
    if (isCodex) {
      processes.push({ agent: "codex", pid: row.pid });
    }
  }
  return processes;
};

const parseTmuxSessions = (text: string): TmuxRow[] => {
  const rows: TmuxRow[] = [];
  for (const line of text.split(NEWLINE_RE)) {
    if (!line.trim()) {
      continue;
    }
    const [sessionRaw, attachedRaw = "0"] = line.split("\t");
    const session = sessionRaw?.trim() ?? "";
    if (!session) {
      continue;
    }
    const match = session.match(LOOP_SESSION_RE);
    if (!match) {
      continue;
    }
    rows.push({
      attached: attachedRaw.trim() === "1",
      id: match[1],
      session,
    });
  }
  rows.sort(
    (a, b) =>
      TMUX_ID_COLLATOR.compare(a.id, b.id) || a.session.localeCompare(b.session)
  );
  return rows;
};

const parseLsofSnapshot = (text: string): LsofSnapshot => {
  const first = parseLsofByPid(text).values().next().value;
  return first ?? { cwd: "", names: [] };
};

const parseLsofByPid = (text: string): Map<number, LsofSnapshot> => {
  const snapshots = new Map<number, LsofSnapshot>();
  let current: LsofSnapshot | undefined;
  let fd = "";
  for (const line of text.split(NEWLINE_RE)) {
    if (line.startsWith("p")) {
      const pid = Number(line.slice(1));
      if (!Number.isInteger(pid) || pid < 1) {
        current = undefined;
        continue;
      }
      const existing = snapshots.get(pid);
      if (existing) {
        current = existing;
      } else {
        current = { cwd: "", names: [] };
        snapshots.set(pid, current);
      }
      fd = "";
      continue;
    }

    if (!current) {
      continue;
    }

    if (line.startsWith("f")) {
      fd = line.slice(1);
      continue;
    }
    if (!line.startsWith("n")) {
      continue;
    }
    const name = line.slice(1);
    if (!name) {
      continue;
    }
    current.names.push(name);
    if (!current.cwd && fd === "cwd") {
      current.cwd = name;
    }
  }
  return snapshots;
};

const parseObject = (line: string): Record<string, unknown> | undefined => {
  if (!line.trim().startsWith("{")) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(line) as unknown;
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
};

const str = (obj: Record<string, unknown> | undefined, key: string): string => {
  const value = obj?.[key];
  return typeof value === "string" ? value : "";
};

const lastToken = (text: string): string =>
  text.split(TOKEN_RE).filter(Boolean).at(-1) ?? "";

const projectKeyFromCwd = (cwd: string): string => cwd.replaceAll("/", "-");

const parseTimestampMs = (iso: string): number => {
  const value = Date.parse(iso);
  return Number.isFinite(value) ? value : Number.NaN;
};

const formatAge = (elapsedSeconds: number): string => {
  if (elapsedSeconds < 60) {
    return `${elapsedSeconds}s`;
  }
  if (elapsedSeconds < 3600) {
    return `${Math.floor(elapsedSeconds / 60)}m`;
  }
  if (elapsedSeconds < 86_400) {
    return `${Math.floor(elapsedSeconds / 3600)}h`;
  }
  return `${Math.floor(elapsedSeconds / 86_400)}d`;
};

const ageText = (iso: string): string => {
  if (!iso) {
    return "-";
  }
  const ts = parseTimestampMs(iso);
  if (!Number.isFinite(ts)) {
    return "-";
  }
  return ageFromMs(ts);
};

const ageFromMs = (timestampMs: number): string => {
  const elapsed = Math.max(0, Math.floor((Date.now() - timestampMs) / 1000));
  return formatAge(elapsed);
};

const stateFrom = (iso: string): string => {
  if (!iso) {
    return "unknown";
  }
  const ts = parseTimestampMs(iso);
  if (!Number.isFinite(ts)) {
    return "unknown";
  }
  return Date.now() - ts <= ACTIVE_MS ? "active" : "idle";
};

const numberFrom = (
  obj: Record<string, unknown> | undefined,
  key: string
): number => {
  const value = obj?.[key];
  let parsed = Number.NaN;
  if (typeof value === "number") {
    parsed = value;
  } else if (typeof value === "string") {
    parsed = Number.parseInt(value, 10);
  }
  return Number.isInteger(parsed) ? parsed : -1;
};

const timestampFrom = (
  obj: Record<string, unknown> | undefined,
  key: string
): number => {
  const ts = parseTimestampMs(str(obj, key));
  return Number.isFinite(ts) ? ts : Number.NaN;
};

const clamp = (text: string, width: number): string =>
  text.length <= width ? text.padEnd(width) : `${text.slice(0, width - 3)}...`;

const trimText = (text: string, width: number): string => {
  if (width <= 0) {
    return "";
  }
  return text.length <= width
    ? text
    : `${text.slice(0, Math.max(0, width - 3))}...`;
};

const rowId = (row: Row): string =>
  row.session !== "-"
    ? `${row.agent}:${row.session}`
    : `${row.agent}:${row.pid}:${row.cwd}`;

const pidText = (pid: number): string => (pid > 0 ? String(pid) : "-");

interface TableSpec {
  agent: number;
  cwd: number;
  event: number;
  idle: number;
  pid: number;
  session: number;
  state: number;
}

const tableSpec = (width: number): TableSpec | undefined => {
  const min: TableSpec = {
    agent: 6,
    pid: 6,
    state: 7,
    idle: 6,
    session: 16,
    cwd: 16,
    event: 16,
  };
  const spaces = 6;
  const minTotal =
    min.agent +
    min.pid +
    min.state +
    min.idle +
    min.session +
    min.cwd +
    min.event +
    spaces;
  if (width < minTotal) {
    return undefined;
  }
  const extra = width - minTotal;
  const sessionExtra = Math.floor(extra * 0.4);
  const cwdExtra = Math.floor(extra * 0.35);
  const eventExtra = extra - sessionExtra - cwdExtra;
  return {
    agent: min.agent,
    pid: min.pid,
    state: min.state,
    idle: min.idle,
    session: min.session + sessionExtra,
    cwd: min.cwd + cwdExtra,
    event: min.event + eventExtra,
  };
};

const trimLine = (value: string): string =>
  value.replace(TRAILING_CR_RE, "").trim();

const trimTrailingLineBreaks = (value: string): string =>
  value.replace(TRAILING_LINE_BREAKS_RE, "");

const readFirstLine = (path: string): string => {
  try {
    const fd = openSync(path, "r");
    try {
      const chunk = Buffer.alloc(FILE_CHUNK_BYTES);
      let line = "";
      while (true) {
        const bytesRead = readSync(fd, chunk, 0, chunk.length, null);
        if (bytesRead <= 0) {
          break;
        }
        const text = chunk.toString("utf8", 0, bytesRead);
        const newlineIndex = text.indexOf("\n");
        if (newlineIndex === -1) {
          line += text;
          continue;
        }
        line += text.slice(0, newlineIndex);
        break;
      }
      return trimLine(line);
    } finally {
      closeSync(fd);
    }
  } catch {
    return "";
  }
};

const readLastLine = (path: string): string => {
  try {
    const size = statSync(path).size;
    if (size <= 0) {
      return "";
    }

    const fd = openSync(path, "r");
    try {
      const chunk = Buffer.alloc(FILE_CHUNK_BYTES);
      let offset = size;
      let collected = "";

      while (offset > 0) {
        const length = Math.min(FILE_CHUNK_BYTES, offset);
        offset -= length;
        const bytesRead = readSync(fd, chunk, 0, length, offset);
        if (bytesRead <= 0) {
          break;
        }

        collected = chunk.toString("utf8", 0, bytesRead) + collected;
        const trimmed = trimTrailingLineBreaks(collected);
        const newlineIndex = trimmed.lastIndexOf("\n");
        if (newlineIndex === -1) {
          collected = trimmed;
          continue;
        }
        return trimLine(trimmed.slice(newlineIndex + 1));
      }

      return trimLine(trimTrailingLineBreaks(collected));
    } finally {
      closeSync(fd);
    }
  } catch {
    return "";
  }
};

const readJson = (path: string): Record<string, unknown> | undefined => {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
};

const loopRunPath = (path: string): { repoId: string; runId: string } => {
  const runDir = dirname(path);
  const repoDir = dirname(runDir);
  return {
    repoId: basename(repoDir) || "loop",
    runId: basename(runDir) || "-",
  };
};

const parseLoopRunManifest = (path: string): LoopRunEntry | undefined => {
  if (!existsSync(path)) {
    return undefined;
  }

  const manifest = readJson(path);
  if (!manifest) {
    return undefined;
  }

  const ids = loopRunPath(path);
  const updatedAtMs =
    timestampFrom(manifest, "updatedAt") ||
    timestampFrom(manifest, "updated_at") ||
    timestampFrom(manifest, "createdAt") ||
    timestampFrom(manifest, "created_at") ||
    fileTimestampMs(path);

  return {
    claudeSessionId:
      str(manifest, "claudeSessionId") ||
      str(manifest, "claude_session_id") ||
      "-",
    codexThreadId:
      str(manifest, "codexThreadId") || str(manifest, "codex_thread_id") || "-",
    cwd: str(manifest, "cwd") || "-",
    mode: str(manifest, "mode") || "paired",
    pid: numberFrom(manifest, "pid"),
    repoId: str(manifest, "repoId") || str(manifest, "repo_id") || ids.repoId,
    runId: str(manifest, "runId") || str(manifest, "run_id") || ids.runId,
    status: str(manifest, "status") || "unknown",
    updatedAtMs: Number.isFinite(updatedAtMs)
      ? updatedAtMs
      : fileTimestampMs(path),
  };
};

const codexRow = (pid: number, lsof: LsofSnapshot): Row => {
  const sessionPath = lsof.names.find(
    (name) => name.startsWith(SESSION_FILE_MARKER) && name.endsWith(".jsonl")
  );
  let session = "";
  let iso = "";
  let event = "running";

  if (sessionPath && existsSync(sessionPath)) {
    const first = parseObject(readFirstLine(sessionPath));
    const payload =
      typeof first?.payload === "object" && first.payload !== null
        ? (first.payload as Record<string, unknown>)
        : undefined;
    session = str(payload, "id") || lastToken(basename(sessionPath, ".jsonl"));

    const last = parseObject(readLastLine(sessionPath));
    iso = str(last, "timestamp");
    event = str(last, "type") || event;
    const lastPayload =
      typeof last?.payload === "object" && last.payload !== null
        ? (last.payload as Record<string, unknown>)
        : undefined;
    const payloadType = str(lastPayload, "type");
    if (payloadType) {
      event = `${event}/${payloadType}`;
    }
  }

  return {
    agent: "codex",
    cwd: lsof.cwd || "-",
    event,
    idle: ageText(iso),
    pid,
    session: session || "-",
    state: stateFrom(iso),
  };
};

const newestFile = (paths: string[]): string => {
  let winner = "";
  let bestMtime = -1;
  for (const path of paths) {
    try {
      const mtime = statSync(path).mtimeMs;
      if (mtime > bestMtime) {
        bestMtime = mtime;
        winner = path;
      }
    } catch {
      // Ignore files that disappear between list and stat.
    }
  }
  return winner;
};

const listClaudeDebugFiles = (): string[] => {
  if (!existsSync(CLAUDE_DEBUG_DIR)) {
    return [];
  }
  try {
    return readdirSync(CLAUDE_DEBUG_DIR, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".txt"))
      .map((entry) => join(CLAUDE_DEBUG_DIR, entry.name));
  } catch {
    return [];
  }
};

const fileContains = async (path: string, value: string): Promise<boolean> => {
  if (!value) {
    return true;
  }
  try {
    const reader = file(path).stream().getReader();
    const decoder = new TextDecoder();
    const overlap = Math.max(0, value.length - 1);
    let carry = "";
    try {
      while (true) {
        const { done, value: chunk } = await reader.read();
        if (done) {
          break;
        }
        if (!chunk) {
          continue;
        }
        const text = carry + decoder.decode(chunk, { stream: true });
        if (text.includes(value)) {
          await reader.cancel();
          return true;
        }
        carry = overlap > 0 ? text.slice(-overlap) : "";
      }
      const tail = carry + decoder.decode();
      return tail.includes(value);
    } finally {
      reader.releaseLock();
    }
  } catch {
    return false;
  }
};

const findClaudeSession = async (
  pid: number,
  cache: ClaudeCache
): Promise<string> => {
  const cached = cache.processToSession.get(pid);
  if (cached && existsSync(join(CLAUDE_DEBUG_DIR, `${cached}.txt`))) {
    return cached;
  }
  const hits: string[] = [];
  const search = `PID ${pid})`;
  for (const path of listClaudeDebugFiles()) {
    if (await fileContains(path, search)) {
      hits.push(path);
    }
  }
  if (hits.length === 0) {
    return "";
  }
  const debugFile = newestFile(hits);
  const session = basename(debugFile, ".txt");
  if (session) {
    cache.processToSession.set(pid, session);
  }
  return session;
};

const findClaudeProjectFile = (
  cwd: string,
  session: string,
  cache: ClaudeCache
): string => {
  if (!existsSync(CLAUDE_PROJECTS_DIR)) {
    return "";
  }
  const cached = cache.sessionToProject.get(session);
  if (cached && existsSync(cached)) {
    return cached;
  }
  const key = projectKeyFromCwd(cwd);
  const candidate = join(CLAUDE_PROJECTS_DIR, key, `${session}.jsonl`);
  if (existsSync(candidate)) {
    cache.sessionToProject.set(session, candidate);
    return candidate;
  }
  try {
    for (const projectDir of readdirSync(CLAUDE_PROJECTS_DIR, {
      withFileTypes: true,
    })) {
      if (!projectDir.isDirectory()) {
        continue;
      }
      const path = join(
        CLAUDE_PROJECTS_DIR,
        projectDir.name,
        `${session}.jsonl`
      );
      if (existsSync(path)) {
        cache.sessionToProject.set(session, path);
        return path;
      }
    }
  } catch {
    return "";
  }
  return "";
};

const parseClaudeEvent = (line: string): { event: string; iso: string } => {
  const item = parseObject(line);
  if (!item) {
    return { event: "running", iso: "" };
  }
  const iso = str(item, "timestamp");
  const type = str(item, "type");
  const subtype = str(item, "subtype");
  const data =
    typeof item.data === "object" && item.data !== null
      ? (item.data as Record<string, unknown>)
      : undefined;
  const dataType = str(data, "type");
  if (subtype) {
    return { event: `${type}/${subtype}`, iso };
  }
  if (type === "progress" && dataType) {
    return { event: `${type}/${dataType}`, iso };
  }
  return { event: type || "running", iso };
};

const claudeRow = async (
  pid: number,
  lsof: LsofSnapshot,
  cache: ClaudeCache
): Promise<Row> => {
  const session = await findClaudeSession(pid, cache);
  const debugFile = session ? join(CLAUDE_DEBUG_DIR, `${session}.txt`) : "";
  const debugIso = debugFile ? lastToken(readLastLine(debugFile)) : "";
  const transcript = session
    ? findClaudeProjectFile(lsof.cwd, session, cache)
    : "";
  const parsed = transcript
    ? parseClaudeEvent(readLastLine(transcript))
    : undefined;
  const iso = parsed?.iso || debugIso;

  return {
    agent: "claude",
    cwd: lsof.cwd || "-",
    event: parsed?.event || "running",
    idle: ageText(iso),
    pid,
    session: session || "-",
    state: stateFrom(iso),
  };
};

const collectSnapshot = async (cache: ClaudeCache): Promise<Snapshot> => {
  const loopRuns = collectLoopRuns(LOOP_RUNS_DIR);
  const tmuxRows = parseTmuxSessions(
    await run(
      ["tmux", "list-sessions", "-F", "#{session_name}\t#{session_attached}"],
      true
    )
  );
  const ps = await run(["ps", "-Ao", "pid,ppid,command", "-ww"], true);
  if (!ps.trim()) {
    return {
      rows: [],
      loopRuns,
      tmuxRows,
      warning: "Could not read process table.",
    };
  }

  const processes = parseProcessList(ps);
  const lsofByPid = new Map<number, LsofSnapshot>();
  if (processes.length > 0) {
    const pidList = processes.map((process) => String(process.pid)).join(",");
    const lsofOutput = await run(["lsof", "-p", pidList, "-Fn"], true);
    for (const [pid, snapshot] of parseLsofByPid(lsofOutput)) {
      lsofByPid.set(pid, snapshot);
    }
  }

  let failures = 0;
  const rows = (
    await Promise.all(
      processes.map(async (process): Promise<Row | undefined> => {
        try {
          const lsof = lsofByPid.get(process.pid) ?? { cwd: "", names: [] };
          if (process.agent === "codex") {
            return codexRow(process.pid, lsof);
          }
          return await claudeRow(process.pid, lsof, cache);
        } catch {
          failures++;
          return undefined;
        }
      })
    )
  ).filter((row): row is Row => Boolean(row));

  rows.sort(
    (a, b) =>
      a.agent.localeCompare(b.agent) ||
      a.pid - b.pid ||
      a.cwd.localeCompare(b.cwd)
  );
  return {
    rows,
    loopRuns,
    tmuxRows,
    warning:
      failures > 0 ? `Failed to inspect ${failures} process(es).` : undefined,
  };
};

const fileTimestampMs = (path: string): number => {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return Number.NaN;
  }
};

const listFiles = (root: string, suffix: string): string[] => {
  if (!existsSync(root)) {
    return [];
  }
  const files: string[] = [];
  const queue = [root];
  while (queue.length > 0) {
    const dir = queue.shift();
    if (!dir) {
      continue;
    }
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        queue.push(path);
        continue;
      }
      if (entry.isFile() && path.endsWith(suffix)) {
        files.push(path);
      }
    }
  }
  return files;
};

const parseCodexHistoryRow = (path: string): DoneRow | undefined => {
  if (!existsSync(path)) {
    return undefined;
  }
  const first = parseObject(readFirstLine(path));
  const firstPayload =
    typeof first?.payload === "object" && first.payload !== null
      ? (first.payload as Record<string, unknown>)
      : undefined;
  const payload =
    typeof firstPayload === "object" && firstPayload !== null
      ? firstPayload
      : undefined;
  const session =
    str(payload, "id") ||
    str(first, "id") ||
    str(first, "session") ||
    str(first, "sessionId") ||
    basename(path, ".jsonl");
  const cwd = str(payload, "cwd") || str(first, "cwd") || "-";

  const last = parseObject(readLastLine(path));
  const iso = str(last, "timestamp");
  const lastPayload =
    typeof last?.payload === "object" && last.payload !== null
      ? (last.payload as Record<string, unknown>)
      : undefined;
  const payloadType = str(lastPayload, "type");
  const eventBase = str(last, "type") || str(lastPayload, "type") || "unknown";
  const event = payloadType ? `${eventBase}/${payloadType}` : eventBase;
  const endedAtMs = Number.isFinite(parseTimestampMs(iso))
    ? parseTimestampMs(iso)
    : fileTimestampMs(path);

  if (!Number.isFinite(endedAtMs)) {
    return undefined;
  }
  const row: Row = {
    agent: "codex",
    cwd,
    event,
    idle: "-",
    pid: -1,
    session: session || "-",
    state: "done",
  };
  return { endedAtMs, id: rowId(row), row };
};

const parseClaudeHistoryRow = (path: string): DoneRow | undefined => {
  if (!existsSync(path)) {
    return undefined;
  }
  const first = parseObject(readFirstLine(path));
  const session = str(first, "sessionId") || basename(path, ".jsonl");
  const cwd = str(first, "cwd") || "-";
  const parsed = parseClaudeEvent(readLastLine(path));
  const endedAtMs = Number.isFinite(parseTimestampMs(parsed.iso))
    ? parseTimestampMs(parsed.iso)
    : fileTimestampMs(path);

  if (!Number.isFinite(endedAtMs)) {
    return undefined;
  }
  const row: Row = {
    agent: "claude",
    cwd,
    event: parsed.event || "unknown",
    idle: "-",
    pid: -1,
    session: session || "-",
    state: "done",
  };
  return { endedAtMs, id: rowId(row), row };
};

const newestFirst = (paths: string[]): string[] =>
  [...paths].sort((a, b) => fileTimestampMs(b) - fileTimestampMs(a));

const collectLoopRuns = (root: string): LoopRunEntry[] => {
  if (!existsSync(root)) {
    return [];
  }

  const runs = newestFirst(listFiles(root, "manifest.json"))
    .slice(0, LOOP_RUN_LIMIT)
    .map(parseLoopRunManifest)
    .filter((run): run is LoopRunEntry => Boolean(run));

  runs.sort(
    (a, b) =>
      b.updatedAtMs - a.updatedAtMs ||
      a.repoId.localeCompare(b.repoId) ||
      a.runId.localeCompare(b.runId)
  );
  return runs.slice(0, LOOP_RUN_LIMIT);
};

const seedDoneRows = (): DoneRow[] => {
  const codexPaths = newestFirst(listFiles(CODEX_SESSIONS_DIR, ".jsonl")).slice(
    0,
    DONE_LIMIT
  );
  const claudePaths = newestFirst(
    listFiles(CLAUDE_PROJECTS_DIR, ".jsonl")
  ).slice(0, DONE_LIMIT);

  const rows: DoneRow[] = [];
  for (const path of codexPaths) {
    const row = parseCodexHistoryRow(path);
    if (row) {
      rows.push(row);
    }
  }
  for (const path of claudePaths) {
    const row = parseClaudeHistoryRow(path);
    if (row) {
      rows.push(row);
    }
  }

  rows.sort((a, b) => b.endedAtMs - a.endedAtMs);
  const unique = new Map<string, DoneRow>();
  for (const row of rows) {
    if (!unique.has(row.id)) {
      unique.set(row.id, row);
    }
    if (unique.size >= DONE_LIMIT) {
      break;
    }
  }
  return [...unique.values()];
};

const seedLoopRuns = (): LoopRunEntry[] => collectLoopRuns(LOOP_RUNS_DIR);

const reconcileDoneRows = (
  previousRows: Row[],
  currentRows: Row[],
  doneRows: DoneRow[],
  nowMs: number
): DoneRow[] => {
  const currentIds = new Set(currentRows.map(rowId));
  const keptDone = doneRows.filter((entry) => !currentIds.has(entry.id));
  const knownDone = new Set(keptDone.map((entry) => entry.id));

  for (const row of previousRows) {
    const id = rowId(row);
    if (currentIds.has(id) || knownDone.has(id)) {
      continue;
    }
    keptDone.push({ endedAtMs: nowMs, id, row });
    knownDone.add(id);
  }

  keptDone.sort((a, b) => b.endedAtMs - a.endedAtMs);
  return keptDone.slice(0, DONE_LIMIT);
};

const stackedRowLines = (row: Row, width: number): string[] => {
  const available = Math.max(20, width);
  return [
    trimText(
      `${row.agent} pid=${pidText(row.pid)} state=${row.state} idle=${row.idle}`,
      available
    ),
    `session: ${trimText(row.session, Math.max(1, available - 9))}`,
    `cwd: ${trimText(row.cwd, Math.max(1, available - 5))}`,
    `event: ${trimText(row.event, Math.max(1, available - 7))}`,
  ];
};

const stackedDoneLines = (entry: DoneRow, width: number): string[] => {
  const available = Math.max(20, width);
  return [
    trimText(
      `${entry.row.agent} pid=${pidText(entry.row.pid)} done_for=${ageFromMs(entry.endedAtMs)}`,
      available
    ),
    `session: ${trimText(entry.row.session, Math.max(1, available - 9))}`,
    `cwd: ${trimText(entry.row.cwd, Math.max(1, available - 5))}`,
    `final: ${trimText(entry.row.event, Math.max(1, available - 7))}`,
  ];
};

const stackedLoopRunLines = (entry: LoopRunEntry, width: number): string[] => {
  const available = Math.max(20, width);
  return [
    trimText(
      `${entry.repoId}/${entry.runId} pid=${pidText(entry.pid)} status=${entry.status} mode=${entry.mode} updated=${ageFromMs(entry.updatedAtMs)}`,
      available
    ),
    `claude: ${trimText(entry.claudeSessionId, Math.max(1, available - 8))}`,
    `codex: ${trimText(entry.codexThreadId, Math.max(1, available - 7))}`,
    `cwd: ${trimText(entry.cwd, Math.max(1, available - 5))}`,
  ];
};

const pushStackedSection = <T>(
  lines: string[],
  heading: string,
  rows: T[],
  emptyText: string,
  width: number,
  lineBuilder: (row: T, panelWidth: number) => string[]
): void => {
  lines.push("", `${heading} ${rows.length}`);
  if (rows.length === 0) {
    lines.push(emptyText);
    return;
  }

  for (const row of rows) {
    lines.push(...lineBuilder(row, width), "");
  }
  while (lines.at(-1) === "") {
    lines.pop();
  }
};

const tmuxState = (attached: boolean): string =>
  attached ? "attached" : "detached";

const tmuxLine = (row: TmuxRow, width: number): string =>
  trimText(
    `id=${row.id} session=${row.session} (${tmuxState(row.attached)}) attach: tmux attach -t ${row.session}`,
    Math.max(20, width)
  );

const pushTmuxSection = (
  lines: string[],
  rows: TmuxRow[],
  width: number
): void => {
  lines.push("", `[tmux] ${rows.length}`);
  if (rows.length === 0) {
    lines.push("No active loop tmux sessions.");
    return;
  }
  lines.push(...rows.map((row) => tmuxLine(row, width)));
};

const buildLines = (
  snapshot: Snapshot,
  doneRows: DoneRow[],
  width: number
): string[] => {
  const lines = [
    "[loop] live control panel - Ctrl+C to exit",
    `updated: ${new Date().toISOString()}`,
  ];
  if (snapshot.warning) {
    lines.push(`[loop] ${snapshot.warning}`);
  }
  pushTmuxSection(lines, snapshot.tmuxRows, width);
  pushStackedSection(
    lines,
    "[loop runs]",
    snapshot.loopRuns,
    "No loop-owned paired runs found.",
    width,
    stackedLoopRunLines
  );

  const spec = tableSpec(width);
  if (!spec) {
    pushStackedSection(
      lines,
      "[running]",
      snapshot.rows,
      "No running codex or claude instances found.",
      width,
      stackedRowLines
    );
    pushStackedSection(
      lines,
      "[done]",
      doneRows,
      "No completed instances yet.",
      width,
      stackedDoneLines
    );
    return lines;
  }

  lines.push("", `[running] ${snapshot.rows.length}`);
  lines.push(
    `${clamp("agent", spec.agent)} ${clamp("pid", spec.pid)} ${clamp(
      "state",
      spec.state
    )} ${clamp("idle", spec.idle)} ${clamp("session", spec.session)} ${clamp(
      "cwd",
      spec.cwd
    )} ${clamp("event", spec.event)}`
  );
  if (snapshot.rows.length === 0) {
    lines.push("No running codex or claude instances found.");
  } else {
    lines.push(
      ...snapshot.rows.map((row) =>
        [
          clamp(row.agent, spec.agent),
          clamp(pidText(row.pid), spec.pid),
          clamp(row.state, spec.state),
          clamp(row.idle, spec.idle),
          clamp(row.session, spec.session),
          clamp(row.cwd, spec.cwd),
          clamp(row.event, spec.event),
        ].join(" ")
      )
    );
  }

  lines.push("", `[done] ${doneRows.length}`);
  lines.push(
    `${clamp("agent", spec.agent)} ${clamp("pid", spec.pid)} ${clamp(
      "done_for",
      spec.state
    )} ${clamp("session", spec.session)} ${clamp("cwd", spec.cwd)} ${clamp(
      "final_event",
      spec.event
    )}`
  );
  if (doneRows.length === 0) {
    lines.push("No completed instances yet.");
  } else {
    lines.push(
      ...doneRows.map((entry) =>
        [
          clamp(entry.row.agent, spec.agent),
          clamp(pidText(entry.row.pid), spec.pid),
          clamp(ageFromMs(entry.endedAtMs), spec.state),
          clamp(entry.row.session, spec.session),
          clamp(entry.row.cwd, spec.cwd),
          clamp(entry.row.event, spec.event),
        ].join(" ")
      )
    );
  }
  return lines;
};

const render = (snapshot: Snapshot, doneRows: DoneRow[]): void => {
  const width =
    process.stdout.columns && process.stdout.columns > 0
      ? process.stdout.columns
      : 120;
  const lines = buildLines(snapshot, doneRows, width);
  process.stdout.write("\u001b[2J\u001b[H");
  process.stdout.write(`${lines.join("\n")}\n`);
};

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export const runPanel = async (): Promise<void> => {
  const cache: ClaudeCache = {
    processToSession: new Map(),
    sessionToProject: new Map(),
  };
  let previousRows: Row[] = [];
  let previousLoopRuns: LoopRunEntry[] = seedLoopRuns();
  let doneRows: DoneRow[] = seedDoneRows();
  let stop = false;
  const onStop = (): void => {
    stop = true;
  };

  process.on("SIGINT", onStop);
  process.on("SIGTERM", onStop);

  try {
    while (!stop) {
      let snapshot: Snapshot;
      try {
        snapshot = await collectSnapshot(cache);
        previousLoopRuns = snapshot.loopRuns;
        doneRows = reconcileDoneRows(
          previousRows,
          snapshot.rows,
          doneRows,
          Date.now()
        );
        previousRows = snapshot.rows;
      } catch (error) {
        snapshot = {
          rows: previousRows,
          loopRuns: previousLoopRuns,
          tmuxRows: [],
          warning: `Panel refresh failed: ${errorText(error)}`,
        };
      }
      render(snapshot, doneRows);
      if (!stop) {
        await sleep(REFRESH_MS);
      }
    }
  } finally {
    process.off("SIGINT", onStop);
    process.off("SIGTERM", onStop);
    process.stdout.write("\n");
  }
};

export const panelInternals = {
  buildLines,
  collectLoopRuns,
  parseLsofSnapshot,
  parseProcessList,
  parseTmuxSessions,
  parseTimestampMs,
  projectKeyFromCwd,
  reconcileDoneRows,
  rowId,
  parseCodexHistoryRow,
  parseLoopRunManifest,
};
