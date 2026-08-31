#!/usr/bin/env node
/**
 * pro — architect -> builder -> independent critic -> verify+escalate pipeline.
 *
 * Pipeline logic:
 *   1. ARCHITECT: read-only, cheap planner agent to determine approach, files, risks, verifyCmd.
 *   2. BUILDER: call runDelegate, up to maxCriticRounds (default 2).
 *   3. CRITIC: read-only critic agent, reviews diff against approach, risks, and task.
 *   4. VERIFY + ESCALATION: one fix pass if verify fails.
 */

import * as acp from "@agentclientprotocol/sdk";
import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig, type AppConfig } from "./config.js";
import { createLogger, type Logger } from "./logger.js";
import { AntigravityAgent } from "./agent.js";
import { runDelegate, type DelegateResult } from "./delegate.js";
import { snapshotTree, restoreTree } from "./run-extras.js";
import { resolveActive } from "./accounts.js";
import { buildContextGate } from "./context-gate.js";
import { readLessonsPreamble } from "./lessons.js";
import { readMapPreamble } from "./map.js";
import { extractJsonObject } from "./swarm.js";
import { readSolPreamble } from "./sol-mode.js";

export interface ProOptions {
  task: string;
  cwd: string;
  session?: string;
  ephemeral?: boolean;
  verifyCmd?: string;
  modelOverride?: string;
  maxCriticRounds?: number; // default 2
  json?: boolean;
}

export interface ProResult {
  status: "ok" | "failed";
  task: string;
  rounds: number;
  approach: string;
  riskNotes: string[];
  builderResult: unknown; // the DelegateResult from the final accepted builder run
  criticVerdicts: Array<{
    round: number;
    verdict: "approve" | "reject";
    issues: string[];
  }>;
  verify: unknown; // VerifyResult | null
  escalated: boolean;
  elapsedSec: number;
}

async function runAgent(
  cwd: string,
  config: AppConfig,
  log: Logger,
  prompt: string,
): Promise<{ status: "ok" | "failed"; summary: string }> {
  let summary = "";
  const connection = {
    sessionUpdate: async (n: acp.SessionNotification) => {
      const u = n.update as Record<string, unknown>;
      const kind = u.sessionUpdate as string;
      if (kind === "agent_message_chunk") {
        summary = String((u.content as { text?: string })?.text ?? "");
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
    return { status: res.stopReason === "end_turn" ? "ok" : "failed", summary };
  } catch {
    return { status: "failed", summary };
  } finally {
    agent.shutdown();
  }
}

export function collectFullDiff(cwd: string, maxChars = 20000, sinceMs?: number): string {
  try {
    const res = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd,
      encoding: "utf8",
      windowsHide: true,
    });
    if (res.status !== 0 || res.error) {
      return "";
    }
    const diffRes = spawnSync("git", ["diff"], {
      cwd,
      encoding: "utf8",
      windowsHide: true,
    });
    let out = diffRes.stdout ? diffRes.stdout.toString() : "";

    // `git diff` is blind to NEW files (untracked) — and builders routinely
    // create them. Append their contents so the critic actually sees the main
    // work, filtered by mtime >= sinceMs so pre-existing untracked cruft in a
    // dirty tree doesn't flood the review.
    const untrackedRes = spawnSync("git", ["ls-files", "--others", "--exclude-standard"], {
      cwd,
      encoding: "utf8",
      windowsHide: true,
    });
    const untracked = (untrackedRes.stdout ? untrackedRes.stdout.toString() : "")
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(0, 40);
    for (const rel of untracked) {
      try {
        const full = join(cwd, rel);
        const st = statSync(full);
        if (!st.isFile() || st.size > 200_000) continue;
        if (sinceMs !== undefined && st.mtimeMs < sinceMs) continue;
        out += `\n--- new untracked file: ${rel} ---\n${readFileSync(full, "utf8")}`;
      } catch {
        /* unreadable — skip */
      }
    }

    if (!out.trim()) {
      return "";
    }
    if (out.length > maxChars) {
      return out.slice(-maxChars);
    }
    return out;
  } catch {
    return "";
  }
}

export async function runPro(opts: ProOptions): Promise<ProResult> {
  const task = opts.task;
  const cwd = opts.cwd;
  const t0 = Date.now();

  const account = resolveActive(process.env.ACP_AGY_ACCOUNT);
  const config: AppConfig = {
    ...loadConfig(),
    ...(opts.modelOverride ? { model: opts.modelOverride } : {}),
    ...(account ? { accountHome: account.home, apiKey: account.apiKey } : {}),
    accountName: account?.name ?? "default",
    runLabel: "pro-pipeline",
  };
  const log = createLogger("error");

  // a) ARCHITECT
  const contextGate = buildContextGate(cwd, task);
  const lessonsPreamble = readLessonsPreamble(cwd);
  const mapPreamble = readMapPreamble(cwd);
  const solPreamble = readSolPreamble();

  const architectPrompt =
    solPreamble +
    contextGate.text +
    lessonsPreamble +
    mapPreamble +
    `Task: ${task}\n\n` +
    `Output ONLY a JSON object, no prose, no code fences:\n` +
    `{"approach":"one paragraph plan","files":["relative/path", ...],"risks":["short risk note", ...],"verifyCmd":"a real shell command to build/typecheck/test this project, or empty string if unsure"}`;

  let architect = { approach: task, files: [] as string[], risks: [] as string[], verifyCmd: "" };

  const snap = snapshotTree(cwd);
  try {
    const r = await runAgent(cwd, config, log, architectPrompt);
    const parsed = extractJsonObject(r.summary);
    if (parsed && typeof parsed.approach === "string" && parsed.approach.trim() !== "") {
      architect = {
        approach: parsed.approach,
        files: Array.isArray(parsed.files) ? parsed.files.map(String) : [],
        risks: Array.isArray(parsed.risks) ? parsed.risks.map(String) : [],
        verifyCmd: typeof parsed.verifyCmd === "string" ? parsed.verifyCmd : "",
      };
    }
  } catch {
    // fallback is already set
  } finally {
    if (snap) {
      restoreTree(cwd, snap);
    }
  }

  // b) EFFECTIVE VERIFY COMMAND
  const verifyCmd = opts.verifyCmd?.trim() || architect.verifyCmd || "";

  // c) BUILDER round loop — at least one round always runs, or builderResult
  // would stay null and the pipeline would silently do nothing.
  const maxRounds = Math.max(1, opts.maxCriticRounds ?? 2);
  let round = 1;
  let builderResult: DelegateResult | null = null;
  const criticVerdicts: Array<{ round: number; verdict: "approve" | "reject"; issues: string[] }> = [];
  let lastBuilderIssues: string[] = [];
  let lastBuilderError: string | null = null;

  while (round <= maxRounds) {
    let builderPrompt = "";
    if (round === 1) {
      builderPrompt =
        `## Architect brief (follow this)\n` +
        `Approach: ${architect.approach}\n` +
        `Files expected to change: ${architect.files.join(", ") || "(unspecified)"}\n` +
        `Known risks to avoid: ${architect.risks.join("; ") || "(none noted)"}\n\n` +
        `## Task\n` +
        `${task}`;
    } else {
      if (lastBuilderError) {
        builderPrompt =
          `## A previous attempt failed with an error. Fix this error without breaking anything else:\n` +
          `- ${lastBuilderError}\n\n` +
          `## Original task\n` +
          `${task}`;
      } else {
        builderPrompt =
          `## A previous attempt was reviewed and rejected. Fix these specific issues without breaking anything else:\n` +
          `${lastBuilderIssues.map((i) => `- ${i}`).join("\n")}\n\n` +
          `## Original task\n` +
          `${task}`;
      }
    }

    builderResult = await runDelegate({
      task: builderPrompt,
      cwd,
      session: opts.session,
      ephemeral: opts.ephemeral,
      verifyCmd,
      modelOverride: opts.modelOverride,
    });

    if (builderResult.error !== null) {
      lastBuilderError = builderResult.error.message;
      lastBuilderIssues = [];
      if (round < maxRounds) {
        round++;
        continue;
      } else {
        break;
      }
    }

    // d) CRITIC
    let diffText = collectFullDiff(cwd, 20000, t0);
    if (!diffText) {
      diffText =
        "(no git diff available; changed files reported by the builder: " +
        builderResult.files.join(", ") +
        ")";
    }

    const solPreamble = readSolPreamble();
    const criticPrompt =
      solPreamble +
      `You are an independent critic reviewing the changes made for a task.\n` +
      `Architect approach: ${architect.approach}\n` +
      `Risks to avoid: ${architect.risks.join("; ") || "(none noted)"}\n` +
      `Original task: ${task}\n\n` +
      `Here is the git diff of the changes:\n` +
      `${diffText}\n\n` +
      `Note: the working tree may contain pre-existing changes unrelated to this task — ` +
      `judge ONLY the changes that plausibly belong to the task; do not reject because of unrelated files.\n` +
      `Review the diff against the task, approach, and risks. Output ONLY a JSON object, no prose, no code fences:\n` +
      `{"verdict":"approve"|"reject","issues":["short concrete issue", ...]}`;

    const criticSnap = snapshotTree(cwd);
    let criticSummary = "";
    let criticAgent: AntigravityAgent | null = null;
    try {
      const connection = {
        sessionUpdate: async (n: acp.SessionNotification) => {
          const u = n.update as Record<string, unknown>;
          const kind = u.sessionUpdate as string;
          if (kind === "agent_message_chunk") {
            criticSummary = String((u.content as { text?: string })?.text ?? "");
          }
        },
        requestPermission: async () =>
          ({ outcome: { outcome: "selected", optionId: "allow_always" } }) as acp.RequestPermissionResponse,
      } as unknown as acp.AgentSideConnection;

      criticAgent = new AntigravityAgent(connection, config, log);
      await criticAgent.initialize({ protocolVersion: acp.PROTOCOL_VERSION });
      const session = await criticAgent.newSession({ cwd, mcpServers: [] });
      await criticAgent.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: criticPrompt }] });
    } catch {
      // robust
    } finally {
      criticAgent?.shutdown();
      if (criticSnap) {
        restoreTree(cwd, criticSnap);
      }
    }

    let criticVerdict: { verdict: "approve" | "reject"; issues: string[] } = { verdict: "approve", issues: [] };
    let parseFailed = false;
    if (criticSummary) {
      const parsed = extractJsonObject(criticSummary);
      if (parsed && (parsed.verdict === "approve" || parsed.verdict === "reject")) {
        criticVerdict = {
          verdict: parsed.verdict as "approve" | "reject",
          issues: Array.isArray(parsed.issues) ? parsed.issues.map(String) : [],
        };
      } else {
        parseFailed = true;
      }
    } else {
      parseFailed = true;
    }

    criticVerdicts.push({
      round,
      verdict: criticVerdict.verdict,
      issues: parseFailed ? ["Critic response was unparseable"] : criticVerdict.issues,
    });

    if (criticVerdict.verdict === "reject") {
      lastBuilderIssues = criticVerdict.issues;
      lastBuilderError = null;
      if (round < maxRounds) {
        round++;
        continue;
      } else {
        break;
      }
    } else {
      break;
    }
  }

  // e) FINAL VERIFY + ONE ESCALATION FIX PASS
  let escalated = false;
  let finalBuilderResult = builderResult!;
  let finalVerify = finalBuilderResult ? finalBuilderResult.verify : null;

  if (finalVerify && !finalVerify.ok) {
    escalated = true;
    const lastOutput = (finalVerify.output || "").slice(-1500);
    const fixPrompt =
      `Verification failed. Command: ${verifyCmd}\n` +
      `Output:\n${lastOutput}\n\n` +
      `Fix the issue. Keep changes minimal and consistent with: ${architect.approach}`;

    const escalateModel = process.env.ACP_PRO_ESCALATE_MODEL?.trim() || opts.modelOverride || "";

    const fixResult = await runDelegate({
      task: fixPrompt,
      cwd,
      session: opts.session,
      ephemeral: opts.ephemeral,
      verifyCmd,
      modelOverride: escalateModel || undefined,
    });

    finalBuilderResult = fixResult;
    finalVerify = fixResult.verify;
  }

  // f) Compute status
  const status =
    finalBuilderResult &&
    finalBuilderResult.error === null &&
    (!finalVerify || finalVerify.ok)
      ? "ok"
      : "failed";

  const elapsedSec = Number(((Date.now() - t0) / 1000).toFixed(1));

  return {
    status,
    task,
    rounds: Math.min(round, maxRounds),
    approach: architect.approach,
    riskNotes: architect.risks,
    builderResult: finalBuilderResult,
    criticVerdicts,
    verify: finalVerify,
    escalated,
    elapsedSec,
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  let session: string | undefined;
  let ephemeral = false;
  let verifyCmd = "";
  let modelOverride = "";
  let maxCriticRounds = 2;
  let jsonOut = false;
  const taskParts: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--session") {
      session = argv[++i];
    } else if (a === "--ephemeral") {
      ephemeral = true;
    } else if (a === "--verify") {
      verifyCmd = argv[++i] ?? "";
    } else if (a === "--model") {
      modelOverride = argv[++i] ?? "";
    } else if (a === "--max-critic-rounds") {
      maxCriticRounds = Number.parseInt(argv[++i] ?? "2", 10) || 2;
    } else if (a === "--json") {
      jsonOut = true;
    } else {
      taskParts.push(a);
    }
  }

  const task = taskParts.join(" ").trim();
  if (!task) {
    process.stderr.write(
      'usage: pro "<task>" [--session <name>] [--ephemeral] [--verify "<cmd>"] [--model <id>] [--max-critic-rounds <n>] [--json]\n',
    );
    process.exit(2);
  }

  const cwd = process.env.ACP_AGY_CWD?.trim() || process.cwd();

  try {
    const result = await runPro({
      task,
      cwd,
      session,
      ephemeral,
      verifyCmd,
      modelOverride,
      maxCriticRounds,
      json: jsonOut,
    });

    if (jsonOut) {
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    } else {
      const builderFiles = (result.builderResult as any)?.files || [];
      const lines = [
        "===== ACP-PRO-RESULT =====",
        `status: ${result.status}`,
        `rounds: ${result.rounds}`,
        `elapsed: ${result.elapsedSec}s`,
        `approach: ${result.approach.slice(0, 100)}${result.approach.length > 100 ? "..." : ""}`,
      ];

      result.criticVerdicts.forEach((cv) => {
        lines.push(`- round ${cv.round} critic verdict: ${cv.verdict} (${cv.issues.length} issue(s))`);
      });

      if (result.verify) {
        const v = result.verify as any;
        lines.push(`verified: ${v.ok} (exit ${v.exitCode})`);
      } else {
        lines.push("verified: (no verify)");
      }

      lines.push(`escalated: ${result.escalated}`);
      lines.push(`files: ${builderFiles.join(", ") || "(none)"}`);
      lines.push("============================");
      process.stdout.write(lines.join("\n") + "\n");
    }

    process.exit(result.status === "ok" ? 0 : 1);
  } catch (err: any) {
    process.stderr.write(`error: ${err.message || String(err)}\n`);
    process.exit(1);
  }
}

// Only run the CLI when executed directly (`node dist/pro.js ...`) — NOT when
// imported for `runPro`/`collectFullDiff`, which would hijack the importer.
const isEntryPoint = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]!).href;
if (isEntryPoint && !process.env.VITEST) {
  void main();
}
