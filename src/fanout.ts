#!/usr/bin/env node
/**
 * fanout — run several Antigravity sub-agents in parallel, one per task.
 *
 * Each task runs in its own isolated working copy (a git worktree by default,
 * or its own directory), capped by a capacity-aware concurrency limit. All
 * agents stream into ONE live dashboard (a column each); a combined summary +
 * merge hints are printed at the end.
 *
 * Usage:
 *   node dist/fanout.js --task "do A" --task "do B" [options]
 *   node dist/fanout.js tasks.json [options]      # JSON: [{id?,task,cwd?},…]
 * Options:
 *   --concurrency N   parallel agents (default: max(1, floor(cores/2)))
 *   --worktree        isolate each task in a git worktree of cwd (cwd = git repo)
 *   --base <dir>      base dir for per-task subdirs when not using worktrees
 *   --cleanup         remove created worktrees after the run
 *   --open            auto-open the dashboard in a browser tab (off by default)
 *   --no-open         explicitly keep the dashboard tab closed (default)
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as os from "node:os";
import { join, resolve as resolvePath } from "node:path";
import * as acp from "@agentclientprotocol/sdk";

import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { AntigravityAgent } from "./agent.js";
import { startDashboard, type LaneEvent } from "./dashboard.js";
import { recordTurn, resolveSessionForAccount } from "./session-store.js";
import { resolveActive } from "./accounts.js";
import { openBrowserTab } from "./windowing.js";

interface Task {
  id: string;
  task: string;
  cwd?: string;
  /** Persistent session name; a re-run with the same name resumes that agy conversation. */
  session?: string;
}

interface TaskResult {
  id: string;
  status: "ok" | "failed" | "auth_required";
  files: string[];
  tools: number;
  summary: string;
  cwd: string;
  branch?: string;
}

class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];
  constructor(private readonly max: number) {}
  async acquire(): Promise<void> {
    if (this.active < this.max) {
      this.active++;
      return;
    }
    await new Promise<void>((r) => this.waiters.push(r));
  }
  release(): void {
    const next = this.waiters.shift();
    if (next) next();
    else this.active--;
  }
}

function parseArgs(argv: string[]): {
  tasks: Task[];
  concurrency: number;
  worktree: boolean;
  base: string;
  cleanup: boolean;
  open: boolean;
} {
  const inline: string[] = [];
  let file: string | undefined;
  let concurrency = Math.max(1, Math.floor(os.cpus().length / 2));
  let worktree = false;
  let cleanup = false;
  let open = false;
  let base = process.cwd();

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--task") inline.push(argv[++i] ?? "");
    else if (a === "--concurrency") concurrency = Math.max(1, Number.parseInt(argv[++i] ?? "", 10) || concurrency);
    else if (a === "--worktree") worktree = true;
    else if (a === "--cleanup") cleanup = true;
    else if (a === "--open") open = true;
    else if (a === "--no-open") open = false;
    else if (a === "--base") base = resolvePath(argv[++i] ?? ".");
    else if (!a.startsWith("--")) file = a;
  }

  const tasks: Task[] = [];
  if (file) {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Array<{
      id?: string;
      task: string;
      cwd?: string;
      session?: string;
    }>;
    parsed.forEach((t, i) => tasks.push({ id: t.id || `t${i + 1}`, task: t.task, cwd: t.cwd, session: t.session }));
  }
  const offset = tasks.length;
  inline.forEach((t, i) => tasks.push({ id: `task${offset + i + 1}`, task: t }));
  return { tasks, concurrency, worktree, base, cleanup, open };
}

function git(repo: string, args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
}
function isGitRepo(dir: string): boolean {
  try {
    git(dir, ["rev-parse", "--is-inside-work-tree"]);
    return true;
  } catch {
    return false;
  }
}


function fileFromUpdate(u: Record<string, unknown>): string | undefined {
  const locs = u.locations as Array<{ path?: string }> | undefined;
  if (locs?.[0]?.path) return locs[0].path;
  return (u.rawInput as { TargetFile?: string } | undefined)?.TargetFile;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.tasks.length === 0) {
    process.stderr.write('usage: fanout --task "A" --task "B"  |  fanout tasks.json  [--worktree] [--concurrency N]\n');
    process.exit(2);
  }

  const account = resolveActive(process.env.ACP_AGY_ACCOUNT);
  const config = {
    ...loadConfig(),
    ...(account ? { accountHome: account.home, apiKey: account.apiKey } : {}),
    accountName: account?.name ?? "default",
    runLabel: "fanout",
  };
  const log = createLogger("error");
  const repo = process.cwd();

  if (opts.worktree && !isGitRepo(repo)) {
    process.stderr.write(`--worktree requires a git repo, but ${repo} is not one.\n`);
    process.exit(2);
  }

  // Resolve each task's working copy (worktree / provided cwd / per-task subdir).
  const wtRoot = opts.worktree ? mkdtempSync(join(tmpdir(), "acp-fanout-")) : "";
  const created: Array<{ id: string; cwd: string; branch?: string; isoError?: string }> = [];
  for (const t of opts.tasks) {
    if (opts.worktree) {
      const cwd = join(wtRoot, t.id);
      const branch = `acp/${t.id}`;
      try {
        git(repo, ["worktree", "add", cwd, "-b", branch, "HEAD"]);
        created.push({ id: t.id, cwd, branch });
      } catch (err) {
        created.push({ id: t.id, cwd, branch, isoError: (err as Error).message.split("\n")[0] });
      }
    } else {
      const cwd = t.cwd ? resolvePath(t.cwd) : join(opts.base, t.id);
      try {
        mkdirSync(cwd, { recursive: true });
      } catch {
        /* ignore */
      }
      created.push({ id: t.id, cwd });
    }
  }

  const lanes = opts.tasks.map((t) => ({ id: t.id, label: `${t.id}: ${t.task.slice(0, 48)}` }));
  const dash = await startDashboard({ title: "Antigravity fan-out", concurrency: opts.concurrency }, lanes);
  const t0 = Date.now();
  const push = (e: Omit<LaneEvent, "t">) => dash.push({ t: Date.now() - t0, ...e });
  openBrowserTab(dash.url, opts.open);

  const sem = new Semaphore(opts.concurrency);
  const results: TaskResult[] = [];

  await Promise.all(
    opts.tasks.map(async (t) => {
      const iso = created.find((c) => c.id === t.id)!;
      const result: TaskResult = {
        id: t.id,
        status: "failed",
        files: [],
        tools: 0,
        summary: "",
        cwd: iso.cwd,
        branch: iso.branch,
      };
      if (iso.isoError) {
        push({ lane: t.id, type: "error", text: `isolation failed: ${iso.isoError}` });
        results.push(result);
        return;
      }

      await sem.acquire();
      try {
        const files = new Set<string>();
        const connection = {
          sessionUpdate: async (n: acp.SessionNotification) => {
            const u = n.update as Record<string, unknown>;
            const kind = u.sessionUpdate as string;
            if (kind === "tool_call") {
              const title = String(u.title ?? "");
              if (/^Antigravity CLI/.test(title)) return;
              result.tools++;
              const f = fileFromUpdate(u);
              if (f) files.add(f.replace(/^.*[\\/]/, ""));
              push({ lane: t.id, type: "tool", title });
            } else if (kind === "agent_message_chunk") {
              result.summary = String((u.content as { text?: string })?.text ?? "");
              push({ lane: t.id, type: "msg", text: result.summary });
            } else if (kind === "agent_thought_chunk") {
              push({ lane: t.id, type: "thought", text: String((u.content as { text?: string })?.text ?? "") });
            }
          },
          requestPermission: async () =>
            ({ outcome: { outcome: "selected", optionId: "allow_always" } }) as acp.RequestPermissionResponse,
        } as unknown as acp.AgentSideConnection;

        const agent = new AntigravityAgent(connection, config, log);
        const binding = t.session
          ? resolveSessionForAccount(repo, t.session, config.accountName)
          : { name: "", session: undefined, mismatch: false };
        const saved = binding.session;
        push({
          lane: t.id,
          type: "run",
          text:
            `${config.model || "Gemini 3.6 Flash"} · ${iso.cwd}` +
            (t.session ? ` · session "${t.session}"${saved?.conversationId ? " (resumed)" : ""}` : ""),
        });
        await agent.initialize({ protocolVersion: acp.PROTOCOL_VERSION });
        const session = await agent.newSession({ cwd: iso.cwd, mcpServers: [] });
        if (saved?.conversationId) {
          agent.seedConversation(session.sessionId, saved.conversationId, saved.lastStepIdx);
        }
        const res = await agent.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: t.task }] });
        result.files = [...files];
        result.status = res.stopReason === "end_turn" ? "ok" : "failed";
        if (t.session) {
          const conv = agent.getConversation(session.sessionId);
          if (conv?.conversationId) {
            recordTurn(
              repo,
              binding.name,
              {
                conversationId: conv.conversationId,
                lastStepIdx: conv.lastStepIdx,
                model: config.model || "default",
                accountName: config.accountName,
              },
              new Date().toISOString(),
            );
          }
        }
        push({ lane: t.id, type: "done", text: `stopReason = ${res.stopReason}` });
      } catch (err) {
        const message = (err as { message?: string }).message ?? String(err);
        result.status = /not logged|authenticat/i.test(message) ? "auth_required" : "failed";
        push({ lane: t.id, type: "error", text: message });
      } finally {
        sem.release();
        results.push(result);
      }
    }),
  );

  // Durable combined replay.
  let replay = "";
  try {
    const dir = join(repo, ".acp-sessions");
    mkdirSync(dir, { recursive: true });
    replay = join(dir, `fanout-${Date.now() - t0}.html`);
    writeFileSync(replay, dash.renderStaticHtml(), "utf8");
  } catch {
    replay = "(failed to write)";
  }

  // Optional worktree cleanup.
  if (opts.worktree && opts.cleanup) {
    for (const c of created) {
      if (c.isoError) continue;
      try {
        git(repo, ["worktree", "remove", "--force", c.cwd]);
      } catch {
        /* ignore */
      }
    }
  }

  const ordered = opts.tasks.map((t) => results.find((r) => r.id === t.id)!);
  const ok = ordered.filter((r) => r.status === "ok").length;
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  const lines: string[] = [
    "===== ACP-FANOUT-RESULT =====",
    `concurrency: ${opts.concurrency}   elapsed: ${elapsed}s`,
    `tasks: ${ordered.length} (ok: ${ok}, failed: ${ordered.length - ok})`,
  ];
  for (const r of ordered) {
    const one = r.summary.replace(/\s+/g, " ").trim().slice(0, 90);
    lines.push(
      `- [${r.id}] ${r.status} · files: ${r.files.join(", ") || "-"} · tools: ${r.tools}` +
        (r.branch ? ` · branch ${r.branch}` : ` · ${r.cwd}`) +
        (one ? ` · ${one}` : ""),
    );
  }
  lines.push(`dashboard: ${dash.url}`);
  lines.push(`replay_html: ${replay}`);
  if (opts.worktree && !opts.cleanup) {
    lines.push("review/merge (worktree mode):");
    for (const r of ordered) {
      if (r.branch && r.status === "ok") lines.push(`  git diff HEAD ${r.branch}   &&   git merge ${r.branch}`);
    }
  }
  lines.push("=============================");
  process.stdout.write(lines.join("\n") + "\n");

  await dash.close();
  process.exit(ok === ordered.length ? 0 : 1);
}

void main();
