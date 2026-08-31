/**
 * `ask()` — one function that carries a question to Qwen and brings the answer
 * back, so nothing else in this repository has to be read to use it.
 *
 * WHAT IS BEHIND IT, none of which the caller has to know:
 *   - the browser bridge and the Chrome extension (the only way to reach an
 *     account that is actually logged in);
 *   - PII redaction before a single character leaves the machine;
 *   - the thinking mode, borrowed and given back;
 *   - waiting for the reply to be FINISHED — the busy indicator gone and the text
 *     still for a window that adapts to how this particular stream behaved;
 *   - the per-key lock, the conversation that a session returns to, the SQLite
 *     archive of what was actually sent;
 *   - the daily-limit memory, so a blocked account is refused in a second rather
 *     than rediscovered in a minute.
 *
 * WHY THIS IS A PROCESS BOUNDARY AND NOT A CODE MOVE
 *
 * The obvious implementation is to lift those 475 lines out of the CLI into this
 * file. It was rejected on advice, and the advice was right: every one of those
 * behaviours was bought with a real incident — the composer wiped by a late
 * hydration pass, the send button that does not exist until you type, the reply
 * truncated at 52 characters, the mode left on someone's account. A "clean"
 * re-write silently drops the ones whose necessity is not obvious from reading
 * them, and each loss reappears later as a wrong answer rather than an error.
 *
 * So this calls the proven path as a child process. The cost is process startup,
 * about 250ms against a consultation that takes seconds. What it buys is that the
 * trained path has exactly ONE implementation, still covered by its tests, and
 * this file cannot drift from it. The canary, the advisor loop and the CV bot
 * already reach it the same way.
 */
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readLimit, checkLimit, describeWait } from "../web/limit-state.js";

export type ThinkingMode = "Fast" | "Auto" | "Thinking";

export interface AskOptions {
  /** Conversation key. The same key returns to the same conversation. */
  session?: string;
  /** A person's identifier: gives them an isolated, anchored conversation. */
  vip?: string;
  /** Fast is the default the account carries; Thinking buys judgement. */
  mode?: ThinkingMode;
  /** Extra literals to strip before sending (names the redactor cannot infer). */
  redact?: string[];
  /** How many times to retry a transient site failure. Default 1. */
  retries?: number;
  /** Start a new conversation instead of resuming this key's. */
  fresh?: boolean;
  /** Milliseconds. Defaults scale with the mode: Fast 90s, Thinking 180s. */
  timeoutMs?: number;
  /** Ask anyway while a stated daily limit is still counting down. */
  force?: boolean;
}

export interface AskResult {
  ok: boolean;
  /** The reply, or "" when it did not arrive. */
  answer: string;
  /** ok | site_error | stalled | timeout | tag_missing | error | blocked */
  status: string;
  /** Where this conversation lives, so a human can open it. */
  conversationUrl: string | null;
  model: string | null;
  mode: string | null;
  durationMs: number;
  /** Where the time went, for anyone tuning: fill / send / answer, in ms. */
  phases: Record<string, number>;
  /** What was removed before sending — kinds and placeholders, never values. */
  redactions: Array<{ kind: string; placeholder: string }>;
  error: string | null;
}

/** Build the child's argument list. Pure, so the mapping is testable. */
export function buildArgs(question: string, o: AskOptions = {}): string[] {
  const args = [question];
  // --vip derives its own isolated key, so the two are mutually exclusive.
  if (o.vip) args.push("--vip", o.vip);
  else if (o.session) args.push("--session", o.session);
  if (o.mode) args.push("--mode", o.mode);
  if (o.redact?.length) args.push("--redact", o.redact.join(","));
  if (typeof o.retries === "number") args.push("--retries", String(o.retries));
  if (o.fresh) args.push("--new");
  if (typeof o.timeoutMs === "number") args.push("--timeout", String(o.timeoutMs));
  if (o.force) args.push("--force");
  args.push("--json");
  return args;
}

/** Turn the child's record into the shape callers see. Pure. */
export function parseRecord(stdout: string, stderrTail: string, exitCode: number | null): AskResult {
  const empty: AskResult = {
    ok: false,
    answer: "",
    status: "error",
    conversationUrl: null,
    model: null,
    mode: null,
    durationMs: 0,
    phases: {},
    redactions: [],
    error: stderrTail || `qwen exited with ${exitCode ?? "no code"}`,
  };

  const line = (stdout || "").trim().split(/\r?\n/).filter(Boolean).pop();
  if (!line || !line.startsWith("{")) return empty;

  try {
    const rec = JSON.parse(line);
    let meta: Record<string, unknown> = {};
    try {
      meta = JSON.parse(String(rec.metadata ?? "{}"));
    } catch {
      /* metadata is a convenience, never a requirement */
    }
    const answer = String(rec.answer ?? "").trim();
    const status = String(rec.status ?? "error");
    return {
      // An answer that did not arrive is not a success, whatever the exit code.
      ok: status === "ok" && answer.length > 0,
      answer,
      status,
      conversationUrl: rec.conversation_url ?? null,
      model: rec.model ?? null,
      mode: rec.thinking ?? null,
      durationMs: Number(rec.duration_ms ?? 0),
      phases: (meta.phases as Record<string, number>) ?? {},
      redactions: (meta.redactions as Array<{ kind: string; placeholder: string }>) ?? [],
      error: rec.error ?? (status === "ok" ? null : stderrTail || status),
    };
  } catch {
    return empty;
  }
}

function qwenCliPath(): string {
  // Sits beside this file once compiled: dist/qwen/ask.js -> dist/qwen-cli.js
  return join(dirname(fileURLToPath(import.meta.url)), "..", "qwen-cli.js");
}

/**
 * Is the account currently blocked by a stated limit?
 *
 * Cheap and browser-free — it reads the note the last refusal left on disk. Worth
 * calling before a batch: being told "not for another 40 minutes" beats
 * discovering it forty times.
 */
export function blockedFor(): { blocked: boolean; minutes: number; notice: string } {
  const rec = readLimit();
  const v = checkLimit(rec, Date.now());
  return { blocked: v.blocked, minutes: v.remainingMinutes, notice: rec?.notice ?? "" };
}

export { describeWait };

/** Ask one question. Never throws: a failure is a result with `ok: false`. */
export async function ask(question: string, o: AskOptions = {}): Promise<AskResult> {
  if (!question || !question.trim()) {
    return {
      ...parseRecord("", "question is empty", 2),
      status: "error",
      error: "question is empty",
    };
  }

  const args = buildArgs(question, o);
  return new Promise<AskResult>((resolve) => {
    const child = spawn(process.execPath, ["--no-warnings", qwenCliPath(), ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      // The CLI refuses an unseen `--session` key, because an agent typing one
      // by hand is inventing a new conversation and abandoning the question
      // Qwen just asked it. A caller reaching this function is a different
      // animal: its key is derived from a subject (a job posting, an advice
      // run), so a first use is the normal first use, not a mistake.
      env: { ...process.env, ACP_QWEN_ALLOW_NEW_SESSION: "1" },
    });

    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += String(d)));
    child.stderr.on("data", (d) => (err += String(d)));

    child.on("error", (e) => {
      resolve(parseRecord("", `could not start qwen: ${e.message}`, null));
    });
    child.on("close", (code) => {
      const tail = err.trim().split(/\r?\n/).filter(Boolean).slice(-2).join(" | ");
      const res = parseRecord(out, tail, code);
      // Exit code 5 is the limit gate refusing before it opened anything.
      if (!res.ok && code === 5) {
        res.status = "blocked";
        res.error = tail || "the account is inside a stated limit";
      }
      resolve(res);
    });
  });
}

/**
 * Ask several questions in one conversation, in order.
 *
 * Sequential on purpose: they share a session, and a session is one conversation
 * with one lock. Parallelism belongs to separate sessions, not to this.
 */
export async function askMany(questions: string[], o: AskOptions = {}): Promise<AskResult[]> {
  const out: AskResult[] = [];
  for (const q of questions) {
    const res = await ask(q, o);
    out.push(res);
    // A stated block will not lift between two questions; stop asking.
    if (res.status === "blocked") break;
  }
  return out;
}
