#!/usr/bin/env node
/**
 * swarm — split ONE goal across many sub-agents for parallel speed, safely.
 *
 * Pipeline: plan → parallel execute → verify (+ one fix pass).
 *   1. PLAN  : a read-only planner agent decomposes the goal into up to N
 *              subtasks that touch DISJOINT files (N = machine capacity),
 *              designing a contract-first API interface that all subtasks conform to.
 *   2. BUILD : the subtasks run in parallel in the SAME project dir, each told
 *              which files the others own and conforming to the shared contract.
 *              Each subtask's files are validated using a per-lane check command.
 *   3. VERIFY: a `--verify` command runs; if it fails, one fix agent repairs and
 *              re-verifies. This is what protects accuracy.
 *
 * Usage: node dist/swarm.js "<goal>" [--concurrency N] [--verify "<cmd>"] [--open] [--json]
 *   (dashboard tab stays closed by default; pass --open to auto-open it)
 *
 * Speedup is real only when the goal decomposes into independent files; tightly
 * coupled goals fall back to fewer agents. Verify is the accuracy guard.
 */

import * as os from "node:os";
import { pathToFileURL } from "node:url";
import * as acp from "@agentclientprotocol/sdk";

import { loadConfig, type AppConfig } from "./config.js";
import { createLogger, type Logger } from "./logger.js";
import { AntigravityAgent } from "./agent.js";
import { startDashboard, type LaneEvent } from "./dashboard.js";
import { runVerify, snapshotTree, restoreTree } from "./run-extras.js";
import { resolveActive, loadAccounts, isExhausted, type Account } from "./accounts.js";
import { openBrowserTab } from "./windowing.js";

interface SubTask {
  id: string;
  task: string;
  files: string[];
  check?: string;
}
interface SubResult {
  id: string;
  status: "ok" | "failed";
  files: string[];
  summary: string;
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
    const n = this.waiters.shift();
    if (n) n();
    else this.active--;
  }
}

export function assignLaneAccounts(accounts: Account[], laneCount: number): (Account | null)[] {
  const result: (Account | null)[] = [];
  if (!accounts || accounts.length === 0) {
    for (let i = 0; i < laneCount; i++) {
      result.push(null);
    }
    return result;
  }
  for (let i = 0; i < laneCount; i++) {
    result.push(accounts[i % accounts.length] || null);
  }
  return result;
}


function fileFromUpdate(u: Record<string, unknown>): string | undefined {
  const locs = u.locations as Array<{ path?: string }> | undefined;
  if (locs?.[0]?.path) return locs[0].path;
  return (u.rawInput as { TargetFile?: string } | undefined)?.TargetFile;
}

/** Run one prompt through a fresh agent; push events to a dashboard lane. */
async function runAgent(
  cwd: string,
  config: AppConfig,
  log: Logger,
  prompt: string,
  lane: string | null,
  push: (e: Omit<LaneEvent, "t">) => void,
): Promise<SubResult> {
  const files = new Set<string>();
  let summary = "";
  const connection = {
    sessionUpdate: async (n: acp.SessionNotification) => {
      const u = n.update as Record<string, unknown>;
      const kind = u.sessionUpdate as string;
      if (kind === "tool_call") {
        const title = String(u.title ?? "");
        if (/^Antigravity CLI/.test(title)) return;
        const f = fileFromUpdate(u);
        if (f) files.add(f.replace(/^.*[\\/]/, ""));
        if (lane) push({ lane, type: "tool", title });
      } else if (kind === "agent_message_chunk") {
        summary = String((u.content as { text?: string })?.text ?? "");
        if (lane) push({ lane, type: "msg", text: summary });
      } else if (kind === "agent_thought_chunk" && lane) {
        push({ lane, type: "thought", text: String((u.content as { text?: string })?.text ?? "") });
      }
    },
    requestPermission: async () =>
      ({ outcome: { outcome: "selected", optionId: "allow_always" } }) as acp.RequestPermissionResponse,
  } as unknown as acp.AgentSideConnection;

  const agent = new AntigravityAgent(connection, config, log);
  try {
    await agent.initialize({ protocolVersion: acp.PROTOCOL_VERSION });
    const s = await agent.newSession({ cwd, mcpServers: [] });
    const res = await agent.prompt({ sessionId: s.sessionId, prompt: [{ type: "text", text: prompt }] });
    return { id: lane ?? "agent", status: res.stopReason === "end_turn" ? "ok" : "failed", files: [...files], summary };
  } catch (err) {
    if (lane) push({ lane, type: "error", text: (err as Error).message ?? String(err) });
    return { id: lane ?? "agent", status: "failed", files: [...files], summary };
  }
}
export function extractJsonObject(text: string): Record<string, unknown> | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;

  const firstBracket = text.indexOf("[");
  const lastBracket = text.lastIndexOf("]");
  if (firstBracket >= 0 && firstBracket < start && lastBracket >= 0 && lastBracket > end) {
    try {
      const parsed = JSON.parse(text.slice(firstBracket, lastBracket + 1));
      if (Array.isArray(parsed)) {
        return null;
      }
    } catch {
      // not a valid outer array, continue
    }
  }

  try {
    const o: unknown = JSON.parse(text.slice(start, end + 1));
    return o && typeof o === "object" && !Array.isArray(o) ? (o as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function extractJsonArray(text: string): unknown[] | null {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start < 0 || end <= start) return null;
  try {
    const a: unknown = JSON.parse(text.slice(start, end + 1));
    return Array.isArray(a) ? a : null;
  } catch {
    return null;
  }
}

async function plan(
  goal: string,
  n: number,
  cwd: string,
  config: AppConfig,
  log: Logger,
): Promise<{ subs: SubTask[]; contract: string }> {
  const prompt =
    `Plan parallel work for this goal. Decompose it into at most ${n} INDEPENDENT subtasks ` +
    `that can run concurrently by separate agents WITHOUT conflicts — each subtask must ` +
    `create/modify a DISJOINT set of files (no two subtasks touch the same file). Put shared ` +
    `scaffolding (package.json, shared types, etc.) into the FIRST subtask only. ` +
    `Output ONLY a JSON object, no prose, no code fences: ` +
    `{"contract":"shared type definitions / interfaces / API shapes ALL subtasks must conform to (plain text; empty string if the goal is single-component)","subtasks":[{"id":"short-id","files":["relative/path"],"task":"precise self-contained instruction","check":"a fast shell command that validates ONLY this subtask's files (e.g. node --check path.js), or empty string"}]}. ` +
    `Do NOT create any files now — only output the plan.\n\nGOAL: ${goal}`;

  // Run the planner read-only so any stray file it writes is reverted.
  const snap = snapshotTree(cwd);
  const r = await runAgent(cwd, config, log, prompt, null, () => {});
  if (snap) restoreTree(cwd, snap);

  const obj = extractJsonObject(r.summary);
  if (obj && Array.isArray(obj.subtasks)) {
    const subs: SubTask[] = [];
    const contract = typeof obj.contract === "string" ? obj.contract : "";
    for (const raw of obj.subtasks.slice(0, n)) {
      const o = raw as { id?: string; task?: string; files?: unknown; check?: unknown };
      if (typeof o.task === "string" && o.task.trim()) {
        subs.push({
          id: (o.id && String(o.id)) || `t${subs.length + 1}`,
          task: o.task,
          files: Array.isArray(o.files) ? o.files.map(String) : [],
          check: typeof o.check === "string" && o.check.trim() ? o.check.trim() : undefined,
        });
      }
    }
    return {
      subs: subs.length ? subs : [{ id: "all", task: goal, files: [] }],
      contract,
    };
  }

  const arr = extractJsonArray(r.summary);
  if (arr) {
    const subs: SubTask[] = [];
    for (const raw of arr.slice(0, n)) {
      const o = raw as { id?: string; task?: string; files?: unknown };
      if (typeof o.task === "string" && o.task.trim()) {
        subs.push({
          id: (o.id && String(o.id)) || `t${subs.length + 1}`,
          task: o.task,
          files: Array.isArray(o.files) ? o.files.map(String) : [],
        });
      }
    }
    return {
      subs: subs.length ? subs : [{ id: "all", task: goal, files: [] }],
      contract: "",
    };
  }

  return {
    subs: [{ id: "all", task: goal, files: [] }],
    contract: "",
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  let concurrency = 0;
  let verifyCmd = "";
  let open = false;
  let jsonOut = false;
  const goalParts: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--concurrency") concurrency = Number.parseInt(argv[++i] ?? "", 10) || 0;
    else if (a === "--verify") verifyCmd = argv[++i] ?? "";
    else if (a === "--open") open = true;
    else if (a === "--no-open") open = false;
    else if (a === "--json") jsonOut = true;
    else goalParts.push(a);
  }
  const goal = goalParts.join(" ").trim();
  if (!goal) {
    process.stderr.write('usage: swarm "<goal>" [--concurrency N] [--verify "<cmd>"]\n');
    process.exit(2);
  }

  const cwd = process.env.ACP_AGY_CWD?.trim() || process.cwd();
  const account = resolveActive(process.env.ACP_AGY_ACCOUNT);
  const config: AppConfig = {
    ...loadConfig(),
    ...(account ? { accountHome: account.home, apiKey: account.apiKey } : {}),
    accountName: account?.name ?? "default",
    runLabel: "swarm",
  };
  const log = createLogger("error");
  const cap = Math.max(2, concurrency || Math.floor(os.cpus().length / 2));

  process.stderr.write(`planning (≤${cap} parallel agents, sized to this machine)…\n`);
  const { subs, contract } = await plan(goal, cap, cwd, config, log);

  const lanes = subs.map((s) => ({ id: s.id, label: `${s.id}: ${s.task.slice(0, 46)}` }));
  const dash = await startDashboard({ title: `swarm · ${subs.length} agents`, concurrency: cap }, lanes);
  const t0 = Date.now();
  const push = (e: Omit<LaneEvent, "t">) => dash.push({ t: Date.now() - t0, ...e });
  openBrowserTab(dash.url, open);

  const useSingleAccount =
    process.env.ACP_SWARM_SINGLE_ACCOUNT === "1" ||
    process.env.ACP_AGY_ACCOUNT !== undefined ||
    loadAccounts().accounts.filter((a) => !isExhausted(a.name)).length < 2;

  const laneAccounts = useSingleAccount
    ? []
    : assignLaneAccounts(
        loadAccounts().accounts.filter((a) => !isExhausted(a.name)),
        subs.length,
      );

  const fileMap = subs.map((s) => `${s.id}: ${s.files.join(", ") || "(unspecified)"}`).join("\n");
  const sem = new Semaphore(cap);
  const results = await Promise.all(
    subs.map(async (s, index) => {
      await sem.acquire();
      const acct = useSingleAccount ? null : laneAccounts[index];
      const laneConfig = acct
        ? {
            ...config,
            accountHome: acct.home,
            apiKey: acct.apiKey,
            accountName: acct.name,
          }
        : config;

      push({
        lane: s.id,
        type: "run",
        text: `${laneConfig.accountName} · ${laneConfig.model || "Gemini 3.6 Flash"} · owns: ${s.files.join(", ") || "?"}`,
      });
      try {
        let prompt =
          `${s.task}\n\nThis is one parallel piece of a larger goal: "${goal}".\n` +
          `Other agents are concurrently handling these files — do NOT create or edit them:\n${fileMap}\n` +
          `Only touch your own files (${s.files.join(", ") || "as needed for your subtask"}).`;
        if (contract) {
          prompt += '\nShared contract ALL agents MUST conform to exactly:\n' + contract + '\n';
        }
        let r = await runAgent(cwd, laneConfig, log, prompt, s.id, push);
        if (r.status === "ok" && s.check) {
          let laneVerify = await runVerify(s.check, cwd);
          if (laneVerify.ok) {
            push({ lane: s.id, type: "done", text: "ok · check passed" });
          } else {
            push({ lane: s.id, type: "thought", text: "lane check failed — one fix attempt…" });
            const lastOutput = (laneVerify.output || "").slice(-800);
            const fixPrompt =
              `Verification check for your files failed. Here is the output:\n${lastOutput}\n\n` +
              `Please fix your files only (${s.files.join(", ") || "as needed"}) and do not touch other agents' files.`;
            const rFix = await runAgent(cwd, laneConfig, log, fixPrompt, s.id, push);
            const mergedFiles = [...new Set([...r.files, ...rFix.files])];
            r = {
              ...rFix,
              files: mergedFiles,
            };
            if (r.status === "ok") {
              laneVerify = await runVerify(s.check, cwd);
              if (laneVerify.ok) {
                push({ lane: s.id, type: "done", text: "ok · check passed" });
              } else {
                r.status = "failed";
                push({ lane: s.id, type: "error", text: "failed" });
              }
            } else {
              push({ lane: s.id, type: "error", text: "failed" });
            }
          }
        } else {
          push({ lane: s.id, type: r.status === "ok" ? "done" : "error", text: r.status });
        }
        return r;
      } finally {
        sem.release();
      }
    }),
  );

  // Verify (accuracy guard) + one fix pass.
  let verify = verifyCmd ? await runVerify(verifyCmd, cwd) : null;
  let fixed = false;
  if (verify && !verify.ok) {
    push({ lane: subs[0]!.id, type: "thought", text: "verify failed — running a fix agent…" });
    await runAgent(
      cwd,
      config,
      log,
      `The project was built by several parallel agents and the verify command failed.\n` +
        `Command: ${verifyCmd}\nOutput:\n${verify.output}\n\nFix the issue so the command passes. ` +
        `You may edit any file. Keep changes minimal.`,
      subs[0]!.id,
      push,
    );
    verify = await runVerify(verifyCmd, cwd);
    fixed = verify.ok;
  }

  const elapsedSec = Number(((Date.now() - t0) / 1000).toFixed(1));
  const ok = results.filter((r) => r.status === "ok").length;
  const allFiles = [...new Set(results.flatMap((r) => r.files))];

  if (jsonOut) {
    process.stdout.write(
      JSON.stringify({ goal, agents: subs.length, ok, failed: subs.length - ok, elapsedSec, files: allFiles, verify, fixed, dashboard: dash.url }, null, 2) + "\n",
    );
  } else {
    const lines = [
      "===== ACP-SWARM-RESULT =====",
      `goal: ${goal.slice(0, 80)}`,
      `agents: ${subs.length} (ok ${ok}, failed ${subs.length - ok}) · concurrency ${cap} · ${elapsedSec}s`,
    ];
    for (const r of results) lines.push(`- [${r.id}] ${r.status} · files: ${r.files.join(", ") || "-"}`);
    if (verify) lines.push(`verified: ${verify.ok}${fixed ? " (after 1 fix pass)" : ""} (exit ${verify.exitCode})`);
    else lines.push("verified: (no --verify given — accuracy not guaranteed)");
    lines.push(`files: ${allFiles.join(", ") || "(none)"}`);
    lines.push(`dashboard: ${dash.url}`);
    lines.push("============================");
    process.stdout.write(lines.join("\n") + "\n");
  }

  await dash.close();
  process.exit(ok === subs.length && (!verify || verify.ok) ? 0 : 1);
}

// Only run the CLI entry point when this file is executed directly (e.g.
// `node dist/swarm.js ...`) — NOT when it's imported for `extractJsonObject`
// (e.g. by pro.ts), which would otherwise trigger a spurious empty-goal run
// that hijacks the importing module's own CLI argv parsing.
const isEntryPoint = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]!).href;
if (isEntryPoint && !process.env.VITEST) {
  void main();
}
