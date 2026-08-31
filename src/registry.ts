/**
 * Live-agent registry + usage log — powers the monitor dashboard.
 *
 * Each running agy process registers a heartbeat file under ~/.acp/agents/<pid>.json
 * and removes it on exit; the dashboard lists the ones whose PID is still alive
 * (stale entries from crashes are pruned). Completed runs are appended to
 * ~/.acp/usage.jsonl for per-account / per-project usage stats.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const DIR = join(homedir(), ".acp");
const AGENTS = join(DIR, "agents");
const USAGE = join(DIR, "usage.jsonl");

export interface LiveAgent {
  pid: number;
  account: string;
  project: string;
  command: string;
  viewerUrl?: string;
  startedAt: string;
}

export interface UsageRecord {
  ts: string;
  account: string;
  project: string;
  command: string;
  durationSec: number;
  ok: boolean;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM"; // exists but not ours
  }
}

/**
 * Batch-fetch the real OS start time for each pid, to detect PID reuse (a dead
 * process's pid recycled by an unrelated process, which would otherwise look
 * "alive" to isAlive()). Returns a Map of pid -> Date for pids it could resolve;
 * pids it couldn't resolve (permission error, tool missing, etc.) are simply
 * absent from the map — callers must treat "absent" as "couldn't verify, don't
 * assume reuse" rather than "confirmed dead".
 */
export function getProcessStartTimes(pids: number[]): Map<number, Date> {
  const result = new Map<number, Date>();
  if (pids.length === 0) return result;
  try {
    if (process.platform === "win32") {
      const idList = pids.join(",");
      const psCmd = `Get-Process -Id ${idList} -ErrorAction SilentlyContinue | ForEach-Object { $_.Id.ToString() + "|" + $_.StartTime.ToString("o") }`;
      const res = spawnSync("powershell", ["-NoProfile", "-Command", psCmd], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 5000,
      });
      // Note: PowerShell exits non-zero if ANY of the requested ids don't exist,
      // even though -ErrorAction SilentlyContinue still lets it print the ones it
      // did find. So we must parse res.stdout regardless of res.status here —
      // gating on status === 0 would silently discard every valid result the
      // moment one pid in the batch is already gone (a common real case).
      if (res.stdout) {
        for (const line of res.stdout.split(/\r?\n/)) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          const [pidStr, dateStr] = trimmed.split("|");
          const pidNum = Number(pidStr);
          const d = new Date(dateStr ?? "");
          if (!Number.isNaN(pidNum) && !Number.isNaN(d.getTime())) {
            result.set(pidNum, d);
          }
        }
      }
    } else {
      const res = spawnSync("ps", ["-o", "pid=,lstart=", "-p", pids.join(",")], {
        encoding: "utf8",
        timeout: 5000,
      });
      // Same reasoning as the win32 branch above: some `ps` implementations
      // exit non-zero if any requested pid is gone, even while still printing
      // the ones that are found. Parse stdout regardless of exit status.
      if (res.stdout) {
        for (const line of res.stdout.split(/\r?\n/)) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          const match = trimmed.match(/^(\d+)\s+(.+)$/);
          if (!match) continue;
          const pidNum = Number(match[1]);
          const d = new Date(match[2]!);
          if (!Number.isNaN(pidNum) && !Number.isNaN(d.getTime())) {
            result.set(pidNum, d);
          }
        }
      }
    }
  } catch {
    // best-effort: return whatever we gathered (possibly empty)
  }
  return result;
}

export function registerAgent(a: LiveAgent): void {
  try {
    mkdirSync(AGENTS, { recursive: true });
    writeFileSync(join(AGENTS, `${a.pid}.json`), JSON.stringify(a), "utf8");
  } catch {
    /* best-effort */
  }
}

export function deregisterAgent(pid: number): void {
  try {
    rmSync(join(AGENTS, `${pid}.json`), { force: true });
  } catch {
    /* ignore */
  }
}

/** Live agents, with dead PIDs pruned. */
export function listLiveAgents(): LiveAgent[] {
  let names: string[] = [];
  try {
    names = readdirSync(AGENTS).filter((n) => n.endsWith(".json"));
  } catch {
    return [];
  }

  const candidates: Array<{ path: string; agent: LiveAgent }> = [];
  for (const n of names) {
    const path = join(AGENTS, n);
    try {
      const a = JSON.parse(readFileSync(path, "utf8")) as LiveAgent;
      if (isAlive(a.pid)) {
        candidates.push({ path, agent: a });
      } else {
        rmSync(path, { force: true });
      }
    } catch {
      rmSync(path, { force: true });
    }
  }

  const startTimes = getProcessStartTimes(candidates.map((c) => c.agent.pid));
  const live: LiveAgent[] = [];
  const REUSE_TOLERANCE_MS = 5000;

  for (const { path, agent: a } of candidates) {
    const actualStart = startTimes.get(a.pid);
    if (actualStart) {
      const registeredStart = new Date(a.startedAt);
      const diffMs = Math.abs(actualStart.getTime() - registeredStart.getTime());
      if (!Number.isNaN(registeredStart.getTime()) && diffMs > REUSE_TOLERANCE_MS) {
        // pid was reused by an unrelated process — prune the stale entry
        rmSync(path, { force: true });
        continue;
      }
    }
    // no reliable start time available (spawn failed etc.) — keep it, don't
    // over-prune on uncertainty; isAlive() already confirmed something with
    // this pid exists.
    live.push(a);
  }

  return live.sort((x, y) => x.startedAt.localeCompare(y.startedAt));
}


export function appendUsage(rec: Omit<UsageRecord, "ts">): void {
  try {
    mkdirSync(DIR, { recursive: true });
    appendFileSync(USAGE, JSON.stringify({ ts: new Date().toISOString(), ...rec }) + "\n", "utf8");
  } catch {
    /* best-effort */
  }
}

export function loadUsage(): UsageRecord[] {
  if (!existsSync(USAGE)) return [];
  const out: UsageRecord[] = [];
  for (const line of readFileSync(USAGE, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t) as UsageRecord);
    } catch {
      /* skip */
    }
  }
  return out;
}

export interface UsageStats {
  totalRuns: number;
  byAccount: Record<string, { runs: number; ok: number; lastUsed: string }>;
  byProject: Record<string, { runs: number; accounts: string[]; lastUsed: string }>;
}

export function summarizeUsage(items: UsageRecord[] = loadUsage()): UsageStats {
  const byAccount: UsageStats["byAccount"] = {};
  const byProject: UsageStats["byProject"] = {};
  for (const r of items) {
    const a = (byAccount[r.account] ??= { runs: 0, ok: 0, lastUsed: r.ts });
    a.runs++;
    if (r.ok) a.ok++;
    if (r.ts > a.lastUsed) a.lastUsed = r.ts;

    const p = (byProject[r.project] ??= { runs: 0, accounts: [], lastUsed: r.ts });
    p.runs++;
    if (!p.accounts.includes(r.account)) p.accounts.push(r.account);
    if (r.ts > p.lastUsed) p.lastUsed = r.ts;
  }
  return { totalRuns: items.length, byAccount, byProject };
}
