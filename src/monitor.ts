#!/usr/bin/env node
/**
 * acp monitor — a live dashboard (localhost) showing: each account's user/email
 * and state, how many sub-agents are running vs idle (against machine capacity),
 * and per-project usage. Auto-refreshes.
 *
 * Honest note: Google's real remaining quota / reset time is NOT exposed by agy,
 * so this shows OUR data — runs we recorded and the failover cooldown we set
 * when an account is marked exhausted — not Google's account quota.
 *
 * Usage: node dist/monitor.js [--no-open] [--port N]
 */

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { spawnSync, exec as execCb } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import * as os from "node:os";
import { join } from "node:path";
import { homedir } from "node:os";
import { createRequire } from "node:module";
import { promisify } from "node:util";

import { exhaustedUntil, isExhausted, loadAccounts, setActive } from "./accounts.js";
import { listLiveAgents, summarizeUsage } from "./registry.js";
import { listNodeProcessActions, listNodeProcesses, recordNodeProcessAction, terminateNodeProcess } from "./node-processes.js";
import { openBrowserTab, openConsoleWindow } from "./windowing.js";

const nodeRequire = createRequire(import.meta.url);
const execAsync = promisify(execCb);

// Silence the SQLite experimental warning
const originalEmitWarning = process.emitWarning.bind(process);
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const text = typeof warning === "string" ? warning : warning?.message ?? "";
  if (text.includes("SQLite is an experimental feature")) return;
  return (originalEmitWarning as (...a: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;

function accountEmail(home: string): string | null {
  try {
    const j = JSON.parse(readFileSync(join(home, ".gemini", "google_accounts.json"), "utf8")) as { active?: string };
    return j.active ?? null;
  } catch {
    return null;
  }
}

type MemoryStatusRow = {
  project: string;
  lessonsExists: boolean;
  lessonsMtime: string | null;
  lessonsLines: number;
  mapExists: boolean;
  mapMtime: string | null;
  fingerprintExists: boolean;
  fingerprintMtime: string | null;
  fingerprintStale: boolean;
  lastRunTs: string | null;
  lastLessonsInjected: number | null;
  lastMapInjected: number | null;
};

// buildMemoryStatus shells out to git twice per ledger project (~24 blocking
// spawnSync calls, seconds of frozen event loop). Every open dashboard tab
// polls /data every second, so without a cache the request queue grows faster
// than it drains and the server appears dead. Memory status changes rarely —
// cache it and refresh at most once per minute.
const MEMORY_STATUS_TTL_MS = 60_000;
let memoryStatusCache: { at: number; data: MemoryStatusRow[] } | null = null;

function buildMemoryStatus(): MemoryStatusRow[] {
  if (memoryStatusCache && Date.now() - memoryStatusCache.at < MEMORY_STATUS_TTL_MS) {
    return memoryStatusCache.data;
  }
  const data = computeMemoryStatus();
  memoryStatusCache = { at: Date.now(), data };
  return data;
}

function computeMemoryStatus(): MemoryStatusRow[] {
  try {
    const dbPath = join(homedir(), ".acp", "ledger.db");
    if (!existsSync(dbPath)) {
      return [];
    }

    let DatabaseSync: typeof import("node:sqlite").DatabaseSync;
    try {
      ({ DatabaseSync } = nodeRequire("node:sqlite") as typeof import("node:sqlite"));
    } catch {
      return [];
    }

    let db: import("node:sqlite").DatabaseSync;
    try {
      db = new DatabaseSync(dbPath, { readOnly: true });
    } catch {
      return [];
    }

    const projects: string[] = [];
    try {
      const rows = db.prepare("SELECT DISTINCT project FROM runs ORDER BY project").all() as Array<{ project: string }>;
      for (const r of rows) {
        if (r.project) projects.push(r.project);
      }
    } catch {
      try { db.close(); } catch {}
      return [];
    }

    const result: Array<{
      project: string;
      lessonsExists: boolean;
      lessonsMtime: string | null;
      lessonsLines: number;
      mapExists: boolean;
      mapMtime: string | null;
      fingerprintExists: boolean;
      fingerprintMtime: string | null;
      fingerprintStale: boolean;
      lastRunTs: string | null;
      lastLessonsInjected: number | null;
      lastMapInjected: number | null;
    }> = [];

    for (const project of projects) {
      try {
        const lastRow = db.prepare(
          "SELECT ts, lessons_injected, map_injected FROM runs WHERE project = ? ORDER BY id DESC LIMIT 1"
        ).get(project) as { ts: string; lessons_injected: number | null; map_injected: number | null } | undefined;

        const lessonsFile = join(project, ".acp-lessons.md");
        const mapFile = join(project, ".acp-map.md");
        const fingerprintFile = join(project, ".acp-fingerprint.json");

        let lessonsExists = false;
        let lessonsMtime: string | null = null;
        let lessonsLines = 0;
        if (existsSync(lessonsFile)) {
          lessonsExists = true;
          try {
            const st = statSync(lessonsFile);
            lessonsMtime = st.mtime.toISOString();
            const content = readFileSync(lessonsFile, "utf8");
            lessonsLines = content.split(/\r?\n/).filter(line => line.trim().startsWith("- [")).length;
          } catch {}
        }

        let mapExists = false;
        let mapMtime: string | null = null;
        if (existsSync(mapFile)) {
          mapExists = true;
          try {
            const st = statSync(mapFile);
            mapMtime = st.mtime.toISOString();
          } catch {}
        }

        let fingerprintExists = false;
        let fingerprintMtime: string | null = null;
        let fingerprintStale = false;
        if (existsSync(fingerprintFile)) {
          fingerprintExists = true;
          try {
            const st = statSync(fingerprintFile);
            fingerprintMtime = st.mtime.toISOString();

            // Check if fingerprint is stale compared to last commit
            const gitCheck = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
              cwd: project,
              encoding: "utf8",
              windowsHide: true,
              timeout: 3000,
            });
            if (gitCheck.status === 0 && !gitCheck.error) {
              const gitLog = spawnSync("git", ["log", "-1", "--format=%cI"], {
                cwd: project,
                encoding: "utf8",
                windowsHide: true,
                timeout: 3000,
              });
              if (gitLog.status === 0 && !gitLog.error && gitLog.stdout) {
                const commitDateStr = gitLog.stdout.trim();
                if (commitDateStr && fingerprintMtime) {
                  const commitMs = new Date(commitDateStr).getTime();
                  const fingerprintMs = new Date(fingerprintMtime).getTime();
                  if (!Number.isNaN(commitMs) && !Number.isNaN(fingerprintMs) && commitMs > fingerprintMs) {
                    fingerprintStale = true;
                  }
                }
              }
            }
          } catch {}
        }

        result.push({
          project,
          lessonsExists,
          lessonsMtime,
          lessonsLines,
          mapExists,
          mapMtime,
          fingerprintExists,
          fingerprintMtime,
          fingerprintStale,
          lastRunTs: lastRow ? lastRow.ts : null,
          lastLessonsInjected: lastRow ? lastRow.lessons_injected : null,
          lastMapInjected: lastRow ? lastRow.map_injected : null,
        });
      } catch {
        // fail-safe per project
      }
    }

    try {
      db.close();
    } catch {}

    return result;
  } catch {
    return [];
  }
}

function buildData(): unknown {
  const capacity = Math.max(1, Math.floor(os.cpus().length / 2));
  const live = listLiveAgents();
  const nodeProcesses = listNodeProcesses();
  const nodeActions = listNodeProcessActions(20);
  const duplicateGroupIds = new Set(nodeProcesses.map((item) => item.duplicateGroupId).filter((value): value is string => Boolean(value)));
  const usage = summarizeUsage();
  const cfg = loadAccounts();

  const accounts = cfg.accounts.map((a) => ({
    name: a.name,
    email: accountEmail(a.home) ?? a.email ?? null,
    active: cfg.active === a.name,
    state: isExhausted(a.name) ? "cooldown" : "ready",
    cooldownUntil: exhaustedUntil(a.name),
    auth: a.apiKey ? "api-key" : "oauth",
    runs: usage.byAccount[a.name]?.runs ?? 0,
    lastUsed: usage.byAccount[a.name]?.lastUsed ?? null,
  }));

  return {
    now: new Date().toISOString(),
    cores: os.cpus().length,
    capacity,
    running: live.length,
    idle: Math.max(0, capacity - live.length),
    live,
    accounts,
    projects: Object.entries(usage.byProject)
      .map(([project, v]) => ({ project, ...v }))
      .sort((x, y) => y.lastUsed.localeCompare(x.lastUsed)),
    totalRuns: usage.totalRuns,
    memory: buildMemoryStatus(),
    nodeProcesses,
    nodeActions,
    nodeSummary: {
      count: nodeProcesses.length,
      memoryMb: Math.round(nodeProcesses.reduce((sum, item) => sum + (item.memoryMb ?? 0), 0)),
      restartManaged: nodeProcesses.filter((item) => item.restartManaged).length,
      orphaned: nodeProcesses.filter((item) => item.parentExited).length,
      duplicateGroups: duplicateGroupIds.size,
      duplicateProcesses: nodeProcesses.filter((item) => item.duplicateCount > 1).length,
      duplicateExcess: nodeProcesses.reduce((sum, item) => sum + (item.duplicateRank > 1 ? 1 : 0), 0),
      active: nodeProcesses.filter((item) => item.activity === "active").length,
      listening: nodeProcesses.filter((item) => item.activity === "listening").length,
      quiet: nodeProcesses.filter((item) => item.activity === "quiet").length,
    },
  };
}


const argv = process.argv.slice(2);
const open = !argv.includes("--no-open");
const portArg = argv.indexOf("--port");
const DEFAULT_PORT = 4477;
const parsedPort = portArg >= 0 ? Number.parseInt(argv[portArg + 1] ?? "", 10) : DEFAULT_PORT;
const port = Number.isNaN(parsedPort) ? DEFAULT_PORT : parsedPort;

export const server = createServer((req, res) => {
  if (req.url === "/data") {
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-cache" });
    res.end(JSON.stringify(buildData()));
  } else if (req.url === "/end-node-process" && req.method === "POST") {
    let body = "";
    let answered = false;
    req.on("data", (chunk) => {
      if (answered) return;
      body += chunk.toString();
      if (body.length > 8_192) {
        answered = true;
        res.writeHead(413, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "Request body is too large" }));
      }
    });
    req.on("end", () => {
      if (answered) return;
      try {
        const parsed = JSON.parse(body) as { pid?: unknown; startedAt?: unknown };
        const pid = Number(parsed.pid);
        const startedAt = typeof parsed.startedAt === "string" ? parsed.startedAt : "";
        if (!Number.isInteger(pid) || pid <= 0 || !startedAt) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "A valid pid and startedAt are required" }));
          return;
        }
        const candidate = listNodeProcesses().find((item) => item.pid === pid && item.startedAt === startedAt);
        const result = terminateNodeProcess({ pid, startedAt });
        recordNodeProcessAction({
          pid,
          startedAt,
          script: candidate?.script ?? null,
          project: candidate?.project ?? null,
          requester: candidate?.requester.label ?? null,
          ok: result.ok,
          message: result.message,
        });
        res.writeHead(result.ok ? 200 : 409, { "content-type": "application/json" });
        res.end(JSON.stringify(result.ok ? result : { ...result, error: result.message }));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: message || "Invalid JSON" }));
      }
    });
  } else if (req.url === "/set-active" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk.toString();
    });
    req.on("end", () => {
      try {
        const parsed = JSON.parse(body) as { name?: string };
        const name = parsed.name;
        if (name && setActive(name)) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        } else {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid account name or account not found" }));
        }
      } catch (e) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid JSON" }));
      }
    });
  } else if (req.url === "/open-shell" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk.toString();
    });
    req.on("end", () => {
      try {
        const parsed = JSON.parse(body) as { name?: string };
        const name = parsed.name;
        const cfg = loadAccounts();
        const account = cfg.accounts.find((a) => a.name === name);
        if (!account) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "Account not found" }));
          return;
        }
        const home = account.home;
        const envCmd = `set USERPROFILE=${home}&& set HOME=${home}&& set APPDATA=${home}\\AppData\\Roaming&& set LOCALAPPDATA=${home}\\AppData\\Local&& echo Account: ${account.name} (${account.email ?? ""})&& cd /d ${process.cwd()}`;
        openConsoleWindow(envCmd);

        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch (e: any) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: e.message ?? String(e) }));
      }
    });
  } else if (req.url === "/exec" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk.toString();
    });
    req.on("end", async () => {
      try {
        const parsed = JSON.parse(body) as { name?: string; command?: string };
        const { name, command } = parsed;
        if (!name || !command) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "Account name or command is missing" }));
          return;
        }
        const cfg = loadAccounts();
        const account = cfg.accounts.find((a) => a.name === name);
        if (!account) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "Account not found" }));
          return;
        }
        const home = account.home;
        const env = {
          ...process.env,
          USERPROFILE: home,
          HOME: home,
          APPDATA: home + "\\AppData\\Roaming",
          LOCALAPPDATA: home + "\\AppData\\Local"
        };
        try {
          const { stdout, stderr } = await execAsync(command, {
            cwd: process.cwd(),
            env,
            timeout: 120000,
            maxBuffer: 10 * 1024 * 1024,
            windowsHide: true
          });
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true, code: 0, stdout, stderr }));
        } catch (err: any) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({
            ok: false,
            code: err.code ?? 1,
            stdout: err.stdout ?? "",
            stderr: err.stderr ?? String(err.message ?? err)
          }));
        }
      } catch (e: any) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "Invalid JSON" }));
      }
    });
  } else {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache, no-store, must-revalidate" });
    res.end(PAGE);
  }
});

server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    process.stdout.write(`acp monitor already running at http://127.0.0.1:${port}\n`);
    process.exit(0);
  }
  process.stderr.write(`acp monitor failed to start: ${err.message}\n`);
  process.exit(1);
});

server.listen(port, "127.0.0.1", () => {
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.stdout.write(`acp monitor running at ${url}  (Ctrl+C to stop)\n`);
  openBrowserTab(url, open);
});

const PAGE = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/><title>acp monitor</title>
<style>
:root{
  --bg:#f2f3f0;--surface:#ffffff;--surface2:#e9eae5;
  --text:#171a1f;--muted:#5b6069;--faint:#8d939d;
  --border:rgba(18,22,30,.11);
  --live:#0d9157;--livebg:#e2f5ec;
  --warn:#a16007;--warnbg:#faf0da;
  --bad:#b91c1c;--badbg:#fbe7e7;
  --run:#1d63d8;
  --shadow:0 1px 3px rgba(18,22,30,.07);
  --mono:"Cascadia Code","SF Mono",Consolas,Menlo,ui-monospace,monospace;
  --sans:"Segoe UI Variable Text","Segoe UI",-apple-system,system-ui,sans-serif;
}
@media(prefers-color-scheme:dark){:root{
  --bg:#0f1216;--surface:#161a21;--surface2:#1d232c;
  --text:#e7eaee;--muted:#98a0ab;--faint:#636b76;
  --border:rgba(255,255,255,.09);
  --live:#34d399;--livebg:rgba(52,211,153,.12);
  --warn:#fbbf24;--warnbg:rgba(251,191,36,.12);
  --bad:#f87171;--badbg:rgba(248,113,113,.14);
  --run:#6aa8f7;--shadow:none;
}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font-family:var(--sans);font-variant-numeric:tabular-nums}
.wrap{max-width:1100px;margin:0 auto;padding:22px 20px 64px}

.top{display:flex;align-items:baseline;gap:10px;margin-bottom:16px}
h1{font-family:var(--mono);font-size:15px;font-weight:600;letter-spacing:.04em;margin:0}
h1::before{content:"▮ ";color:var(--live)}
.sub{font-family:var(--mono);font-size:11px;color:var(--faint);margin-left:auto}

.cards{display:flex;background:var(--surface);border:1px solid var(--border);border-radius:10px;box-shadow:var(--shadow);margin-bottom:26px;overflow:hidden}
.card{flex:1;padding:14px 16px 12px;border-left:1px solid var(--border)}
.card:first-child{border-left:0}
.card .n{font-family:var(--mono);font-size:30px;font-weight:600;line-height:1.1}
.card .l{font-size:10px;text-transform:uppercase;letter-spacing:.12em;color:var(--faint);margin-top:3px;display:flex;align-items:center;gap:6px}
.card.hot .n{color:var(--live)}
.card.hot .l::after{content:"";width:6px;height:6px;border-radius:50%;background:var(--live);animation:pulsedot 1.6s ease-out infinite}

h2{display:flex;align-items:center;gap:10px;font-family:var(--mono);font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.14em;color:var(--faint);margin:28px 0 10px}
h2::after{content:"";flex:1;height:1px;background:var(--border)}

.agent{background:var(--surface);border:1px solid var(--border);border-radius:10px;box-shadow:var(--shadow);overflow:hidden;margin-bottom:14px;transition:border-color .15s}
.agent:hover{border-color:rgba(52,211,153,.4)}
.agent-head{display:flex;align-items:center;gap:9px;height:36px;padding:0 12px;background:var(--surface2);border-bottom:1px solid var(--border);font-family:var(--mono);font-size:12px;color:var(--muted)}
.agent-title b{font-weight:600;color:var(--text)}
.agent-meta{margin-left:auto;font-size:11px;color:var(--faint);white-space:nowrap}
.agent-frame{display:block;width:100%;height:340px;border:0;background:var(--surface)}
.agent-noview{padding:28px;text-align:center;font-family:var(--mono);font-size:12px;color:var(--faint)}
.livedot{width:8px;height:8px;border-radius:50%;background:var(--live);flex:none;animation:pulsedot 1.6s ease-out infinite}
.livedot.off{background:var(--faint);animation:none}
@keyframes pulsedot{0%{box-shadow:0 0 0 0 rgba(52,211,153,.5)}70%{box-shadow:0 0 0 7px rgba(52,211,153,0)}100%{box-shadow:0 0 0 0 rgba(52,211,153,0)}}
.empty{border:1.5px dashed var(--border);border-radius:10px;padding:44px 20px;text-align:center;font-family:var(--mono)}
.empty .big{font-size:16px;color:var(--muted);margin-bottom:6px}
.empty .hint{font-size:12px;color:var(--faint)}

.panel{background:var(--surface);border:1px solid var(--border);border-radius:10px;overflow:hidden;box-shadow:var(--shadow)}
table{width:100%;border-collapse:collapse;font-size:13px}
th{background:var(--surface2);color:var(--faint);font-family:var(--mono);font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.1em;text-align:left;padding:8px 12px}
td{text-align:left;padding:9px 12px;border-top:1px solid var(--border)}
tbody tr{transition:background .12s}
tbody tr:hover{background:var(--surface2)}

.badge,.pill{font-family:var(--mono);font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;padding:2px 7px;border-radius:4px;white-space:nowrap}
.ready{background:var(--livebg);color:var(--live)}
.ready::before{content:"";display:inline-block;width:5px;height:5px;border-radius:50%;background:var(--live);margin-right:5px;vertical-align:1px}
.cooldown{background:var(--warnbg);color:var(--warn)}
.stale{background:var(--badbg);color:var(--bad);border:1px solid rgba(185,28,28,.4)}
@media(prefers-color-scheme:dark){.stale{border:1px solid rgba(248,113,113,.4)}}
.btn-set-default{font-family:var(--mono);font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;padding:2px 7px;border-radius:4px;white-space:nowrap;background:var(--surface2);color:var(--muted);border:1px solid var(--border);cursor:pointer;margin-left:8px;transition:background .12s,color .12s,border-color .12s}
.btn-set-default:hover{background:var(--live);color:#fff;border-color:var(--live)}
.btn-open-shell{font-family:var(--mono);font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;padding:2px 7px;border-radius:4px;white-space:nowrap;background:var(--surface2);color:var(--muted);border:1px solid var(--faint);cursor:pointer;margin-left:8px;transition:background .12s,color .12s,border-color .12s}
.btn-open-shell:hover{background:var(--run);color:#fff;border-color:var(--run)}
.exec-select{background:var(--surface2);color:var(--text);border:1px solid var(--border);border-radius:4px;padding:6px 12px;font-family:var(--sans);font-size:13px;outline:none}
.exec-input{flex:1;background:var(--surface2);color:var(--text);border:1px solid var(--border);border-radius:4px;padding:6px 12px;font-family:var(--mono);font-size:13px;outline:none;transition:border-color .12s}
.exec-input:focus{border-color:var(--run)}
.exec-btn{font-family:var(--sans);font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;padding:6px 16px;border-radius:4px;background:var(--surface2);color:var(--muted);border:1px solid var(--faint);cursor:pointer;transition:background .12s,color .12s,border-color .12s}
.exec-btn:hover{background:var(--run);color:#fff;border-color:var(--run)}
.exec-btn:disabled{opacity:0.6;cursor:not-allowed}
.log-item{border-top:1px solid var(--border);padding:10px 0}
.log-item:first-child{border-top:none;padding-top:0}
.log-header{display:flex;align-items:center;gap:10px;font-family:var(--mono);font-size:12px;margin-bottom:6px}
.log-pre{background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:10px;font-family:var(--mono);font-size:12px;overflow-x:auto;white-space:pre-wrap;margin:4px 0 0}
.log-title{font-size:10px;font-weight:bold;text-transform:uppercase;color:var(--faint);margin:6px 0 2px}
.bad{background:var(--badbg);color:var(--bad)}

.process-toolbar{display:flex;align-items:center;gap:10px;margin-bottom:10px}
.process-search,.process-filter{height:36px;border:1px solid var(--border);border-radius:7px;background:var(--surface);color:var(--text);font:12px var(--mono);padding:0 11px;outline:none}
.process-search{flex:1;min-width:180px}
.process-search:focus,.process-filter:focus{border-color:var(--run)}
.process-count{margin-left:auto;color:var(--faint);font:11px var(--mono);white-space:nowrap}
.process-cards{margin-bottom:12px}
.process-cards .card{padding:10px 14px}
.process-cards .card .n{font-size:22px}
.node-attention{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin:0 0 12px}
.attention-card{display:flex;align-items:center;gap:12px;text-align:left;padding:12px 14px;border:1px solid var(--border);border-radius:9px;background:var(--surface);color:var(--text);cursor:pointer;box-shadow:var(--shadow);transition:transform .12s,border-color .12s}
.attention-card:hover{transform:translateY(-1px);border-color:var(--run)}
.attention-card strong{font:700 22px var(--mono)}
.attention-card span{display:block;color:var(--muted);font-size:12px}
.attention-card small{display:block;color:var(--faint);font:10px var(--mono);margin-top:2px}
.attention-card.warn strong{color:var(--bad)}
.attention-card.managed-card strong{color:var(--warn)}
.attention-card.live-card strong{color:var(--live)}
.process-view-toggle{display:inline-flex;border:1px solid var(--border);border-radius:7px;overflow:hidden;background:var(--surface)}
.view-button{height:34px;padding:0 12px;border:0;border-left:1px solid var(--border);background:transparent;color:var(--faint);font:600 10px var(--mono);cursor:pointer}
.view-button:first-child{border-left:0}
.view-button.active{background:var(--run);color:#fff}
.node-groups{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
.node-group{border:1px solid var(--border);border-radius:10px;background:var(--surface);box-shadow:var(--shadow);overflow:hidden}
.node-group-head{display:flex;align-items:center;gap:10px;padding:11px 13px;background:var(--surface2);border-bottom:1px solid var(--border)}
.node-group-head h3{margin:0;font:700 13px var(--mono);color:var(--text)}
.node-group-head .group-meta{margin-left:auto;color:var(--faint);font:10px var(--mono);white-space:nowrap}
.node-group-process{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px;align-items:center;padding:10px 12px;border-top:1px solid var(--border)}
.node-group-process:first-child{border-top:0}
.node-group-process:hover{background:var(--surface2)}
.node-group-main{min-width:0}
.node-group-title{display:flex;align-items:center;gap:6px;min-width:0;font:600 11px var(--mono)}
.node-group-title .script{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.node-group-sub{display:flex;flex-wrap:wrap;gap:7px;margin-top:5px;color:var(--faint);font:10px var(--mono)}
.node-group-project{margin-top:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--muted);font-size:10px}
.node-group-process details{margin-top:5px}
.node-group-process details div{max-height:90px;overflow:auto}
.node-table-panel[hidden],.node-groups[hidden]{display:none}
.history-shell{margin-top:12px;border:1px solid var(--border);border-radius:9px;background:var(--surface);box-shadow:var(--shadow);overflow:hidden}
.history-shell>summary{display:flex;align-items:center;gap:8px;padding:11px 13px;cursor:pointer;color:var(--muted);font:600 11px var(--mono);list-style:none}
.history-shell>summary::-webkit-details-marker{display:none}
.history-shell>summary::before{content:"▸";color:var(--run)}
.history-shell[open]>summary::before{content:"▾"}
.history-shell .process-table-wrap{border:0;border-top:1px solid var(--border);border-radius:0;box-shadow:none}
.process-table-wrap{overflow:auto}
#nodeProc{min-width:1060px}
#nodeProc td{vertical-align:top}
.proc-main{min-width:260px;max-width:390px}
.proc-title{display:flex;align-items:center;gap:7px;font:600 12px var(--mono);color:var(--text)}
.proc-command{margin-top:5px;color:var(--faint);font:10px/1.45 var(--mono);overflow-wrap:anywhere;max-height:44px;overflow:hidden}
.proc-project{margin-top:4px;color:var(--muted);font-size:11px;overflow-wrap:anywhere}
.proc-requester{min-width:175px;max-width:250px}
.proc-requester strong{display:block;font-size:12px;color:var(--text);margin-bottom:3px}
.proc-requester small{display:block;color:var(--faint);font:10px/1.4 var(--mono);overflow-wrap:anywhere}
.proc-time{min-width:145px;white-space:nowrap}
.proc-uptime{display:block;margin-top:4px;color:var(--run);font:600 11px var(--mono)}
.proc-resource{white-space:nowrap;font:11px/1.65 var(--mono)}
.proc-ports{max-width:125px;font:11px/1.55 var(--mono);overflow-wrap:anywhere}
.proc-end{border:1px solid rgba(185,28,28,.35);border-radius:6px;background:var(--badbg);color:var(--bad);font:600 10px var(--mono);padding:6px 10px;cursor:pointer;white-space:nowrap}
.proc-end:hover:not(:disabled){background:var(--bad);color:#fff}
.proc-end:disabled{opacity:.45;cursor:not-allowed}
.proc-action-stack{display:flex;flex-direction:column;align-items:stretch;gap:6px;min-width:64px}
.managed{background:var(--warnbg);color:var(--warn)}
.orphan{background:var(--surface2);color:var(--faint)}
.duplicate{background:var(--badbg);color:var(--bad);border:1px solid rgba(185,28,28,.25)}
.activity-active{background:var(--livebg);color:var(--live)}
.activity-listening{background:rgba(29,99,216,.1);color:var(--run)}
.activity-quiet,.activity-sampling{background:var(--surface2);color:var(--faint)}
.proc-details{margin-top:5px;color:var(--faint);font:10px/1.5 var(--mono)}
.proc-details summary{cursor:pointer;color:var(--run);user-select:none}
.proc-details div{margin-top:5px;padding:7px;border:1px solid var(--border);border-radius:5px;background:var(--bg);overflow-wrap:anywhere}
.proc-details b{color:var(--muted)}
.history-ok{color:var(--live)}
.history-fail{color:var(--bad)}
#nodeHistory td{font-size:12px}
.proc-feedback{min-height:16px;margin:7px 0 0;color:var(--faint);font:11px var(--mono)}
@media(max-width:720px){.process-toolbar{align-items:stretch;flex-direction:column}.process-count{margin-left:0}.process-search,.process-filter{width:100%}}
@media(max-width:900px){.node-groups{grid-template-columns:1fr}.node-attention{grid-template-columns:1fr}}

body.node-only .wrap{max-width:1400px;padding-top:14px}
body.node-only .system-cards,body.node-only .legacy-monitor{display:none}
body.node-only .top{margin-bottom:12px}
body.node-only h2{margin-top:18px}

.mono{font-family:var(--mono);font-size:12px;font-weight:500;color:var(--text)}
.dim{color:var(--faint)}
.note{font-size:11px;color:var(--faint);margin-top:22px}
.note::before{content:"⌁ ";color:var(--warn)}
</style></head><body><div class="wrap">
<div class="top"><h1>acp monitor</h1><div class="sub" id="sub">…</div></div>
<div class="cards system-cards" id="cards"></div>
<h2 id="node-processes">node processes · عمليات Node</h2>
<div class="cards process-cards" id="nodeCards"></div>
<div class="node-attention" id="nodeAttention"></div>
<div class="process-toolbar">
  <input id="nodeSearch" class="process-search" type="search" placeholder="ابحث بالملف أو المشروع أو PID أو الجهة التي شغّلته" autocomplete="off"/>
  <select id="nodeFilter" class="process-filter" aria-label="تصفية عمليات Node">
    <option value="all">كل العمليات</option>
    <option value="managed">تعمل بإعادة تشغيل تلقائي</option>
    <option value="duplicate">العمليات المكررة</option>
    <option value="orphan">العملية الأب انتهت</option>
    <option value="protected">العمليات المحمية</option>
    <option value="active">نشطة الآن</option>
    <option value="quiet">هادئة / تنتظر</option>
    <option value="acp">ACP / Agents</option>
    <option value="dev">خوادم التطوير</option>
  </select>
  <select id="nodeSort" class="process-filter" aria-label="فرز عمليات Node">
    <option value="oldest">الأقدم أولًا</option>
    <option value="duplicates">المكررة أولًا</option>
    <option value="memory">الأعلى RAM</option>
    <option value="cpu">الأعلى CPU الآن</option>
    <option value="newest">الأحدث أولًا</option>
  </select>
  <div class="process-view-toggle" role="group" aria-label="طريقة عرض عمليات Node">
    <button type="button" class="view-button active" data-view="grouped">مجموعات</button>
    <button type="button" class="view-button" data-view="table">جدول</button>
  </div>
  <span class="process-count" id="nodeCount">…</span>
</div>
<div class="node-groups" id="nodeGroups"></div>
<div class="panel process-table-wrap node-table-panel" id="nodeTablePanel" hidden><table id="nodeProc"><thead><tr><th>process / project</th><th>requested by</th><th>started / uptime</th><th>resources</th><th>ports</th><th>action</th></tr></thead><tbody></tbody></table></div>
<p class="proc-feedback" id="nodeFeedback">زر End ينهي العملية المحددة فقط. العمليات المُدارة قد يعيدها الحارس تلقائيًا.</p>
<details class="history-shell"><summary>end activity · سجل الإنهاء <span class="pill orphan" id="nodeHistoryCount">0</span></summary><div class="panel process-table-wrap"><table id="nodeHistory"><thead><tr><th>time</th><th>process</th><th>project / requester</th><th>result</th></tr></thead><tbody></tbody></table></div></details>
<div class="legacy-monitor" id="legacyMonitor">
<h2>running agents</h2><div id="liveCards"></div>
<h2>accounts (users)</h2><div class="panel"><table id="acc"><thead><tr><th>account</th><th>email</th><th>state</th><th>auth</th><th>runs</th><th>last used</th></tr></thead><tbody></tbody></table></div>
<h2>account shell / exec console</h2>
<div class="panel" style="padding: 16px;">
  <div style="display: flex; gap: 10px; margin-bottom: 12px;">
    <select id="execAccount" class="exec-select"></select>
    <input id="execCmd" class="exec-input" type="text" placeholder="Command to run in chosen account environment (e.g. acp account status)" onkeydown="if(event.key==='Enter') execRun()">
    <button id="execBtn" type="button" onclick="execRun()" class="exec-btn">Run</button>
  </div>
  <div id="execHistory"></div>
</div>
<h2>project memory</h2><div class="panel"><table id="mem"><thead><tr><th>project</th><th>lessons</th><th>map</th><th>fingerprint</th><th>last injected</th></tr></thead><tbody></tbody></table></div>
<h2>usage by project</h2><div class="panel"><table id="proj"><thead><tr><th>project</th><th>runs</th><th>accounts</th><th>last used</th></tr></thead><tbody></tbody></table></div>
<div class="note">Google's real remaining quota / reset time isn't exposed by agy. "cooldown" = the failover pause acp sets when an account is marked exhausted, not Google's quota.</div>
</div>
</div>
<script>
const nodeOnlyView=new URLSearchParams(location.search).get("view")==="node";
if(nodeOnlyView){document.body.classList.add("node-only");document.querySelector("h1").textContent="node operations";}
const base=s=>(s||"").replace(/^.*[\\\\/]/,"")||s;
const t=s=>s?new Date(s).toLocaleString():"—";
function row(cells){return "<tr>"+cells.map(c=>"<td>"+c+"</td>").join("")+"</tr>";}
const esc=s=>String(s??"").replace(/[&<>"']/g,ch=>"&#"+ch.charCodeAt(0)+";");
let nodeRows=[];
let nodeActions=[];
let nodeViewMode="grouped";
function duration(ms){
  ms=Math.max(0,Number(ms)||0);
  const sec=Math.floor(ms/1000),days=Math.floor(sec/86400),hours=Math.floor(sec%86400/3600),mins=Math.floor(sec%3600/60),secs=sec%60;
  if(days)return days+"d "+hours+"h";
  if(hours)return hours+"h "+mins+"m";
  if(mins)return mins+"m "+secs+"s";
  return secs+"s";
}
function requesterOf(p){
  if(typeof p.requester==="string")return p.requester;
  return p.requester?.label||p.requesterLabel||p.requestedBy||p.parent?.name||p.parentName||"unknown / غير معروف";
}
function ancestryOf(p){
  const chain=Array.isArray(p.ancestry)?p.ancestry:[];
  return chain.map(x=>typeof x==="string"?x:((x.name||"process")+" pid "+(x.pid??"?"))).join(" ← ");
}
function processMatchesFilter(p,filter){
  if(filter==="managed")return Boolean(p.restartManaged);
  if(filter==="duplicate")return Number(p.duplicateCount||1)>1;
  if(filter==="orphan")return Boolean(p.parentExited);
  if(filter==="protected")return p.canTerminate===false;
  if(filter==="active")return p.activity==="active"||p.activity==="listening";
  if(filter==="quiet")return p.activity==="quiet"||p.activity==="sampling";
  const text=[p.commandLine,p.script,p.project,requesterOf(p),ancestryOf(p)].join(" ").toLowerCase();
  if(filter==="acp")return /acp|agent|codex|claude|gemini|antigravity|mcp/.test(text);
  if(filter==="dev")return /npm run dev|vite|vinext|next dev|webpack|tsx/.test(text);
  return true;
}
function sortNodeProcesses(items,sort){
  const rows=[...items];
  if(sort==="newest")return rows.sort((a,b)=>String(b.startedAt).localeCompare(String(a.startedAt)));
  if(sort==="memory")return rows.sort((a,b)=>Number(b.memoryMb||0)-Number(a.memoryMb||0));
  if(sort==="cpu")return rows.sort((a,b)=>Number(b.cpuPercent||0)-Number(a.cpuPercent||0));
  if(sort==="duplicates")return rows.sort((a,b)=>Number(b.duplicateCount||1)-Number(a.duplicateCount||1)||Number(a.duplicateRank||1)-Number(b.duplicateRank||1)||String(a.startedAt).localeCompare(String(b.startedAt)));
  return rows.sort((a,b)=>String(a.startedAt).localeCompare(String(b.startedAt)));
}
function activityLabel(p){
  if(p.activity==="active")return "active";
  if(p.activity==="listening")return "listening";
  if(p.activity==="quiet")return "quiet";
  return "sampling";
}
function familyOf(p){
  const requester=requesterOf(p);
  const combined=[requester,p.project,p.commandLine].join(" ");
  if(/Codex|ChatGPT/i.test(combined))return "Codex Desktop";
  if(/Antigravity IDE|language_server/i.test(combined))return "Antigravity IDE";
  if(/Watchdog|Scheduled Task/i.test(combined))return "Managed services";
  if(/Claude|antigravity-acp/i.test(combined))return "Claude / ACP";
  if(/npm|npx|vite|vinext|webpack/i.test(combined))return "Development Tools";
  return base(p.project)||requester||"Other Node";
}
function renderNodeAttention(){
  const duplicateGroups=new Set(nodeRows.filter(p=>p.duplicateGroupId).map(p=>p.duplicateGroupId)).size;
  const duplicateExcess=nodeRows.filter(p=>Number(p.duplicateRank||1)>1).length;
  const managed=nodeRows.filter(p=>p.restartManaged).length;
  const orphaned=nodeRows.filter(p=>p.parentExited).length;
  const cards=[
    ["duplicate",duplicateGroups,"مجموعات مكررة",duplicateExcess+" نسخ إضافية",duplicateGroups?"warning":"live"],
    ["managed",managed,"تعود تلقائيًا","يديرها حارس أو مهمة مجدولة",managed?"managed":"live"],
    ["orphan",orphaned,"أصلها انتهى","قد تحتاج مراجعة",orphaned?"warning":"live"]
  ];
  document.getElementById("nodeAttention").innerHTML=cards.map(c=>"<button type='button' class='attention-card "+c[4]+"' data-filter='"+c[0]+"'><strong>"+c[1]+"</strong><span>"+c[2]+"</span><small>"+c[3]+"</small></button>").join("");
}
function renderNodeGroups(visible){
  const grouped=new Map();
  visible.forEach(p=>{const key=familyOf(p);if(!grouped.has(key))grouped.set(key,[]);grouped.get(key).push(p);});
  const groups=[...grouped.entries()].sort((a,b)=>{
    const score=items=>items.reduce((n,p)=>n+(Number(p.duplicateCount||1)>1?4:0)+(p.restartManaged?2:0)+(p.parentExited?1:0),0);
    return score(b[1])-score(a[1])||b[1].length-a[1].length||a[0].localeCompare(b[0]);
  });
  document.getElementById("nodeGroups").innerHTML=groups.map(([name,items])=>{
    const memory=Math.round(items.reduce((sum,p)=>sum+Number(p.memoryMb||0),0));
    const warnings=items.filter(p=>Number(p.duplicateCount||1)>1||p.restartManaged||p.parentExited).length;
    const body=items.map(p=>{
      const command=p.commandLine||p.command||"node";
      const script=p.script||base(command)||"node";
      const started=p.startedAt||"";
      const activity=activityLabel(p);
      const ports=(p.ports||[]).map(x=>typeof x==="object"?(x.port??x.localPort??""):x).filter(Boolean);
      const badges="<span class='pill activity-"+activity+"'>"+activity+(p.cpuPercent===null||p.cpuPercent===undefined?"":" "+Number(p.cpuPercent).toFixed(1)+"%")+"</span>"+
        (Number(p.duplicateCount||1)>1?" <span class='pill duplicate'>×"+esc(p.duplicateCount)+" #"+esc(p.duplicateRank)+"</span>":"")+
        (p.restartManaged?" <span class='pill managed'>auto-restart</span>":"")+(p.parentExited?" <span class='pill orphan'>parent exited</span>":"");
      const canEnd=p.canTerminate!==false;
      return "<article class='node-group-process'><div class='node-group-title'><span class='livedot"+(activity==="quiet"||activity==="sampling"?" off":"")+"'></span><strong>"+esc(script)+"</strong> "+badges+"</div>"+
        "<div class='node-group-sub'><span>PID "+esc(p.pid)+"</span><span class='proc-uptime' data-started-at='"+esc(started)+"'>"+duration(Date.now()-new Date(started).getTime())+"</span><span>RAM "+esc(Number(p.memoryMb||0).toFixed(0))+" MB</span><span>CPU "+(p.cpuPercent===null||p.cpuPercent===undefined?"…":esc(Number(p.cpuPercent).toFixed(1))+"%")+"</span>"+(ports.length?"<span>port "+ports.map(esc).join(", ")+"</span>":"")+"</div>"+
        "<div class='node-group-project'>"+esc(p.project||"unknown project")+"<small>طلبها: "+esc(requesterOf(p))+"</small></div>"+
        "<details class='proc-details'><summary>التفاصيل والأمر الكامل</summary><div>"+esc(command)+"<br><b>بدأت:</b> "+esc(t(started))+"<br><b>ancestry:</b> "+esc(ancestryOf(p)||"—")+"</div></details>"+
        "<div class='proc-action-stack'><button type='button' class='proc-end' data-pid='"+esc(p.pid)+"' data-started-at='"+esc(started)+"' "+(canEnd?"":"disabled")+" title='"+esc(p.protectionReason||"End selected process")+"'>End</button>"+(canEnd?"":"<span class='pill orphan'>protected</span>")+"</div></article>";
    }).join("");
    return "<section class='node-group'><header><div><h3>"+esc(name)+"</h3><span>"+items.length+" processes · "+memory+" MB</span></div>"+(warnings?"<span class='pill duplicate'>"+warnings+" تحتاج انتباه</span>":"<span class='pill ready'>طبيعي</span>")+"</header>"+body+"</section>";
  }).join("")||"<div class='empty'><div class='big'>لا توجد عمليات مطابقة</div><div class='hint'>غيّر البحث أو الفلتر.</div></div>";
}
function renderNodeProcesses(){
  const query=document.getElementById("nodeSearch").value.trim().toLowerCase();
  const filter=document.getElementById("nodeFilter").value;
  const sort=document.getElementById("nodeSort").value;
  const visible=sortNodeProcesses(nodeRows.filter(p=>{
    if(!processMatchesFilter(p,filter))return false;
    if(!query)return true;
    return [p.pid,p.parentPid,p.commandLine,p.script,p.project,requesterOf(p),ancestryOf(p),...(p.ports||[])].join(" ").toLowerCase().includes(query);
  }),sort);
  const totalRam=Math.round(nodeRows.reduce((sum,p)=>sum+Number(p.memoryMb||0),0));
  const managed=nodeRows.filter(p=>p.restartManaged).length;
  const duplicateGroups=new Set(nodeRows.filter(p=>p.duplicateGroupId).map(p=>p.duplicateGroupId)).size;
  const duplicateExcess=nodeRows.filter(p=>Number(p.duplicateRank||1)>1).length;
  const ended=nodeActions.filter(item=>item.ok).length;
  document.getElementById("nodeCards").innerHTML=cardEl(nodeRows.length,"node processes",nodeRows.length>0)+cardEl(totalRam+" MB","working set")+cardEl(duplicateGroups,"duplicate groups")+cardEl(managed,"auto restart")+cardEl(ended,"recently ended");
  renderNodeAttention();
  document.getElementById("nodeCount").textContent="عرض "+visible.length+" من "+nodeRows.length+(duplicateGroups?" · "+duplicateGroups+" مجموعات / "+duplicateExcess+" نسخ إضافية":"");
  document.getElementById("nodeGroups").hidden=nodeViewMode!=="grouped";
  document.getElementById("nodeTablePanel").hidden=nodeViewMode!=="table";
  renderNodeGroups(visible);
  document.querySelector("#nodeProc tbody").innerHTML=visible.map(p=>{
    const command=p.commandLine||p.command||"node";
    const script=p.script||base(command)||"node";
    const project=p.project||"المشروع غير معروف من نظام Windows";
    const requester=requesterOf(p);
    const parentPid=p.parentPid||p.parent?.pid;
    const parentName=p.parentName||p.parent?.name;
    const parent=parentName?(parentName+" · pid "+(parentPid||"?")):(parentPid?("parent pid "+parentPid+(p.parentExited?" (exited)":"")):"");
    const chain=ancestryOf(p);
    const ports=(p.ports||[]).map(x=>typeof x==="object"?(x.port??x.localPort??""):x).filter(Boolean);
    const started=p.startedAt||"";
    const activity=activityLabel(p);
    const activityBadge=" <span class='pill activity-"+activity+"'>"+activity+(p.cpuPercent===null||p.cpuPercent===undefined?"":(" "+Number(p.cpuPercent).toFixed(1)+"%"))+"</span>";
    const duplicateBadge=Number(p.duplicateCount||1)>1?(" <span class='pill duplicate'>duplicate ×"+esc(p.duplicateCount)+" · "+(Number(p.duplicateRank)===1?"oldest":"copy #"+esc(p.duplicateRank))+"</span>"):"";
    const badges=activityBadge+duplicateBadge+(p.restartManaged?" <span class='pill managed'>auto-restart</span>":"")+(p.parentExited?" <span class='pill orphan'>parent exited</span>":"");
    const canEnd=p.canTerminate!==false;
    const reason=p.protectionReason||"";
    const details="<details class='proc-details'><summary>full details</summary><div><b>executable</b> "+esc(p.executablePath||"—")+"<br><b>parent command</b> "+esc(p.parentCommandLine||"—")+"<br><b>ancestry</b> "+esc(chain||"—")+(p.duplicateGroupId?"<br><b>duplicate group</b> "+esc(p.duplicateGroupId):"")+"</div></details>";
    return row([
      "<div class='proc-main'><div class='proc-title'><span class='livedot"+(activity==="quiet"||activity==="sampling"?" off":"")+"'></span>"+esc(script)+" <span class='dim'>pid "+esc(p.pid)+"</span>"+badges+"</div><div class='proc-project'>"+esc(project)+"</div><div class='proc-command' title='"+esc(command)+"'>"+esc(command)+"</div>"+details+"</div>",
      "<div class='proc-requester'><strong>"+esc(requester)+"</strong><small>"+esc(parent||"parent unavailable")+"</small>"+(chain?"<small title='"+esc(chain)+"'>"+esc(chain)+"</small>":"")+"</div>",
      "<div class='proc-time'>"+esc(t(started))+"<span class='proc-uptime' data-started-at='"+esc(started)+"'>"+duration(Date.now()-new Date(started).getTime())+"</span></div>",
      "<div class='proc-resource'>RAM "+esc(Number(p.memoryMb||0).toFixed(1))+" MB<br>CPU total "+esc(Number(p.cpuSeconds||0).toFixed(1))+" s<br>CPU now "+(p.cpuPercent===null||p.cpuPercent===undefined?"sampling":esc(Number(p.cpuPercent).toFixed(1))+"%")+"<br>threads "+esc(p.threads??"—")+"</div>",
      "<div class='proc-ports'>"+(ports.length?ports.map(port=>"<span class='pill ready'>:"+esc(port)+"</span>").join(" "):"<span class='dim'>no listener</span>")+"</div>",
      "<div class='proc-action-stack'><button type='button' class='proc-end' data-pid='"+esc(p.pid)+"' data-started-at='"+esc(started)+"' "+(canEnd?"":"disabled")+" title='"+esc(reason||"End selected process")+"'>End</button>"+(canEnd?"":"<span class='pill orphan'>protected</span>")+"</div>"
    ]);
  }).join("")||row(["<span class='dim'>لا توجد عمليات مطابقة.</span>","","","","",""]);
}
function renderNodeHistory(){
  document.getElementById("nodeHistoryCount").textContent=nodeActions.length;
  document.querySelector("#nodeHistory tbody").innerHTML=nodeActions.map(item=>row([
    "<span class='mono'>"+esc(t(item.at))+"</span>",
    "<span class='mono'>pid "+esc(item.pid)+" · "+esc(item.script||"unknown process")+"</span>",
    esc(item.project||"—")+"<br><span class='dim'>"+esc(item.requester||"unknown requester")+"</span>",
    "<span class='pill "+(item.ok?"ready":"bad")+"'>"+(item.ok?"ended":"rejected")+"</span> <span class='"+(item.ok?"history-ok":"history-fail")+"'>"+esc(item.message||"")+"</span>"
  ])).join("")||row(["<span class='dim'>لا توجد عمليات إنهاء مسجلة بعد.</span>","","",""]);
}
function updateProcessUptimes(){
  document.querySelectorAll(".proc-uptime[data-started-at]").forEach(el=>{
    const at=new Date(el.dataset.startedAt).getTime();
    if(Number.isFinite(at))el.textContent=duration(Date.now()-at);
  });
}
async function endNodeProcess(btn){
  const pid=Number(btn.dataset.pid),startedAt=btn.dataset.startedAt||"";
  const item=nodeRows.find(p=>Number(p.pid)===pid&&p.startedAt===startedAt);
  if(!item)return;
  const warning=(item.restartManaged?"\\n\\nتنبيه: هذه العملية مُدارة وقد يعيد الحارس تشغيلها.":"")+(Number(item.duplicateCount||1)>1?"\\n\\nهذه واحدة من مجموعة مكررة عددها "+item.duplicateCount+"، وترتيبها "+item.duplicateRank+" من الأقدم للأحدث.":"");
  if(!confirm("إنهاء عملية Node رقم "+pid+"؟\\n"+(item.script||item.commandLine||"")+warning))return;
  btn.disabled=true;
  const feedback=document.getElementById("nodeFeedback");
  feedback.textContent="جاري إنهاء pid "+pid+"…";
  try{
    const res=await fetch("/end-node-process",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({pid,startedAt})});
    const data=await res.json();
    if(!res.ok||!data.ok)throw new Error(data.error||data.message||"تعذر إنهاء العملية");
    feedback.textContent="تم إنهاء pid "+pid+" بأمان.";
    await tick();
  }catch(error){
    feedback.textContent="فشل إنهاء pid "+pid+": "+(error.message||String(error));
    btn.disabled=false;
  }
}
function setDefaultAccount(btn){
  fetch("/set-active",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({name:btn.dataset.acct})}).then(r=>r.ok&&tick());
}
function openShell(name){
  fetch("/open-shell",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({name})});
}
let execLog = [];
async function execRun() {
  const name = document.getElementById("execAccount").value;
  const command = document.getElementById("execCmd").value.trim();
  if (!command) return;
  const btn = document.getElementById("execBtn");
  btn.disabled = true;
  btn.textContent = "...";
  try {
    const res = await fetch("/exec", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, command })
    });
    const data = await res.json();
    execLog.unshift({
      account: name,
      command,
      code: data.code ?? (data.ok ? 0 : 1),
      stdout: data.stdout ?? "",
      stderr: data.stderr ?? "",
      at: new Date().toISOString()
    });
    if (execLog.length > 20) execLog = execLog.slice(0, 20);
    renderExecHistory();
  } catch (e) {
    execLog.unshift({
      account: name,
      command,
      code: 1,
      stdout: "",
      stderr: e.message ?? String(e),
      at: new Date().toISOString()
    });
    if (execLog.length > 20) execLog = execLog.slice(0, 20);
    renderExecHistory();
  } finally {
    btn.disabled = false;
    btn.textContent = "Run";
  }
}
function renderExecHistory() {
  const container = document.getElementById("execHistory");
  if (execLog.length === 0) {
    container.innerHTML = "<div class='dim' style='font-size: 12px; font-family: var(--mono); padding: 8px 0;'>No execution history yet.</div>";
    return;
  }
  container.innerHTML = execLog.map(item => {
    const badgeClass = item.code === 0 ? "ready" : "bad";
    const badgeText = item.code === 0 ? "exit 0" : "exit " + item.code;
    let content = "";
    if (item.stdout && item.stderr) {
      content = "<div class='log-title'>STDOUT</div>" + item.stdout + "<div class='log-title'>STDERR</div>" + item.stderr;
    } else if (item.stdout) {
      content = item.stdout;
    } else if (item.stderr) {
      content = item.stderr;
    } else {
      content = "<span class='dim'>[no output]</span>";
    }
    return "<div class='log-item'>" +
      "<div class='log-header'>" +
        "<span class='mono'><b>" + item.account + "</b></span>" +
        " <span class='dim'>·</span>" +
        " <span class='mono' style='color: var(--muted); flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;'>" + item.command + "</span>" +
        " <span class='pill " + badgeClass + "'>" + badgeText + "</span>" +
        " <span class='dim'>" + new Date(item.at).toLocaleTimeString() + "</span>" +
      "</div>" +
      "<pre class='log-pre'>" + content + "</pre>" +
    "</div>";
  }).join("");
}
async function tick(){
  let d; try{ d=await (await fetch("/data")).json(); }catch(e){ return; }
  document.title = (d.running>0 ? "("+d.running+") " : "") + "acp monitor";
  document.getElementById("sub").textContent="updated "+new Date(d.now).toLocaleTimeString()+" · "+d.cores+" cores";
  document.getElementById("cards").innerHTML=
    cardEl(d.running,"running",d.running>0)+cardEl(d.idle,"idle")+cardEl(d.capacity,"capacity")+cardEl(d.accounts.length,"accounts")+cardEl(d.totalRuns,"total runs");
  nodeRows=Array.isArray(d.nodeProcesses)?d.nodeProcesses:[];
  nodeActions=Array.isArray(d.nodeActions)?d.nodeActions:[];
  renderNodeProcesses();
  renderNodeHistory();
  
  document.querySelector("#acc tbody").innerHTML=d.accounts.map(a=>row([
    a.name+(a.active?" <span class='pill ready'>active</span>":" <button type='button' class='btn-set-default' data-acct='"+a.name+"' onclick='setDefaultAccount(this)'>set default</button>") + " <button type='button' class='btn-open-shell' onclick='openShell(\\""+a.name+"\\")'>⌘ shell</button>", a.email||"<span class='dim'>—</span>",
    "<span class='pill "+a.state+"'>"+a.state+(a.cooldownUntil?" → "+t(a.cooldownUntil):"")+"</span>",
    a.auth, a.runs, "<span class='dim'>"+t(a.lastUsed)+"</span>"])).join("")||row(["<span class='dim'>no accounts — acp account add …</span>","","","","",""]);

  const sel = document.getElementById("execAccount");
  const prevVal = sel.value;
  const html = d.accounts.map(a => "<option value='" + a.name + "'>" + a.name + (a.email ? " · " + a.email : "") + "</option>").join("");
  if (sel.innerHTML !== html) {
    sel.innerHTML = html;
    if (d.accounts.some(a => a.name === prevVal)) {
      sel.value = prevVal;
    }
  }
  
  document.getElementById("liveCards").innerHTML = d.live.length ? d.live.map(a=>
    "<div class='agent'><div class='agent-head'><span class='livedot"+(a.viewerUrl?"":" off")+"'></span><span class='agent-title'>"+a.account+" · <b>"+base(a.project)+"</b></span><span class='agent-meta'>"+a.command+" · pid "+a.pid+" · "+t(a.startedAt)+"</span></div>"+
    (a.viewerUrl ? "<iframe class='agent-frame' src='"+a.viewerUrl+"'></iframe>" : "<div class='agent-noview'>▢ no live viewer for this process</div>")+
    "</div>"
  ).join("") : "<div class='empty'><div class='big'>◇ no agents running</div><div class='hint'>acp '&lt;task&gt;' — agents appear here live</div></div>";

  document.querySelector("#mem tbody").innerHTML=d.memory.map(m=>row([
    "<span class='mono'>"+base(m.project)+"</span>",
    m.lessonsExists ? (m.lessonsLines+" lines · "+t(m.lessonsMtime)) : "<span class='dim'>none</span>",
    m.mapExists ? t(m.mapMtime) : "<span class='dim'>none</span>",
    m.fingerprintExists ? (t(m.fingerprintMtime)+(m.fingerprintStale?" <span class='badge stale'>STALE</span>":"")) : "<span class='dim'>none</span>",
    m.lastRunTs ? (t(m.lastRunTs)+" · lessons:"+(m.lastLessonsInjected??0)+" map:"+(m.lastMapInjected??0)) : "<span class='dim'>—</span>"
  ])).join("")||row(["<span class='dim'>no projects in ledger yet</span>","","","",""]);

  document.querySelector("#proj tbody").innerHTML=d.projects.map(p=>row([
    "<span class='mono'>"+base(p.project)+"</span>", p.runs, p.accounts.join(", "), "<span class='dim'>"+t(p.lastUsed)+"</span>"])).join("")||row(["<span class='dim'>no usage yet</span>","","",""]);
}
function cardEl(n,l,hot){return "<div class='card"+(hot?" hot":"")+"'><div class='n'>"+n+"</div><div class='l'>"+l+"</div></div>";}
document.getElementById("nodeSearch").addEventListener("input",renderNodeProcesses);
document.getElementById("nodeFilter").addEventListener("change",renderNodeProcesses);
document.getElementById("nodeSort").addEventListener("change",renderNodeProcesses);
document.querySelectorAll(".view-button").forEach(btn=>btn.addEventListener("click",()=>{
  nodeViewMode=btn.dataset.view;
  document.querySelectorAll(".view-button").forEach(item=>item.classList.toggle("active",item===btn));
  renderNodeProcesses();
}));
document.getElementById("nodeAttention").addEventListener("click",event=>{
  const btn=event.target.closest("[data-filter]");
  if(!btn)return;
  document.getElementById("nodeFilter").value=btn.dataset.filter;
  renderNodeProcesses();
});
function handleNodeEnd(event){
  const btn=event.target.closest(".proc-end");
  if(btn&&!btn.disabled)endNodeProcess(btn);
}
document.querySelector("#nodeProc tbody").addEventListener("click",handleNodeEnd);
document.getElementById("nodeGroups").addEventListener("click",handleNodeEnd);
renderExecHistory();
tick(); setInterval(tick,2000); setInterval(updateProcessUptimes,1000);
</script></body></html>`;
