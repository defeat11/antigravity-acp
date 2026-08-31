#!/usr/bin/env node
/**
 * Ten arithmetic questions, sent and graded without a single judgement call.
 *
 * The question this answers: does the loop — send, wait, read, verify — need a
 * model anywhere inside it?
 *
 * Arithmetic is chosen because the truth is computable HERE. The script knows
 * every answer before it asks, so grading is `===` against a number this process
 * calculated, not an opinion about whether a reply looks right. That is the whole
 * design: if a task's success can be stated as a comparison, no intelligence is
 * required to check it, and the loop stays deterministic, repeatable and cheap.
 *
 * The report separates two failures that are always worth separating:
 *   - TRANSPORT — the bridge failed to deliver or read a reply. Our bug.
 *   - WRONG     — the reply arrived intact and the arithmetic was wrong. The
 *                 model's bug, and none of the bridge's business.
 *
 * Usage:  node tools/math-drill.mjs [seed] [--mode Fast|Auto|Thinking]
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const QWEN_CLI = join(HERE, "..", "dist", "qwen-cli.js");

const argv = process.argv.slice(2);
const seedArg = argv.find((a) => /^\d+$/.test(a));
const modeIdx = argv.indexOf("--mode");
const MODE = modeIdx >= 0 ? argv[modeIdx + 1] : "Fast";
const SEED = Number(seedArg ?? 20260805);

/** Deterministic pseudo-random, so a re-run asks the exact same ten questions. */
function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

/** Ten questions whose answers this process computes itself. */
function buildQuestions(seed) {
  const rnd = makeRng(seed);
  const pick = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
  const out = [];

  const shapes = [
    () => { const a = pick(120, 999), b = pick(120, 999); return [`${a} + ${b}`, a + b]; },
    () => { const a = pick(500, 9999), b = pick(100, 499); return [`${a} - ${b}`, a - b]; },
    () => { const a = pick(12, 99), b = pick(12, 99); return [`${a} × ${b}`, a * b]; },
    () => { const b = pick(3, 19), q = pick(11, 99); return [`${b * q} ÷ ${b}`, q]; },
    () => { const a = pick(11, 40); return [`${a}²`, a * a]; },
    () => { const a = pick(20, 99), b = pick(2, 9), c = pick(10, 60); return [`${a} × ${b} + ${c}`, a * b + c]; },
    () => { const p = pick(5, 40), n = pick(200, 900); return [`${p}% من ${n}`, (p * n) / 100]; },
  ];

  while (out.length < 10) {
    const [expr, answer] = shapes[out.length % shapes.length]();
    // Only whole numbers: a decimal invites formatting differences that have
    // nothing to do with whether the bridge worked.
    if (!Number.isInteger(answer)) continue;
    out.push({ expr, answer });
  }
  return out;
}

/**
 * Read a number out of a reply. Deterministic on purpose — no model is asked
 * whether the answer "means" the right thing.
 */
export function parseNumber(text) {
  if (!text) return null;
  // Arabic-Indic digits map onto ASCII before anything else.
  const ascii = text.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660));
  const m = ascii.replace(/[,٬\s](?=\d{3}\b)/g, "").match(/-?\d+(?:\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
}

function ask(expr, session) {
  const question = `أجب برقم واحد فقط بلا أي كلمة أو رمز آخر: ما ناتج ${expr} ؟`;
  const started = Date.now();
  const run = spawnSync(
    process.execPath,
    [QWEN_CLI, question, "--session", session, "--mode", MODE, "--retries", "2", "--json"],
    { encoding: "utf8", timeout: 10 * 60 * 1000 },
  );
  const ms = Date.now() - started;
  const err = run.stderr || "";
  // What the bridge DID, not only what it returned. The question under test is
  // about the loop's behaviour, so the behaviour has to be observable.
  const tab = /tab: opened a new one/.test(err) ? "فتح" : /tab: reused/.test(err) ? "معاد" : "?";
  const reloaded = /retry: reloading/.test(err);
  try {
    const rec = JSON.parse(run.stdout || "{}");
    return { answer: String(rec.answer ?? "").trim(), status: String(rec.status ?? "error"), ms, tab, reloaded };
  } catch {
    const tail = (run.stderr || "").trim().split("\n").slice(-1)[0] || "no output";
    return { answer: "", status: "error", ms, error: tail };
  }
}

// The drill runs only when this file is EXECUTED. Importing it (to test the
// parser, say) must not fire ten live consultations — it did exactly that once.
if (process.argv[1] && process.argv[1].endsWith("math-drill.mjs")) {
  const questions = buildQuestions(SEED);
  const session = `task-math-drill-${SEED}`;

  console.log(`اختبار رياضيات: 10 أسئلة · الوضع ${MODE} · البذرة ${SEED}`);
  console.log("(الجواب الصحيح محسوب محلياً قبل السؤال — التصحيح مقارنة لا رأي)\n");

  const rows = [];
  for (const [i, q] of questions.entries()) {
    const res = ask(q.expr, session);
    const got = parseNumber(res.answer);
    const verdict =
      res.status !== "ok" || res.answer === ""
        ? "TRANSPORT"
        : got === q.answer
          ? "OK"
          : "WRONG";
    rows.push({ n: i + 1, expr: q.expr, expected: q.answer, got, verdict, sec: (res.ms / 1000).toFixed(1), status: res.status, tab: res.tab, reloaded: res.reloaded, error: res.error });
    const mark = verdict === "OK" ? "✓" : verdict === "WRONG" ? "✗" : "⛔";
    console.log(
      `${mark} ${String(i + 1).padStart(2)}. ${q.expr.padEnd(18)} = ${String(q.answer).padEnd(8)} جاء: ${String(got ?? "—").padEnd(8)} ${rows[i].sec}s  [${res.tab}${res.reloaded ? "+تحديث" : ""}]` + (res.error ? `  <- ${res.error}` : ""),
    );
  }

  const ok = rows.filter((r) => r.verdict === "OK").length;
  const wrong = rows.filter((r) => r.verdict === "WRONG").length;
  const transport = rows.filter((r) => r.verdict === "TRANSPORT").length;
  const secs = rows.map((r) => Number(r.sec)).sort((a, b) => a - b);
  const median = secs[Math.floor(secs.length / 2)];

  console.log(`\nصحيح: ${ok}/10 · خطأ في الحساب: ${wrong} · عطل في الجسر: ${transport}`);
  console.log(`وسيط الزمن: ${median}s · الإجمالي: ${secs.reduce((a, b) => a + b, 0).toFixed(1)}s`);
  console.log(`\nقرارات احتاجت حكماً بشرياً أو نموذجاً داخل الحلقة: 0`);
  console.log(`مقارنات حتمية (=== على عدد): ${rows.length}`);

  process.exitCode = transport > 0 ? 1 : 0;
}
