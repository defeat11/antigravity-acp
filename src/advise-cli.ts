#!/usr/bin/env node
/**
 * `acp advise "<goal>"` — run the advisor/coordinator loop.
 *
 * Qwen advises (always in Thinking mode: this path exists for judgement, not for
 * speed, and Fast is the wrong tool for an advisor). agy coordinates, filters,
 * acts, and asks again when it needs to. See src/web/advise.ts for the protocol
 * and the reasoning behind the split.
 *
 * The advisor is reached by spawning the existing `qwen` CLI rather than by
 * importing it. That is deliberate: every guarantee already built into that path
 * — PII redaction before send, the per-key lock, the SQLite archive, the
 * anchored conversation, the mode restore — applies here unchanged and cannot be
 * bypassed by accident. The canary does the same thing for the same reason.
 */
import { fileURLToPath } from "node:url";

const NLC = String.fromCharCode(10);
import { spawnSync } from "node:child_process";
import { runDelegate } from "./delegate.js";
import { vipSlug } from "./web/redact.js";
import {
  adviseSessionFor,
  buildAdvisorPrompt,
  buildCoordinatorPrompt,
  parseControl,
  nextStep,
  type AdviseOutcome,
  type AdviseRoundRecord,
} from "./web/advise.js";

const argv = process.argv.slice(2);

export interface AdviseArgs {
  goal?: string;
  vip?: string;
  rounds: number;
  json: boolean;
  cwd: string;
  verifyCmd?: string;
  readOnly: boolean;
  help: boolean;
}

export function parseAdviseArgs(args: string[]): AdviseArgs {
  const out: AdviseArgs = { rounds: 3, json: false, cwd: process.cwd(), readOnly: false, help: false };
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a) continue;
    if ((a === "--rounds" || a === "-n") && i + 1 < args.length) {
      const n = Number(args[++i]);
      // A single round is a plain consultation with extra steps; more than five
      // is a conversation nobody will read.
      if (Number.isFinite(n)) out.rounds = Math.min(5, Math.max(1, Math.trunc(n)));
    } else if (a === "--vip" && i + 1 < args.length) {
      out.vip = args[++i] as string;
    } else if (a === "--cwd" && i + 1 < args.length) {
      out.cwd = args[++i] as string;
    } else if (a === "--verify" && i + 1 < args.length) {
      out.verifyCmd = args[++i] as string;
    } else if (a === "--read-only") {
      out.readOnly = true;
    } else if (a === "--json") {
      out.json = true;
    } else if (a === "--help" || a === "-h") {
      out.help = true;
    } else if (!a.startsWith("-")) {
      positional.push(a);
    }
  }
  out.goal = positional[0];
  return out;
}

const HELP = `acp advise — كوين مستشار، و agy منسّق ينفّذ ويصفّي

Usage:
  acp advise "<الهدف>" [--rounds N] [--cwd <path>] [--verify "<cmd>"] [--read-only] [--json]

كيف تعمل:
  1. كوين يعطي مقترحات (دائماً بوضع Thinking) — بلا أي بيانات خاصة.
  2. agy يصفّي وينفّذ، وينهي ردّه بسطر تحكّم واحد.
  3. لو طلب agy مزيداً، يعود السؤال إلى كوين وتتكرر الجولة.

Flags:
  --vip <id>        اربط الحلقة بجلسة الـVIP المعزولة (المعرّف يصل للمنسّق وحده)
  --rounds N        أقصى عدد جولات (1..5، الافتراضي 3)
  --cwd <path>      مجلد المشروع الذي يعمل فيه المنسّق (الافتراضي: المجلد الحالي)
  --verify "<cmd>"  أمر بناء/اختبار يشغّله المنسّق للتحقق من تغييراته
  --read-only       تحليل بلا تعديل ملفات
  --json            اطبع السجل الكامل بصيغة JSON
`;

/** Ask the advisor. Returns the answer plus how the child actually fared. */
function consultAdvisor(
  question: string,
  session: string,
  vip?: string,
): { answer: string; ms: number; status: string; error?: string } {
  const qwenCli = fileURLToPath(new URL("./qwen-cli.js", import.meta.url));
  const args = [
    question,
    // With a VIP the child derives the isolated key itself, so the identity
    // rules (anchor, lock, per-person conversation) apply exactly as they do to
    // any other consultation about that person — no parallel path to audit.
    ...(vip ? ["--vip", vip] : ["--session", session]),
    // Always Thinking. An advisor is asked for judgement, and Fast exists to buy
    // latency at the cost of exactly that. The user's own mode is restored
    // afterwards by the widget module, so this costs him nothing.
    "--mode",
    "Thinking",
    "--retries",
    "2",
    "--json",
  ];
  const started = Date.now();
  const run = spawnSync(process.execPath, [qwenCli, ...args], {
    encoding: "utf8",
    timeout: 20 * 60 * 1000,
    // See the same note in src/qwen/ask.ts: the unseen-key refusal is aimed at
    // an agent inventing a session name, not at a subsystem whose key is
    // derived from the subject it is advising on.
    env: { ...process.env, ACP_QWEN_ALLOW_NEW_SESSION: "1" },
  });
  const ms = Date.now() - started;
  // Whatever went wrong, say WHAT. The first version reported a failed advisor as
  // "no details" because it only looked at stderr in the JSON-parse catch — and
  // the real failure printed a precise message there while stdout was empty.
  // A diagnostic that drops the diagnosis is worse than none: it looks like the
  // cause was investigated.
  const stderrTail = (run.stderr || "").trim().split(NLC).filter(Boolean).slice(-2).join(" | ");
  try {
    const rec = JSON.parse(run.stdout || "{}");
    const answer = String(rec.answer ?? "").trim();
    const status = String(rec.status ?? (run.status === 0 && answer ? "ok" : "error"));
    return {
      answer,
      ms,
      status,
      error: rec.error ? String(rec.error) : status !== "ok" ? stderrTail || `child exited ${run.status}` : undefined,
    };
  } catch {
    return {
      answer: "",
      ms,
      status: "error",
      error: (run.stderr || "").trim().split("\n").slice(-1)[0] || "advisor produced no JSON",
    };
  }
}

async function main(): Promise<void> {
  const parsed = parseAdviseArgs(argv);
  if (parsed.help || !parsed.goal) {
    process.stdout.write(HELP);
    process.exitCode = parsed.goal ? 0 : 2;
    return;
  }

  const goal = parsed.goal;
  const session = adviseSessionFor(goal, parsed.vip ? `vip-${vipSlug(parsed.vip)}` : null);
  const rounds: AdviseRoundRecord[] = [];
  let stopped: AdviseOutcome["stopped"] = "max-rounds";
  let ask: string | undefined;

  for (let round = 1; round <= parsed.rounds; round++) {
    const question = buildAdvisorPrompt(goal, round, ask);

    if (!parsed.json) process.stderr.write(`\n— جولة ${round}/${parsed.rounds}: أسأل المستشار…\n`);
    const advice = consultAdvisor(question, session, parsed.vip);
    if (advice.status !== "ok" || !advice.answer) {
      // The coordinator is not handed an empty opinion and asked to pretend.
      rounds.push({
        round,
        question,
        advice: "",
        adviceMs: advice.ms,
        adviceStatus: advice.status,
        coordinator: "",
        coordinatorMs: 0,
        control: { kind: "missing" },
      });
      stopped = "advisor-failed";
      process.stderr.write(`تعذّرت استشارة المستشار (${advice.status}): ${advice.error ?? "بلا تفاصيل"}\n`);
      break;
    }
    if (!parsed.json) process.stderr.write(`  المستشار ردّ في ${Math.round(advice.ms / 1000)}s\n`);

    if (!parsed.json) process.stderr.write(`— جولة ${round}: المنسّق يصفّي وينفّذ…\n`);
    const coordStarted = Date.now();
    let coordinatorText = "";
    let coordinatorFailed: string | null = null;
    try {
      const res = await runDelegate({
        task: buildCoordinatorPrompt(goal, advice.answer, round, parsed.rounds, parsed.vip ?? null),
        cwd: parsed.cwd,
        session,
        readOnly: parsed.readOnly,
        ...(parsed.verifyCmd ? { verifyCmd: parsed.verifyCmd } : {}),
      });
      coordinatorText = String(res.summary ?? "");
      if (res.status && res.status !== "ok" && !coordinatorText) {
        coordinatorFailed = res.error?.message || res.status;
      }
    } catch (err) {
      coordinatorFailed = err instanceof Error ? err.message : String(err);
    }
    const coordinatorMs = Date.now() - coordStarted;

    if (coordinatorFailed) {
      rounds.push({
        round,
        question,
        advice: advice.answer,
        adviceMs: advice.ms,
        adviceStatus: advice.status,
        coordinator: "",
        coordinatorMs,
        control: { kind: "missing" },
      });
      stopped = "coordinator-failed";
      process.stderr.write(`تعذّر تشغيل المنسّق: ${coordinatorFailed}\n`);
      break;
    }

    const control = parseControl(coordinatorText);
    rounds.push({
      round,
      question,
      advice: advice.answer,
      adviceMs: advice.ms,
      adviceStatus: advice.status,
      coordinator: coordinatorText,
      coordinatorMs,
      control,
    });

    const step = nextStep(control, round, parsed.rounds);
    if (!step.continue) {
      stopped = step.stopped;
      break;
    }
    ask = step.ask;
    if (!parsed.json) process.stderr.write(`  المنسّق يسأل المستشار: ${ask}\n`);
  }

  const outcome: AdviseOutcome = { goal, session, rounds, stopped };

  if (parsed.json) {
    process.stdout.write(JSON.stringify(outcome, null, 2) + "\n");
  } else {
    const last = rounds[rounds.length - 1];
    const reason: Record<AdviseOutcome["stopped"], string> = {
      done: "المنسّق أعلن الاكتفاء",
      "max-rounds": "بلغنا سقف الجولات",
      "no-control": "المنسّق لم يُنهِ ردّه بسطر تحكّم — الحلقة تتوقف بدل أن تدور بلا سؤال",
      "advisor-failed": "تعذّرت استشارة المستشار",
      "coordinator-failed": "تعذّر تشغيل المنسّق",
    };
    process.stdout.write("\n" + (last?.coordinator || "(لا مخرجات من المنسّق)") + "\n");
    process.stdout.write(`\n— انتهت بعد ${rounds.length} جولة: ${reason[stopped]}\n`);
    process.stdout.write(`— جلسة المستشار: ${session}\n`);
  }

  // A loop that stopped because a party failed must not report success: the
  // caller may be scripting on top of this.
  process.exitCode = stopped === "advisor-failed" || stopped === "coordinator-failed" ? 4 : 0;
}

if (process.argv[1] && process.argv[1].endsWith("advise-cli.js")) {
  main().catch((err) => {
    process.stderr.write(`advise failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
}
