/**
 * Best-effort Windows Node.js process inventory for the local ACP monitor.
 *
 * Windows does not expose a process working directory through Win32_Process,
 * so project/requester values are explicitly marked as inferred.  The PID and
 * start time are always revalidated immediately before an End action to avoid
 * terminating a different process after PID reuse.
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface ProcessAncestor {
  pid: number;
  parentPid: number;
  name: string;
  commandLine: string;
}

export interface NodeProcessInfo {
  pid: number;
  parentPid: number;
  name: string;
  executablePath: string;
  commandLine: string;
  parentName: string | null;
  parentCommandLine: string | null;
  parentExited: boolean;
  ancestry: ProcessAncestor[];
  requester: { label: string; evidence: string };
  startedAt: string;
  uptimeMs: number;
  cpuSeconds: number;
  cpuPercent: number | null;
  activity: "sampling" | "active" | "listening" | "quiet";
  memoryMb: number;
  threads: number;
  ports: number[];
  project: string | null;
  script: string | null;
  restartManaged: boolean;
  duplicateGroupId: string | null;
  duplicateCount: number;
  duplicateRank: number;
  canTerminate: boolean;
  protectionReason: string | null;
}

export interface NodeProcessAction {
  at: string;
  action: "end";
  pid: number;
  startedAt: string;
  script: string | null;
  project: string | null;
  requester: string | null;
  ok: boolean;
  message: string;
}

interface RawProcess {
  pid?: unknown;
  parentPid?: unknown;
  name?: unknown;
  executablePath?: unknown;
  commandLine?: unknown;
}

interface RawNode extends RawProcess {
  startedAt?: unknown;
  cpuSeconds?: unknown;
  memoryBytes?: unknown;
  threads?: unknown;
  ports?: unknown;
}

interface RawSnapshot {
  processes?: RawProcess | RawProcess[];
  nodes?: RawNode | RawNode[];
}

const CACHE_TTL_MS = 5_000;
let cache: { at: number; rows: NodeProcessInfo[] } | null = null;
let cpuSamples = new Map<number, { startedAt: string; cpuSeconds: number; at: number }>();
const ACTION_LOG = join(homedir(), ".acp", "node-process-actions.jsonl");

const POWERSHELL_SNAPSHOT = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
$all = @(Get-CimInstance Win32_Process)
$nodes = @($all | Where-Object { $_.Name -match '^node(js)?\.exe$' })
$nodeIds = @($nodes | ForEach-Object { [int]$_.ProcessId })
$metrics = @{}
if ($nodeIds.Count -gt 0) {
  Get-Process -Id $nodeIds -ErrorAction SilentlyContinue | ForEach-Object {
    $started = $null
    try { $started = $_.StartTime.ToString('o') } catch {}
    $metrics[[int]$_.Id] = [pscustomobject]@{
      startedAt = $started
      cpuSeconds = if ($null -eq $_.CPU) { 0 } else { [double]$_.CPU }
      memoryBytes = [double]$_.WorkingSet64
      threads = [int]$_.Threads.Count
    }
  }
}
$ports = @{}
if (Get-Command netstat.exe -ErrorAction SilentlyContinue) {
  netstat.exe -ano -p tcp | ForEach-Object {
    if ($_ -match '^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$') {
      $port = [int]$Matches[1]
      $owner = [int]$Matches[2]
    } else {
      $owner = 0
      $port = 0
    }
    if ($nodeIds -contains $owner) {
      if (-not $ports.ContainsKey($owner)) { $ports[$owner] = @() }
      $ports[$owner] += $port
    }
  }
}
$processRows = @($all | ForEach-Object {
  [pscustomobject]@{
    pid = [int]$_.ProcessId
    parentPid = [int]$_.ParentProcessId
    name = [string]$_.Name
    executablePath = [string]$_.ExecutablePath
    commandLine = [string]$_.CommandLine
  }
})
$nodeRows = @($nodes | ForEach-Object {
  $id = [int]$_.ProcessId
  $metric = $metrics[$id]
  $created = $null
  if ($metric -and $metric.startedAt) { $created = $metric.startedAt }
  elseif ($_.CreationDate) { try { $created = ([datetime]$_.CreationDate).ToString('o') } catch {} }
  [pscustomobject]@{
    pid = $id
    parentPid = [int]$_.ParentProcessId
    name = [string]$_.Name
    executablePath = [string]$_.ExecutablePath
    commandLine = [string]$_.CommandLine
    startedAt = $created
    cpuSeconds = if ($metric) { $metric.cpuSeconds } else { 0 }
    memoryBytes = if ($metric) { $metric.memoryBytes } else { 0 }
    threads = if ($metric) { $metric.threads } else { 0 }
    ports = @($ports[$id] | Sort-Object -Unique)
  }
})
[pscustomobject]@{ processes = $processRows; nodes = $nodeRows } | ConvertTo-Json -Depth 5 -Compress
`;

function arrayOf<T>(value: T | T[] | undefined): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function text(value: unknown): string {
  return typeof value === "string" ? value : value === null || value === undefined ? "" : String(value);
}

function finiteNumber(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function extractScript(commandLine: string): string | null {
  const quoted = [...commandLine.matchAll(/["']([^"']+\.(?:[cm]?js|tsx?|jsx?))["']/gi)];
  if (quoted[0]?.[1]) return quoted[0][1];
  const absolute = commandLine.match(/([A-Za-z]:\\[^"'\r\n]*?\.(?:[cm]?js|tsx?|jsx?))(?=\s|$|["'])/i);
  if (absolute?.[1]) return absolute[1].trim();
  const relative = commandLine.match(/(?:^|\s)((?:\.\.?[\\/])?[^\s"']+\.(?:[cm]?js|tsx?|jsx?))(?=\s|$)/i);
  return relative?.[1] ?? null;
}

function projectFromPath(file: string | null): string | null {
  if (!file || !/^[A-Za-z]:[\\/]/.test(file)) return null;
  const normalized = file.replaceAll("/", "\\").replace(/\\{2,}/g, "\\");
  if (/^[A-Za-z]:\\Program Files\\nodejs\\node_modules\\/i.test(normalized)) return "Node.js global tools";
  const marker = normalized.toLowerCase().indexOf("\\node_modules\\");
  if (marker > 2) return normalized.slice(0, marker);
  return dirname(normalized);
}

/**
 * Long-running services often listen on a fixed port but expose a command line
 * that says nothing useful (a bare `node server.js`). Map those ports to a
 * label yourself instead of hard-coding one machine's layout here:
 *
 *   ACP_KNOWN_PORTS={"4500":["my-api","/srv/my-api/server.js"]}
 */
function loadKnownPorts(): Map<number, [string, string]> {
  const raw = process.env.ACP_KNOWN_PORTS?.trim();
  if (!raw) return new Map();
  try {
    const parsed = JSON.parse(raw) as Record<string, [string, string]>;
    const out = new Map<number, [string, string]>();
    for (const [port, pair] of Object.entries(parsed)) {
      const n = Number.parseInt(port, 10);
      if (Number.isFinite(n) && Array.isArray(pair) && typeof pair[0] === "string") {
        out.set(n, [pair[0], typeof pair[1] === "string" ? pair[1] : ""]);
      }
    }
    return out;
  } catch {
    return new Map();
  }
}

/** Optional watchdog script that restarts services (override with ACP_GUARDIAN_SCRIPT). */
const GUARDIAN_SCRIPT = new RegExp(process.env.ACP_GUARDIAN_SCRIPT || "guardian\\.[cm]?js", "i");

function knownProject(ports: number[], combined: string): { project: string | null; script: string | null } {
  const known = loadKnownPorts();
  for (const port of ports) {
    const found = known.get(port);
    if (found) return { project: found[0], script: found[1] };
  }
  if (/\.\/mcp\/server\.mjs/i.test(combined)) {
    return { project: "MCP plugin runtime", script: "./mcp/server.mjs" };
  }
  return { project: null, script: null };
}

function inferRequester(commandLine: string, ancestry: ProcessAncestor[], parentExited: boolean): { label: string; evidence: string } {
  const chain = ancestry.map((item) => `${item.name} ${item.commandLine}`).join(" | ");
  const combined = `${commandLine} | ${chain}`;
  if (GUARDIAN_SCRIPT.test(chain)) return { label: "Watchdog script", evidence: "ancestor command" };
  if (/\bcodex\.exe\b|ChatGPT\.exe/i.test(chain)) return { label: "Codex Desktop", evidence: "ancestor process" };
  if (/Antigravity IDE|language_server_windows/i.test(chain)) return { label: "Antigravity IDE", evidence: "ancestor process" };
  if (/\bacpx\b/i.test(combined) && /claude/i.test(combined)) return { label: "Claude via ACPX", evidence: "ancestor command" };
  if (/\.claude|claude-agent/i.test(chain)) return { label: "Claude", evidence: "ancestor command" };
  if (/openclaw/i.test(combined)) return { label: "OpenClaw startup", evidence: "command line" };
  if (GUARDIAN_SCRIPT.test(commandLine) && parentExited) return { label: "Windows Scheduled Task", evidence: "guardian parent exited" };
  if (/npm-cli|npx-cli|pnpm|yarn/i.test(chain)) return { label: "npm / package runner", evidence: "ancestor command" };
  const immediate = ancestry[0];
  if (immediate) return { label: immediate.name || "parent process", evidence: `pid ${immediate.pid}` };
  return { label: parentExited ? "Exited parent / عملية أب منتهية" : "Unknown / غير معروف", evidence: "no live ancestor" };
}

function buildAncestry(parentPid: number, byPid: Map<number, ProcessAncestor>): ProcessAncestor[] {
  const output: ProcessAncestor[] = [];
  const visited = new Set<number>();
  let cursor = parentPid;
  while (cursor > 0 && output.length < 10 && !visited.has(cursor)) {
    visited.add(cursor);
    const item = byPid.get(cursor);
    if (!item) break;
    output.push(item);
    cursor = item.parentPid;
  }
  return output;
}

function hashSignature(value: string): string {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(36);
}

function applyRuntimeSignals(rows: NodeProcessInfo[], sampledAt: number): void {
  const nextSamples = new Map<number, { startedAt: string; cpuSeconds: number; at: number }>();
  const duplicateGroups = new Map<string, NodeProcessInfo[]>();

  for (const row of rows) {
    const previous = cpuSamples.get(row.pid);
    if (previous && previous.startedAt === row.startedAt) {
      const elapsedSeconds = Math.max(0.05, (sampledAt - previous.at) / 1000);
      const cpuDelta = Math.max(0, row.cpuSeconds - previous.cpuSeconds);
      row.cpuPercent = Math.min(100, (cpuDelta / elapsedSeconds) * 100);
      row.activity = row.cpuPercent >= 1 ? "active" : row.ports.length > 0 ? "listening" : "quiet";
    } else {
      row.cpuPercent = null;
      row.activity = row.ports.length > 0 ? "listening" : "sampling";
    }
    nextSamples.set(row.pid, { startedAt: row.startedAt, cpuSeconds: row.cpuSeconds, at: sampledAt });

    const signature = [row.project ?? "", row.executablePath, row.commandLine]
      .join("|")
      .replace(/\\{2,}/g, "\\")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
    const group = duplicateGroups.get(signature) ?? [];
    group.push(row);
    duplicateGroups.set(signature, group);
  }

  cpuSamples = nextSamples;
  for (const [signature, group] of duplicateGroups) {
    if (group.length < 2) continue;
    group.sort((left, right) => left.startedAt.localeCompare(right.startedAt));
    const groupId = `dup-${hashSignature(signature)}`;
    group.forEach((row, index) => {
      row.duplicateGroupId = groupId;
      row.duplicateCount = group.length;
      row.duplicateRank = index + 1;
    });
  }
}

function parseSnapshot(raw: RawSnapshot): NodeProcessInfo[] {
  const all = arrayOf(raw.processes);
  const nodes = arrayOf(raw.nodes);
  const byPid = new Map<number, ProcessAncestor>();
  for (const item of all) {
    const pid = finiteNumber(item.pid);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    byPid.set(pid, {
      pid,
      parentPid: finiteNumber(item.parentPid),
      name: text(item.name),
      commandLine: text(item.commandLine),
    });
  }

  const now = Date.now();
  const rows = nodes.flatMap((item): NodeProcessInfo[] => {
    const pid = finiteNumber(item.pid);
    if (!Number.isInteger(pid) || pid <= 0) return [];
    const parentPid = finiteNumber(item.parentPid);
    const commandLine = text(item.commandLine);
    const started = new Date(text(item.startedAt));
    if (Number.isNaN(started.getTime())) return [];
    const ports = arrayOf(item.ports)
      .map(finiteNumber)
      .filter((port) => Number.isInteger(port) && port > 0 && port <= 65_535)
      .sort((a, b) => a - b);
    const ancestry = buildAncestry(parentPid, byPid);
    const parent = byPid.get(parentPid) ?? null;
    const parentExited = parentPid > 0 && parent === null;
    const combined = `${commandLine} ${ancestry.map((ancestor) => ancestor.commandLine).join(" ")}`;
    const extractedScript = extractScript(commandLine);
    const known = knownProject(ports, combined);
    const script = known.script ?? extractedScript;
    let project = known.project ?? projectFromPath(extractedScript);
    if (!project) {
      for (const ancestor of ancestry) {
        const ancestorScript = extractScript(ancestor.commandLine);
        project = projectFromPath(ancestorScript);
        if (project) break;
        const cd = ancestor.commandLine.match(/\bcd\s+(?:\/d\s+)?["']?([A-Za-z]:[\\/][^"';&|]+)/i);
        if (cd?.[1]) {
          project = cd[1].trim().replaceAll("/", "\\");
          break;
        }
      }
    }
    const restartManaged = GUARDIAN_SCRIPT.test(combined) || /gateway\.cmd|[\\/]gateway\b/i.test(combined);
    const canTerminate = pid !== process.pid;
    return [{
      pid,
      parentPid,
      name: text(item.name) || "node.exe",
      executablePath: text(item.executablePath),
      commandLine,
      parentName: parent?.name ?? null,
      parentCommandLine: parent?.commandLine ?? null,
      parentExited,
      ancestry,
      requester: inferRequester(commandLine, ancestry, parentExited),
      startedAt: started.toISOString(),
      uptimeMs: Math.max(0, now - started.getTime()),
      cpuSeconds: Math.max(0, finiteNumber(item.cpuSeconds)),
      cpuPercent: null,
      activity: ports.length > 0 ? "listening" : "sampling",
      memoryMb: Math.max(0, finiteNumber(item.memoryBytes) / 1_048_576),
      threads: Math.max(0, Math.trunc(finiteNumber(item.threads))),
      ports: [...new Set(ports)],
      project,
      script,
      restartManaged,
      duplicateGroupId: null,
      duplicateCount: 1,
      duplicateRank: 1,
      canTerminate,
      protectionReason: canTerminate ? null : "ACP Monitor protects its own Node process",
    }];
  }).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  applyRuntimeSignals(rows, now);
  return rows;
}

function readWindowsSnapshot(): NodeProcessInfo[] | null {
  let result: ReturnType<typeof spawnSync> | undefined;
  try {
    result = spawnSync(
      "powershell",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-Command", POWERSHELL_SNAPSHOT],
      {
        encoding: "utf8",
        windowsHide: true,
        timeout: 12_000,
        maxBuffer: 8 * 1024 * 1024,
      },
    );
  } catch {
    return null;
  }
  if (!result) return null;
  const stdout = typeof result.stdout === "string" ? result.stdout : result.stdout?.toString("utf8") ?? "";
  if (result.error || result.status !== 0 || !stdout.trim()) return null;
  try {
    return parseSnapshot(JSON.parse(stdout.replace(/^\uFEFF/, "").trim()) as RawSnapshot);
  } catch {
    return null;
  }
}

export function listNodeProcesses(options: { fresh?: boolean } = {}): NodeProcessInfo[] {
  const now = Date.now();
  if (!options.fresh && cache && now - cache.at < CACHE_TTL_MS) return cache.rows;
  if (process.platform !== "win32") return [];
  const rows = readWindowsSnapshot();
  if (rows === null) return options.fresh ? [] : (cache?.rows ?? []);
  cache = { at: now, rows };
  return rows;
}

export function terminateNodeProcess(input: { pid: number; startedAt: string }): { ok: boolean; pid: number; message: string } {
  const pid = Number(input.pid);
  if (!Number.isInteger(pid) || pid <= 0) return { ok: false, pid, message: "Invalid PID" };
  if (process.platform !== "win32") return { ok: false, pid, message: "Ending Node processes is supported only on Windows" };

  const expectedStart = new Date(input.startedAt);
  if (Number.isNaN(expectedStart.getTime())) return { ok: false, pid, message: "Invalid process start time" };
  const current = listNodeProcesses({ fresh: true }).find((item) => item.pid === pid);
  if (!current) return { ok: false, pid, message: "The Node process is no longer running" };
  if (!current.canTerminate) return { ok: false, pid, message: current.protectionReason ?? "This process is protected" };
  if (Math.abs(new Date(current.startedAt).getTime() - expectedStart.getTime()) > 2_000) {
    return { ok: false, pid, message: "PID was reused; refusing to end a different process" };
  }

  const result = spawnSync("taskkill", ["/PID", String(pid), "/F"], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 10_000,
  });
  cache = null;
  if (result.error || result.status !== 0) {
    const detail = `${result.stderr ?? ""} ${result.stdout ?? ""}`.trim();
    return { ok: false, pid, message: detail || result.error?.message || "taskkill failed" };
  }
  return { ok: true, pid, message: `Ended Node process ${pid}` };
}

export function recordNodeProcessAction(action: Omit<NodeProcessAction, "at" | "action"> & { at?: string }): void {
  try {
    mkdirSync(dirname(ACTION_LOG), { recursive: true });
    const row: NodeProcessAction = {
      at: action.at ?? new Date().toISOString(),
      action: "end",
      pid: action.pid,
      startedAt: action.startedAt,
      script: action.script,
      project: action.project,
      requester: action.requester,
      ok: action.ok,
      message: action.message,
    };
    appendFileSync(ACTION_LOG, `${JSON.stringify(row)}\n`, "utf8");
    if (statSync(ACTION_LOG).size > 512 * 1024) {
      const tail = readFileSync(ACTION_LOG, "utf8").split(/\r?\n/).filter(Boolean).slice(-250).join("\n");
      writeFileSync(ACTION_LOG, `${tail}\n`, "utf8");
    }
  } catch {
    // Audit history is best-effort and must never block process control.
  }
}

export function listNodeProcessActions(limit = 20): NodeProcessAction[] {
  if (!existsSync(ACTION_LOG)) return [];
  try {
    const rows: NodeProcessAction[] = [];
    const lines = readFileSync(ACTION_LOG, "utf8").split(/\r?\n/).filter(Boolean).slice(-Math.max(1, limit));
    for (const line of lines) {
      try {
        const action = JSON.parse(line) as NodeProcessAction;
        if (action.action === "end" && Number.isInteger(action.pid)) rows.push(action);
      } catch {
        // Skip partial/corrupt audit lines.
      }
    }
    return rows.reverse();
  } catch {
    return [];
  }
}
