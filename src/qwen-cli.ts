import { ensureExtensionReady, ExtensionTransport } from "./web/transport.js";
import { BrowserTab } from "./web/actions.js";
import {
  putSession,
  dropSession,
  autoPruneIdleTabs,
  getSession,
  sameConversation,
  retryNeedsReload,
} from "./web/state.js";
import { redactPII, vipSlug } from "./web/redact.js";
import {
  cvFingerprint,
  cvSessionName,
  getOrCreateCvSecret,
  anchorLine,
  parseAnchor,
  anchorMatches,
  correlationToken,
  answerEchoesToken,
  stripToken,
} from "./web/cv-identity.js";
import { acquireLock, releaseLock } from "./web/cv-lock.js";
import { buildEvaluationPrompt, parseEvaluation, comparabilityKey } from "./web/cv-rubric.js";
import { buildRehydrationBrief } from "./web/cv-archive.js";
import { findDualUrlSessions, findSharedUrls } from "./web/cv-retire.js";
import { summarize } from "./web/leak-scan.js";
import {
  readLimit,
  writeLimit,
  clearLimit,
  checkLimit,
  limitFrom,
  extendAfterProbe,
  describeWait,
} from "./web/limit-state.js";
import { verifyAfterAction, actAndVerify } from "./web/verify-action.js";
import {
  COMPOSER_READY_JS,
  COMPOSER_SELECTOR,
  ensureMode,
  modeTimeoutMs,
  normalizeMode,
  readMode,
  readModel,
  readPendingRestore,
  writePendingRestore,
  clearPendingRestore,
  restoreMode,
  WidgetError,
  type ThinkingMode,
} from "./web/widgets/qwen-composer.js";
import { readFileSync as readFileSyncNode } from "node:fs";
import {
  detectSiteError,
  isRetryableSiteError,
  parseWaitHint,
  type SiteErrorMatch,
} from "./web/site-errors.js";
import {
  insertConsult,
  listConsults,
  getConsult,
  consultStats,
  lastConsultForSession,
} from "./web/qwen-db.js";
import {
  initialState,
  observe,
  isSettled,
  type StabilityState,
} from "./web/stability.js";

export interface QwenParsedArgs {
  subcommand?: "list" | "show" | "resume" | "stats" | "export" | "audit" | "retire" | "outgoing" | "canary" | "mode" | "redact" | "leaks" | "last" | "help";
  question?: string;
  /** Files whose CONTENT rides with the question. Repeatable `--file`. */
  files?: string[];
  /** Consent to open a brand-new conversation key. Without it, new keys refuse. */
  newSession?: boolean;
  /** Escape hatch: allow naming a file without carrying it. */
  noFileCheck?: boolean;
  /** Escape hatch: allow reporting finished work with no proof attached. */
  noEvidenceCheck?: boolean;
  /** Refuse to send unless the page is actually on this model. */
  expectModel?: string;
  id?: string;
  session?: string;
  vip?: string;
  cvId?: string;
  taskId?: string;
  jobId?: string;
  cvVersion?: string;
  cvFile?: string;
  criteria?: string[];
  redact?: string[];
  noRedact?: boolean;
  deep?: boolean;
  force?: boolean;
  mode?: ThinkingMode;
  retries?: number;
  isNew?: boolean;
  timeoutMs?: number;
  isJson?: boolean;
  limit?: number;
  search?: string;
  since?: string;
  format?: "json" | "md";
}

/**
 * The completion rule for a Qwen answer, as numbers a test can read.
 *
 * MEASURED, not guessed. Three answers in ~/.acp/qwen.db were filed with status
 * ok while cut mid-token — 2026-08-16T15:22:44Z ("…مهاراتك الحالية بالض", 201
 * chars, reached a real member), 2026-08-15T18:50:00Z ("…137\n138\n13" out of a
 * count to 150) and 2026-08-15T17:10:55Z ("…سأتعامل مع أي مهمة", 77 chars). A
 * model does not stop mid-word, so generation was still running when the loop
 * accepted. All three were in Thinking mode, i.e. governed by the 4000ms
 * ceiling — the old ceiling was too low, not merely the 2000ms one.
 *
 * What the ceiling was actually doing: the window is twice the largest growth
 * gap the stream has already shown, which is exactly the right adaptation — a
 * stream that has paused 3s once will pause 3s again. `Math.min(ceiling, …)`
 * threw that measurement away. So the ceiling is raised well past any observed
 * pause and the earned window governs below it; `STABILITY_MAX_CEILING_MS`
 * keeps it from ever becoming a blind sleep.
 *
 * Cost check: the window only reaches these ceilings for a stream that has
 * ALREADY demonstrated pauses that long. A smooth stream still settles at the
 * floor, so a finished short reply is not slowed down — it pays the floor plus
 * three poll intervals, under 1.6s.
 */
export function qwenSettleOptions(thinking: string | null | undefined): {
  floorMs: number;
  ceilingMs: number;
  minIdleSamples: number;
  unfinishedGraceMs: number;
} {
  const isThinking = /thinking/i.test(thinking ?? "");
  const graceEnv = Number(process.env.ACP_QWEN_TAIL_GRACE_MS);
  return {
    // Well above the generic 500ms floor. The adaptive window can only react to
    // a pause the stream has ALREADY shown, so the very first long pause is
    // covered by nothing but the floor — and the first pause is exactly what cut
    // the archived answers. A consultation on this path takes 20-200s, so 1-2s
    // of proof at the end is not a cost worth optimising away.
    floorMs: isThinking ? 2000 : 1200,
    // Thinking falls silent between the reasoning phase and the answer stream,
    // so it is allowed more rope than Fast.
    ceilingMs: isThinking ? 15000 : 8000,
    // One read of a missing Stop button is not proof: the site re-renders that
    // button, and a single unlucky sample inside a pause is precisely the
    // coincidence that truncated the answers above.
    minIdleSamples: 3,
    // An answer that ends mid-token buys extra patience, never a rejection.
    // 23% of the last 60 successful answers ended on a bare word or digit, most
    // of them genuinely complete, so this is a few seconds on roughly a quarter
    // of consultations — paid against a failure that reached an end user.
    // Set ACP_QWEN_TAIL_GRACE_MS=0 to switch it off.
    unfinishedGraceMs: Number.isFinite(graceEnv) && graceEnv >= 0 ? graceEnv : 6000,
  };
}

/**
 * The default conversation key.
 *
 * MEASURED, not guessed. Between 2026-08-21T06:38Z and 06:46Z the archive in
 * ~/.acp/qwen.db recorded FIVE keys — `fable-architecture-audit`, `default`,
 * `rules-qwen-fix-2026`, `default`, `qwen-direct-full-payload` — across FOUR
 * distinct conversation URLs, inside eight minutes. Qwen asked a follow-up in
 * one conversation; the next call was born in another, so the follow-up was
 * never answered and the new conversation opened on an unrelated prompt.
 *
 * A key is bound to a conversation, so one default key means one conversation.
 * `--new-session` is the deliberate way to start another.
 */
export const DEFAULT_SESSION = "qwen";

/**
 * The size below which a question that NAMES a file cannot possibly CARRY it.
 *
 * MEASURED from the archive, and the two populations do not overlap:
 *   named a file, content missing : 42, 52, 60, 72, 114, 128 chars
 *   carried its context           : 376, 390, 493, 539, 674, 4426 chars
 * 300 sits in the gap. Above it nothing historical is refused; below it every
 * recorded bare-filename send is.
 */
export const MIN_CARRY_CHARS = 300;

/** File-ish tokens: the extensions this repository actually passes around. */
const FILE_MENTION_RE = new RegExp(
  String.raw`(?:[A-Za-z]:)?[\w./\\@-]*\w\.(md|markdown|ts|tsx|js|mjs|cjs|jsx|json|jsonl|py|sql|sh|ps1|psm1|yml|yaml|toml|ini|env|txt|css|scss|html|vue|svelte|go|rs|java|rb|php|cpp|db|sqlite|csv|log)\b`,
  "gi",
);

/** Every file-looking token a question mentions, de-duplicated, order kept. Pure. */
export function fileMentions(question: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of (question || "").matchAll(FILE_MENTION_RE)) {
    const tok = m[0];
    const key = tok.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tok);
  }
  return out;
}

/**
 * Decide whether a question names a file it does not carry. Pure, so the rule
 * is a unit test rather than a claim.
 *
 * Refuses only when nothing was attached AND the question is too small to hold
 * what it points at. A question that inlines its context, or that rides with
 * `--file`, is never touched.
 */
export function uncarriedFileMentions(question: string, carriedCount: number): string[] {
  if (carriedCount > 0) return [];
  const q = (question || "").trim();
  if (q.length >= MIN_CARRY_CHARS) return [];
  return fileMentions(q);
}

/**
 * Read each `--file` and wrap it in an explicit delimiter, so the consulted
 * model can tell the question from the payload. Pure apart from the read.
 */
export function buildFileBlocks(
  paths: string[],
  read: (p: string) => string,
): { blocks: string[]; error: string | null } {
  const blocks: string[] = [];
  for (const p of paths) {
    let text: string;
    try {
      text = read(p);
    } catch (err: any) {
      return { blocks: [], error: `cannot read --file ${p}: ${String(err?.message || err)}` };
    }
    const name = p.split(/[\\/]/).filter(Boolean).pop() || p;
    blocks.push(
      `--- BEGIN FILE: ${name} (${p}) ---\n${text}\n--- END FILE: ${name} ---`,
    );
  }
  return { blocks, error: null };
}

/**
 * The gate against asking an advisor to bless work it cannot see.
 *
 * MEASURED, not guessed. At 06:37Z on 2026-08-21 the agent deleted ten rule
 * files. At 06:38:57Z it asked Qwen:
 *
 *   "we unified the rules into one constitution instead of 15 scattered files
 *    and deleted the duplicated, contradictory ones, WHILE FULLY KEEPING:
 *    1. the anti-guessing charter, 2. the Qwen/DeepSeek gate, 3. CV isolation,
 *    4. Superpowers TDD. Is this architecturally sound?"
 *
 * It had kept none of the mechanisms. Qwen — which has no tools, no filesystem,
 * and sees only that sentence — replied "an excellent step reflecting
 * architectural maturity". A perfect advisor blessed a catastrophe because the
 * facts it was handed were invented. Wrong input, confident wrong output, and
 * an approval the user then trusted.
 *
 * So a question that REPORTS COMPLETED WORK must CARRY the proof of it.
 *
 * Tuned against all 700 archived consultations: 7 report finished work, 6 of
 * those carry no evidence — 0.9% of traffic, and the sixth is the incident
 * above. Every one of the six would have been a better consultation with the
 * file attached, so the refusal costs nothing real.
 */
const DONE_CLAIM_RE = new RegExp(
  String.raw`(قمنا\s+ب|حذفنا|أنجزنا|نفّذنا|نفذنا|عدّلنا|عدلنا|أضفنا|اضفنا|أزلنا|ازلنا|دمجنا|` +
    String.raw`اعتمدنا|طبّقنا|طبقنا|أنشأنا|انشأنا|بنينا|صلّحنا|صححنا|خلصنا|انتهينا|` +
    String.raw`\bتم\s+(الحذف|الدمج|التنفيذ|الإصلاح|التعديل|الإنشاء|الترحيل|التحديث)|` +
    String.raw`\bwe (deleted|removed|merged|migrated|refactored|implemented|fixed|completed|replaced)\b|` +
    String.raw`\b(i|we)['’]ve (deleted|removed|merged|implemented|fixed|completed)\b)`,
  "i",
);

/** Something the claim can be checked against: output, a path, a code block. */
const EVIDENCE_RE = new RegExp(
  String.raw`(exit\s*code|exitcode|\bexit\s*[:=]\s*\d|` + "```" + String.raw`|--- BEGIN FILE:|` +
    String.raw`\bTraceback\b|\bError:|\bstderr\b|\bstdout\b|` +
    String.raw`[A-Za-z]:\\[^\s]+\.[a-z]{1,6}|/[\w./-]+\.[a-z]{1,6}\b|` +
    String.raw`^\s*\d+:\s|\bline \d+\b)`,
  "im",
);

/** Does this question report work already done? Pure. */
export function claimsFinishedWork(question: string): boolean {
  return DONE_CLAIM_RE.test(question || "");
}

/** Does it carry anything the claim can be checked against? Pure. */
export function carriesEvidence(question: string): boolean {
  return EVIDENCE_RE.test(question || "");
}

/**
 * True when the question asks an advisor to judge finished work while giving it
 * nothing to judge by. `--file` counts as evidence on its own.
 */
export function needsEvidence(question: string, carriedCount: number): boolean {
  if (carriedCount > 0) return false;
  const q = question || "";
  return claimsFinishedWork(q) && !carriesEvidence(q);
}

/** Does this answer end on a question aimed back at us? Pure. */
export function endsWithQuestion(answer: string | null | undefined): boolean {
  const t = (answer || "").trim();
  if (!t) return false;
  const lastLines = t
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .slice(-3)
    .join("\n");
  return /[?؟]/.test(lastLines);
}

export function parseQwenArgs(argv: string[]): QwenParsedArgs {
  const result: QwenParsedArgs = {};
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg) continue;
    if (arg === "--session" && i + 1 < argv.length) {
      const val = argv[++i];
      if (val) result.session = val;
    } else if (arg === "--vip" && i + 1 < argv.length) {
      const val = argv[++i];
      if (val) result.vip = val;
    } else if (arg === "--cv-id" && i + 1 < argv.length) {
      const val = argv[++i];
      if (val) result.cvId = val;
    } else if (arg === "--task" && i + 1 < argv.length) {
      const val = argv[++i];
      if (val) result.taskId = val;
    } else if (arg === "--job" && i + 1 < argv.length) {
      const val = argv[++i];
      if (val) result.jobId = val;
    } else if (arg === "--cv-version" && i + 1 < argv.length) {
      const val = argv[++i];
      if (val) result.cvVersion = val;
    } else if (arg === "--cv-file" && i + 1 < argv.length) {
      const val = argv[++i];
      if (val) result.cvFile = val;
    } else if (arg === "--criteria" && i + 1 < argv.length) {
      const val = argv[++i];
      if (val) result.criteria = val.split(",").map((x) => x.trim()).filter(Boolean);
    } else if (arg === "--redact" && i + 1 < argv.length) {
      const val = argv[++i];
      if (val) {
        result.redact = val.split(",").map((s) => s.trim()).filter(Boolean);
      }
    } else if ((arg === "--file" || arg === "--attach") && i + 1 < argv.length) {
      const val = argv[++i];
      if (val) (result.files ??= []).push(val);
    } else if (arg === "--new-session") {
      result.newSession = true;
    } else if (arg === "--no-file-check") {
      result.noFileCheck = true;
    } else if (arg === "--no-evidence-check") {
      result.noEvidenceCheck = true;
    } else if (arg === "--expect-model" && i + 1 < argv.length) {
      const val = argv[++i];
      if (val) result.expectModel = val;
    } else if (arg === "--force") {
      result.force = true;
    } else if (arg === "--no-redact") {
      result.noRedact = true;
    } else if (arg === "--deep") {
      result.deep = true;
      result.mode = "Thinking";
    } else if (arg === "--mode" && i + 1 < argv.length) {
      const val = normalizeMode(argv[++i]);
      if (!val) {
        process.stderr.write("error: --mode accepts Fast, Auto or Thinking\n");
        process.exit(2);
      }
      result.mode = val;
    } else if (arg === "--retries" && i + 1 < argv.length) {
      const val = argv[++i];
      if (val) result.retries = Number(val);
    } else if (arg === "--new") {
      result.isNew = true;
    } else if (arg === "--timeout" && i + 1 < argv.length) {
      const val = argv[++i];
      if (val) result.timeoutMs = Number(val);
    } else if (arg === "--json") {
      result.isJson = true;
    } else if (arg === "--limit" && i + 1 < argv.length) {
      const val = argv[++i];
      if (val) result.limit = Number(val);
    } else if (arg === "--search" && i + 1 < argv.length) {
      const val = argv[++i];
      if (val) result.search = val;
    } else if (arg === "--since" && i + 1 < argv.length) {
      const val = argv[++i];
      if (val) result.since = val;
    } else if (arg === "--format" && i + 1 < argv.length) {
      const val = argv[++i];
      if (val) {
        const fmt = val.toLowerCase();
        result.format = fmt === "md" || fmt === "markdown" ? "md" : "json";
      }
    } else if (arg === "--help" || arg === "-h" || arg === "help") {
      result.subcommand = "help";
    } else if (!arg.startsWith("-")) {
      positional.push(arg);
    }
  }

  if (result.subcommand === "help") return result;

  if (result.vip && result.session) {
    process.stderr.write("error: cannot combine --vip and --session\n");
    process.exit(2);
  }

  const firstPos = positional[0];
  if (firstPos === "list") {
    result.subcommand = "list";
  } else if (firstPos === "show") {
    result.subcommand = "show";
    result.id = positional[1];
  } else if (firstPos === "resume") {
    result.subcommand = "resume";
  } else if (firstPos === "last" || firstPos === "pending") {
    result.subcommand = "last";
  } else if (firstPos === "stats") {
    result.subcommand = "stats";
  } else if (firstPos === "export") {
    result.subcommand = "export";
  } else if (firstPos === "audit") {
    result.subcommand = "audit";
  } else if (firstPos === "retire") {
    result.subcommand = "retire";
  } else if (firstPos === "outgoing") {
    result.subcommand = "outgoing";
  } else if (firstPos === "canary") {
    result.subcommand = "canary";
  } else if (firstPos === "leaks") {
    result.subcommand = "leaks";
  } else if (firstPos === "redact") {
    result.subcommand = "redact";
  } else if (firstPos === "mode") {
    result.subcommand = "mode";
    // `acp qwen mode Fast` — the value may come positionally or via --mode.
    const pos = positional[1];
    if (pos && !result.mode) {
      const m = normalizeMode(pos);
      if (!m) {
        process.stderr.write("error: mode accepts Fast, Auto or Thinking" + String.fromCharCode(10));
        process.exit(2);
      }
      result.mode = m;
    }
  } else if (firstPos) {
    result.question = firstPos;
  }

  return result;
}

export function printQwenHelp(): void {
  const helpText = `acp qwen — One-line Qwen consultation CLI (backed by local SQLite archive)

Usage:
  acp qwen "<question>" [flags]                  Consult Qwen in one line
  acp qwen list [flags]                         List past consultations
  acp qwen show <id> [--json]                   Show full question, answer and metadata
  acp qwen resume [--session <name> | --vip <id>] Reopen session conversation in browser
  acp qwen last [--session <name>] [--json]     Read the last answer + whether Qwen is waiting on you
  acp qwen stats [--json]                       Show total consults, success rate and performance
  acp qwen export [--session <name>] [--format json|md] Export consultations for archiving
  acp qwen mode [Fast|Auto|Thinking]            Show or set the thinking mode you own
  acp qwen redact --cv-file <path> [--json]     Redact a document BEFORE embedding it in a prompt
  acp qwen leaks [--json]                      Inventory: which archived questions carried a name out

Flags for consultation:
  --session <name>                              Conversation key (default: 'qwen'). Same key = same conversation.
  --file <path>                                 Attach a file's CONTENT to the question. Repeatable.
  --new-session                                 Consent to open a brand-new conversation key
  --no-file-check                               Allow naming a file without carrying it
  --no-evidence-check                           Allow reporting finished work with no proof attached
  --expect-model <name>                         Refuse to send unless the page is on this model (e.g. Qwen3.8-Max, Qwen3.7-Max, Qwen3.7-Plus, Qwen2.5-Coder, Qwen-Latest, DeepSeek-R1, DeepSeek-V3)
  --vip <identifier>                            Candidate/VIP identity slug session (e.g. vip-john-doe)
  --redact <name1,name2>                        Additional names/literals to strip from question
  --no-redact                                   Disable PII redaction (prints warning to stderr)
  --mode <Fast|Auto|Thinking>                   Force the thinking mode (restored afterwards)
  --deep                                        Alias for --mode Thinking
  --force                                       Try even while a stated limit is still counting down
  --retries N                                   Max retry attempts on site_error or stalled (default: 1)
  --new                                         Start a fresh conversation instead of resuming session
  --timeout <ms>                                Max wait time (default scales: Fast 90s · Auto 120s · Thinking 180s)
  --json                                        Print full JSON record instead of answer text alone

Flags for list / export:
  --limit N                                     Max rows to return (default: 50)
  --search "<text>"                             Filter by text in question or answer
  --since <YYYY-MM-DD|ISO>                      Filter consultations on or after date
  --format <json|md>                            Export format (default: json)

Supported Models (--expect-model):
  Qwen3.8-Max   — Qwen Flagship DeepThink 🧠 / Fast ⚡
  Qwen3.7-Max   — Qwen Text Specialist ⚡
  Qwen3.7-Plus  — Qwen Multimodal Balanced 🌐
  Qwen2.5-Coder — Qwen Code Specialist 💻
  Qwen-Latest   — Qwen Ultra-Low Latency 🚀
  DeepSeek-R1   — DeepSeek R1 DeepThink 🧠
  DeepSeek-V3   — DeepSeek V3 Standard ⚡

Two refusals you will meet, and why:
  "names <file> but does not carry it"  — a short question that points at a file sends only the name.
                                          Use --file <path>, or --no-file-check if the name is all you meant.
  "--session X has no conversation yet" — a new key starts a new conversation, which cannot see what Qwen
                                          already asked. Reuse a key, or pass --new-session on purpose.
`;
  process.stdout.write(helpText);
}

export async function main(): Promise<void> {
  // What the caller waits for BEFORE the consultation timer even starts.
//
// The per-attempt phases (fill/send/answer) explained the seconds inside the
// loop and left the ones before it unaccounted: process start, the hub check,
// attaching to the tab, waiting for the app to mount, settling the mode. A
// resumed call was measured at 4.2s internally and 10.7s from the caller's
// side, and nothing in the record said where the other six went.
const PROC_START = Date.now();
const preflight: Record<string, number> = {};
let preAt = PROC_START;
function preMark(name: string): void {
  preflight[name] = Date.now() - preAt;
  preAt = Date.now();
}

const argv = process.argv.slice(2);
  const parsed = parseQwenArgs(argv);

  if (parsed.subcommand === "help") {
    printQwenHelp();
    process.exit(0);
  }

  // A CV consultation is keyed by (candidate, job, CV version) and gets an
  // anchored, locked conversation. Everything else keeps the old behaviour.
  // The same anchored, locked machinery serves any long-lived subject — a
  // candidate under --cv-id, or a unit of engineering work under --task. Both
  // need the identical guarantee: come back to MY conversation, never someone
  // else's, and keep building on it.
  const subjectId = parsed.cvId ?? parsed.taskId ?? null;
  const subjectPrefix = parsed.cvId ? "cv" : "task";
  const cvFp = subjectId
    ? cvFingerprint(
        { candidateId: subjectId, jobId: parsed.jobId, cvVersion: parsed.cvVersion },
        getOrCreateCvSecret(),
      )
    : null;

  const effectiveSessionName = cvFp
    ? `${subjectPrefix}-${cvFp}`
    : parsed.vip
      ? `vip-${vipSlug(parsed.vip)}`
      : parsed.session || DEFAULT_SESSION;

  // Isolation audit + retirement of keys we can no longer vouch for.
  // Review what LEAVES the machine, not what comes back.
  //
  // The review caught a hole in our own safety plan: human review of the ANSWER
  // cannot catch a leak, because the leak happens the moment the question is
  // sent. The archive stores the redacted text that actually went out, so this
  // shows exactly that — sample it before trusting the redaction on a new CV
  // layout.
  // Canary: prove the whole chain works on a question whose answer we already
  // know, BEFORE putting a real candidate through it. A silent breakage upstream
  // (page redesign, stale answer, broken redaction) shows up here as a wrong
  // answer instead of as a wrong judgement about a person.
  if (parsed.subcommand === "canary") {
    const secret = String(Math.floor(Math.random() * 9000) + 1000);
    const expected = secret;
    const question = `أجب برقم واحد فقط بلا أي كلمة أخرى: ما ناتج ${secret} + 0 ؟`;
    const args = [
      question,
      "--session",
      "canary",
      "--new",
      "--json",
      // The canary is a pre-flight check, so it gets a wider margin than a normal
      // consultation: a minimised window recovers on the next attempt, and a
      // false alarm here would train people to skip the check — which is worse
      // than no check at all. Real breakage still fails all attempts.
      "--retries",
      "3",
      ...(parsed.timeoutMs ? ["--timeout", String(parsed.timeoutMs)] : []),
    ];
    const { spawnSync } = await import("node:child_process");
    const started = Date.now();
    const run = spawnSync(process.execPath, [process.argv[1] as string, ...args], {
      encoding: "utf8",
      timeout: 5 * 60 * 1000,
    });
    const elapsed = Math.round((Date.now() - started) / 1000);
    let answer = "";
    let status = "error";
    try {
      const parsedOut = JSON.parse(run.stdout || "{}");
      answer = String(parsedOut.answer ?? "").trim();
      status = String(parsedOut.status ?? (run.status === 0 ? "ok" : "error"));
    } catch {
      answer = (run.stdout || "").trim();
      status = run.status === 0 ? "ok" : "error";
    }
    const passed = status === "ok" && answer.includes(expected);
    const report = { ok: passed, expected, answer: answer.slice(0, 120), status, seconds: elapsed };
    if (parsed.isJson) {
      process.stdout.write(JSON.stringify(report) + "\n");
    } else if (passed) {
      process.stdout.write(`✓ كناري سليم — توقّعنا ${expected} وجاء «${answer.slice(0, 40)}» في ${elapsed}s\n`);
    } else {
      process.stdout.write(
        `⛔ كناري فاشل — توقّعنا ${expected} وجاء «${answer.slice(0, 60)}» (الحالة ${status}, ${elapsed}s)\n`,
      );
      process.stdout.write("لا تُشغّل دفعة مرشحين قبل معرفة السبب.\n");
    }
    process.exitCode = passed ? 0 : 1;
    return;
  }

  if (parsed.subcommand === "outgoing") {
    const rows = listConsults({ limit: parsed.limit ?? 10, session: parsed.session });
    if (parsed.isJson) {
      process.stdout.write(
        JSON.stringify(rows.map((r) => ({ id: r.id, created_at: r.created_at, session: r.session, sent: r.question }))) + "\n",
      );
    } else {
      rows.forEach((r) => {
        process.stdout.write(`\n--- ${r.id.slice(0, 8)} · ${r.created_at.slice(0, 19)} · ${r.session}\n`);
        process.stdout.write(r.question.slice(0, 1200) + "\n");
      });
      process.stdout.write(`\n(${rows.length} رسالة كما أُرسلت فعلاً — افحصها بحثاً عن اسم أو رقم أو معرّف نجا من الحجب)\n`);
    }
    process.exitCode = 0;
    return;
  }

  if (parsed.subcommand === "audit" || parsed.subcommand === "retire") {
    const all = listConsults({ limit: 5000 });
    const dual = findDualUrlSessions(all);
    const shared = findSharedUrls(all);

    if (parsed.subcommand === "audit") {
      const report = {
        ok: shared.length === 0 && dual.length === 0,
        keys: new Set(all.map((r) => r.session)).size,
        consults: all.length,
        sharedConversations: shared,
        dualUrlKeys: dual,
      };
      if (parsed.isJson) {
        process.stdout.write(JSON.stringify(report) + "\n");
      } else {
        process.stdout.write(`مفاتيح: ${report.keys} · استشارات: ${report.consults}\n`);
        process.stdout.write(
          shared.length
            ? `⚠ محادثات يتشاركها أكثر من مفتاح: ${shared.length}\n`
            : "✓ لا محادثة يتشاركها مفتاحان\n",
        );
        if (dual.length) {
          process.stdout.write(`⚠ مفاتيح لها أكثر من رابط (${dual.length}):\n`);
          dual.forEach((d) => process.stdout.write(`   - ${d.session} (${d.urls.length} روابط، ${d.consults} استشارة)\n`));
          process.stdout.write("   شغّل: acp qwen retire\n");
        } else {
          process.stdout.write("✓ كل مفتاح على رابط واحد\n");
        }
      }
      process.exitCode = report.ok ? 0 : 1;
      return;
    }

    // retire
    if (dual.length === 0) {
      process.stdout.write("لا يوجد ما يستحق الإعدام — كل مفتاح على رابط واحد.\n");
      process.exitCode = 0;
      return;
    }
    const dryRun = argv.includes("--dry-run");
    for (const d of dual) {
      if (!dryRun) {
        // Abandon the live tab/URL binding only. The archive keeps every record,
        // and the next consultation opens a fresh anchored conversation which is
        // rehydrated from exactly that archive.
        dropSession(d.session);
        insertConsult({
          session: d.session,
          question: "[retired]",
          answer: null,
          status: "error",
          error: `retired: key held ${d.urls.length} conversation URLs; next consultation starts a fresh anchored conversation rehydrated from the archive`,
          metadata: JSON.stringify({ retired: true, urls: d.urls }),
        });
      }
      process.stdout.write(`${dryRun ? "[تجريبي] " : ""}أُعدم: ${d.session} (${d.urls.length} روابط)\n`);
    }
    process.exitCode = 0;
    return;
  }

  if (parsed.subcommand === "list") {
    const rows = listConsults({
      session: subjectId || parsed.vip ? effectiveSessionName : parsed.session,
      search: parsed.search,
      since: parsed.since,
      limit: parsed.limit,
    });
    if (parsed.isJson) {
      process.stdout.write(JSON.stringify(rows, null, 2) + "\n");
    } else {
      if (rows.length === 0) {
        process.stdout.write("[]\n");
      } else {
        const header = "ID       | DATE                     | SESSION    | QUESTION                                                     | DURATION | STATUS";
        const divider = "-".repeat(110);
        const lines = rows.map((r) => {
          const shortId = r.id.slice(0, 8);
          const dateStr = r.created_at.slice(0, 19).replace("T", " ");
          const sess = (r.session || "default").padEnd(10).slice(0, 10);
          const q = r.question.replace(/\n/g, " ").padEnd(60).slice(0, 60);
          const dur = r.duration_ms !== null ? `${r.duration_ms}ms`.padEnd(8) : "N/A     ";
          return `${shortId} | ${dateStr} | ${sess} | ${q} | ${dur} | ${r.status}`;
        });
        process.stdout.write([header, divider, ...lines].join("\n") + "\n");
      }
    }
    process.exit(0);
  }

  if (parsed.subcommand === "show") {
    if (!parsed.id) {
      process.stderr.write("usage: acp qwen show <id> [--json]\n");
      process.exit(2);
    }
    const rec = getConsult(parsed.id);
    if (!rec) {
      process.stderr.write(`record not found: ${parsed.id}\n`);
      process.exit(1);
    }
    if (parsed.isJson) {
      process.stdout.write(JSON.stringify(rec, null, 2) + "\n");
    } else {
      let redactionInfo = "none";
      if (rec.metadata) {
        try {
          const meta = JSON.parse(rec.metadata);
          if (meta.redactionDisabled) {
            redactionInfo = "disabled (--no-redact used)";
          } else if (Array.isArray(meta.redactions) && meta.redactions.length > 0) {
            const counts: Record<string, number> = {};
            for (const h of meta.redactions) {
              counts[h.kind] = (counts[h.kind] || 0) + 1;
            }
            redactionInfo = Object.entries(counts)
              .map(([k, c]) => `${c} ${k}`)
              .join(", ");
          }
        } catch {}
      }

      const out = [
        `ID:           ${rec.id}`,
        `Date:         ${rec.created_at}`,
        `Session:      ${rec.session}`,
        `Model:        ${rec.model ?? "unknown"}`,
        `Thinking:     ${rec.thinking ?? "unknown"}`,
        `Redactions:   ${redactionInfo}`,
        `URL:          ${rec.conversation_url ?? "none"}`,
        `Duration:     ${rec.duration_ms !== null ? `${rec.duration_ms}ms` : "N/A"}`,
        `Status:       ${rec.status}${rec.error ? ` (${rec.error})` : ""}`,
        `--- Question ---`,
        rec.question,
        `--- Answer ---`,
        rec.answer ?? "(no answer recorded)",
      ].join("\n");
      process.stdout.write(out + "\n");
    }
    process.exit(0);
  }

  if (parsed.subcommand === "stats") {
    const stats = consultStats();
    if (parsed.isJson) {
      process.stdout.write(JSON.stringify(stats, null, 2) + "\n");
    } else {
      const out = [
        `Total consultations: ${stats.total}`,
        `Success rate:        ${stats.successRatePercent}% (${stats.successCount}/${stats.total})`,
        `Median duration:     ${stats.medianDurationMs !== null ? `${stats.medianDurationMs}ms` : "N/A"}`,
        `Slowest duration:    ${stats.slowestDurationMs !== null ? `${stats.slowestDurationMs}ms` : "N/A"}`,
        `Sessions:`,
        ...Object.entries(stats.sessionCounts).map(([s, c]) => `  - ${s}: ${c}`),
      ].join("\n");
      process.stdout.write(out + "\n");
    }
    process.exit(0);
  }

  if (parsed.subcommand === "export") {
    const rows = listConsults({ session: subjectId || parsed.vip ? effectiveSessionName : parsed.session, limit: 10000 });
    if (parsed.format === "md") {
      const mdLines: string[] = [`# Qwen Consultations Archive (${rows.length} records)`, ""];
      for (const r of rows) {
        mdLines.push(`## ${r.created_at} — Session: ${r.session} (${r.status})`);
        if (r.conversation_url) mdLines.push(`URL: ${r.conversation_url}`);
        mdLines.push(`Model: ${r.model ?? "N/A"} | Thinking: ${r.thinking ?? "N/A"} | Duration: ${r.duration_ms ?? "N/A"}ms`);
        mdLines.push("");
        mdLines.push(`### Question`);
        mdLines.push(r.question);
        mdLines.push("");
        mdLines.push(`### Answer`);
        mdLines.push(r.answer || `*(no answer: ${r.error || r.status})*`);
        mdLines.push("");
        mdLines.push("---");
        mdLines.push("");
      }
      process.stdout.write(mdLines.join("\n") + "\n");
    } else {
      process.stdout.write(JSON.stringify(rows, null, 2) + "\n");
    }
    process.exit(0);
  }

  // `acp qwen mode [Fast|Auto|Thinking]` — read or set the thinking mode as a
  // DELIBERATE act.
  //
  // Every other path treats the mode as borrowed: change it if asked, put it
  // back afterwards. That is the right default, but it leaves no way to say "this
  // is the mode I want from now on" — and after a leak left this account sitting
  // on Thinking, the only honest repair was one the owner performs explicitly,
  // not one a consultation performs as a side effect.
  // `acp qwen redact --cv-file <path>` — redact a document ON ITS OWN.
  //
  // Redaction reads a document from the top: the owner's name is found on the
  // first lines, where a CV puts it. Wrap that CV inside a longer prompt and the
  // heading is no longer at the top — it sits below the instructions, outside the
  // window, and the name walks straight through while the phone and e-mail (which
  // are matched by shape, anywhere) are still redacted correctly. The result looks
  // safe, and is not. It happened here.
  //
  // Widening the window is not the fix — a Title-Case line deeper in a CV is
  // usually a heading, not a person, and over-redaction destroys the very content
  // the advice is built on. The fix is layering: whoever embeds a document
  // redacts it AS a document first, and the consultation's own redaction stays as
  // a second net rather than the only one.
  // `acp qwen leaks` — the inventory of what already left.
  //
  // A fix answers "will it happen again". It does not answer "what already went
  // out", and that second question is the one a person whose CV we sent would
  // ask. The archive stores the redacted text that actually travelled, so this is
  // a matter of record rather than recollection.
  if (parsed.subcommand === "leaks") {
    const rows = listConsults({ limit: parsed.limit ?? 100000 });
    const report = summarize(rows);

    if (parsed.isJson) {
      process.stdout.write(JSON.stringify(report, null, 2) + "\n");
      process.exitCode = report.confirmed > 0 || report.suspect > 0 ? 1 : 0;
      return;
    }

    process.stdout.write(`فُحص: ${report.scanned} استشارة
`);
    if (report.confirmed === 0 && report.suspect === 0) {
      process.stdout.write("✓ لا اسم غادر الجهاز في أي سجل\n");
      process.exitCode = 0;
      return;
    }

    process.stdout.write(`⛔ مؤكد: ${report.confirmed} · مشتبه: ${report.suspect}

`);
    for (const f of report.findings) {
      const when = f.created_at.slice(0, 16).replace("T", " ");
      const what = f.names.length ? f.names.join(" · ") : "(الاسم غير مستخرَج من النص المحفوظ)";
      const tag = f.level === "confirmed" ? "مؤكد " : "مشتبه";
      process.stdout.write(`${tag} | ${when} | ${f.session}
        ${what}
`);
    }
    process.stdout.write(`
المفاتيح المتأثرة (${report.sessions.length}): ${report.sessions.join(", ")}
`);
    // Non-zero: this is a finding, and a script that checks it should notice.
    process.exitCode = 1;
    return;
  }

  if (parsed.subcommand === "redact") {
    if (!parsed.cvFile) {
      process.stderr.write("usage: acp qwen redact --cv-file <path> [--redact <names>] [--json]\n");
      process.exitCode = 2;
      return;
    }
    let raw = "";
    try {
      raw = readFileSyncNode(parsed.cvFile, "utf8");
    } catch (err) {
      process.stderr.write(`error: cannot read ${parsed.cvFile}: ${err instanceof Error ? err.message : String(err)}
`);
      process.exitCode = 2;
      return;
    }
    const out = redactPII(raw, parsed.redact);
    if (parsed.isJson) {
      process.stdout.write(
        JSON.stringify({
          text: out.text,
          clean: out.clean,
          // The ORIGINAL values are never printed — the point of this command is
          // to stop those values travelling, not to hand them to another process.
          hits: out.hits.map((h) => ({ kind: h.kind, placeholder: h.placeholder })),
        }) + "\n",
      );
    } else {
      process.stdout.write(out.text);
    }
    process.exitCode = 0;
    return;
  }

  if (parsed.subcommand === "mode") {
    const extStatus = await ensureExtensionReady();
    if (!extStatus.ready) {
      process.stderr.write(
        "extension not connected — run `acp web hub start` and switch the bridge on in the extension popup\n",
      );
      process.exitCode = 4;
      return;
    }
    const transport = await ExtensionTransport.createTab({ url: "https://chat.qwen.ai/" });
    const tab = BrowserTab.fromTransport(transport);
    preMark("open");
  const ready = await tab.waitFor({ untilJs: COMPOSER_READY_JS, timeoutMs: 30000 });
    if (!ready.ok) {
      process.stderr.write(`error: chat.qwen.ai did not finish loading (${String(ready.error)})\n`);
      process.exitCode = 4;
      return;
    }

    const target = parsed.mode ?? null;
    if (!target) {
      const cur = await readMode(tab);
      const mdl = await readModel(tab);
      const pending = readPendingRestore();
      process.stdout.write(
        parsed.isJson
          ? JSON.stringify({ mode: cur.value, model: mdl.value, rung: cur.rung, pendingRestore: pending?.mode ?? null }) + "\n"
          : `mode: ${cur.value ?? "unknown"}\nmodel: ${mdl.value ?? "unknown"}\nmatched by: ${cur.rung ?? "nothing"}` +
              (pending ? `\npending repair: ${pending.mode}` : "") +
              "\n",
      );
      process.exitCode = cur.value ? 0 : 4;
      return;
    }

    try {
      const res = await ensureMode(tab, target);
      // Set on purpose means this IS the user's mode now — no repair is owed.
      clearPendingRestore();
      process.stdout.write(
        parsed.isJson
          ? JSON.stringify({ ok: true, mode: res.current, previous: res.previous, changed: res.changed, via: res.via }) + "\n"
          : res.changed
            ? `✓ thinking mode set to ${res.current} (was ${res.previous}, via ${res.via})\n`
            : `✓ thinking mode already ${res.current}\n`,
      );
      process.exitCode = 0;
      return;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`error: ${msg}\n`);
      if (err instanceof WidgetError && err.rungsTried.length) {
        process.stderr.write(`       selectors tried: ${err.rungsTried.join(" | ")}\n`);
      }
      process.exitCode = 4;
      return;
    }
  }

  // `acp qwen last` — read what is WAITING in this conversation, without
  // opening a browser and without sending anything.
  //
  // This is the command that did not exist on 2026-08-21. Qwen ended a reply
  // with a question; the agent had no way to see it, so it improvised a new
  // session, opened a new conversation, and asked something unrelated there.
  // `awaitingReply` says plainly whether a reply is owed, and the answer to it
  // goes back with `acp qwen "<reply>" --session <same name>`.
  if (parsed.subcommand === "last") {
    const last = lastConsultForSession(effectiveSessionName);
    if (!last) {
      const msg = `no consultation recorded for session: ${effectiveSessionName}`;
      if (parsed.isJson) {
        process.stdout.write(JSON.stringify({ session: effectiveSessionName, found: false, error: msg }) + "\n");
      } else {
        process.stderr.write(msg + "\n");
      }
      process.exit(1);
    }
    const awaiting = last.status === "ok" && endsWithQuestion(last.answer);
    if (parsed.isJson) {
      process.stdout.write(
        JSON.stringify({
          session: effectiveSessionName,
          found: true,
          createdAt: last.created_at,
          status: last.status,
          conversationUrl: last.conversation_url,
          model: last.model,
          thinking: last.thinking,
          question: last.question,
          answer: last.answer,
          awaitingReply: awaiting,
          replyWith: `acp qwen "<your reply>" --session ${effectiveSessionName} --json`,
        }) + "\n",
      );
    } else {
      const out = [
        `session:      ${effectiveSessionName}`,
        `when:         ${last.created_at}`,
        `status:       ${last.status}`,
        `conversation: ${last.conversation_url ?? "(none)"}`,
        `awaiting your reply: ${awaiting ? "YES" : "no"}`,
        ``,
        `--- question sent (${(last.question || "").length} chars) ---`,
        last.question || "",
        ``,
        `--- answer received (${(last.answer || "").length} chars) ---`,
        last.answer || "(none)",
        ``,
      ];
      if (awaiting) {
        out.push(`Qwen is waiting. Reply IN THIS conversation:`);
        out.push(`  acp qwen "<your reply>" --session ${effectiveSessionName} --json`);
        out.push("");
      }
      process.stdout.write(out.join("\n"));
    }
    process.exit(0);
  }

  if (parsed.subcommand === "resume") {
    const last = lastConsultForSession(effectiveSessionName);
    if (!last || !last.conversation_url) {
      process.stderr.write(`no resumable conversation URL found for session: ${effectiveSessionName}\n`);
      process.exit(1);
    }
    const extStatus = await ensureExtensionReady();
    if (!extStatus.ready) {
      process.stderr.write("extension not connected — run `acp web hub start` and switch the bridge on in the extension popup\n");
      process.exit(4);
    }
    const transport = await ExtensionTransport.createTab({ url: last.conversation_url });
    putSession(effectiveSessionName, {
      targetId: transport.targetId,
      readOnly: false,
      createdAt: new Date().toISOString(),
      resumeUrl: last.conversation_url,
      lastUrl: last.conversation_url,
    });
    process.stdout.write(last.conversation_url + "\n");
    process.exit(0);
  }

  // An evaluation supplies its question from the CV file + rubric, and a
  // `--file` payload can stand on its own, so a positional is optional there.
  if (!parsed.question && !parsed.cvFile && !parsed.files?.length) {
    process.stderr.write(
      'usage: acp qwen "<question>" [--file <path>]... [--session <name>] [--vip <id>] [--cv-id <id> --job <j> [--cv-file <path>]] [--redact <names>] [--no-redact] [--deep] [--retries N] [--new] [--new-session] [--timeout <ms>] [--json]\n',
    );
    process.exit(2);
  }

  // --- `--file`: carry the CONTENT, never the name -------------------------
  //
  // Before this flag existed the only way to send a file was to paste it into a
  // shell argument, so the shortcut was to write the NAME and move on. The
  // archive holds the exact command that did it, on 2026-08-21T06:41:57Z:
  //
  //   acp qwen "... إليك دستور GEMINI.md. أعد صياغته ..." --session rules-qwen-fix-2026
  //
  // 128 characters. GEMINI.md is 6858 bytes and none of them were sent, so the
  // answer that came back was an opinion about a filename.
  if (parsed.files?.length) {
    const built = buildFileBlocks(parsed.files, (f) => readFileSyncNode(f, "utf8"));
    if (built.error) {
      process.stderr.write(`error: ${built.error}\n`);
      process.exit(2);
    }
    parsed.question = [parsed.question ?? "", ...built.blocks].filter(Boolean).join("\n\n");
  }

  // --- The gate that makes the shortcut impossible -------------------------
  // Exempt for the same reason as the session refusal below: a caller that
  // BUILDS its prompt in code already decided what to include. This gate is for
  // a prompt typed by an agent that meant to attach a file and wrote its name.
  if (!parsed.noFileCheck && !parsed.cvFile && process.env.ACP_QWEN_ALLOW_NEW_SESSION !== "1") {
    const bare = uncarriedFileMentions(parsed.question ?? "", parsed.files?.length ?? 0);
    if (bare.length > 0) {
      const flags = bare.map((f) => `--file "${f}"`).join(" ");
      process.stderr.write(
        [
          `error: the question names ${bare.join(", ")} but does not carry it.`,
          `  The question is ${(parsed.question ?? "").trim().length} characters — too small to hold that file,`,
          `  so the consulted model would only see the name.`,
          ``,
          `  Attach the content instead:`,
          `    acp qwen "<your question>" ${flags} --session ${effectiveSessionName} --json`,
          ``,
          `  If you really only meant to mention the name, add --no-file-check.`,
          ``,
        ].join("\n"),
      );
      process.exit(2);
    }
  }

  // --- The gate against asking for a blessing on unseen work ---------------
  // Same exemption rule: a prompt built in code, or one that already carries a
  // file, is not the failure this catches.
  if (!parsed.noEvidenceCheck && !parsed.cvFile && process.env.ACP_QWEN_ALLOW_NEW_SESSION !== "1") {
    if (needsEvidence(parsed.question ?? "", parsed.files?.length ?? 0)) {
      process.stderr.write(
        [
          `error: the question reports work already done, but carries no proof of it.`,
          `  The advisor has no tools and no filesystem — it sees only this sentence,`,
          `  so it will judge whatever you assert. On 2026-08-21 that produced`,
          `  "an excellent step reflecting architectural maturity" about a merge that`,
          `  had silently dropped four of the mechanisms it claimed to have kept.`,
          ``,
          `  Attach what actually changed:`,
          `    acp qwen "<your question>" --file "<the file you changed>" --session ${effectiveSessionName} --json`,
          ``,
          `  Or paste the real output into the question: an exit code, a diff, a log,`,
          `  a fenced code block, a full path.`,
          ``,
          `  Better still, ask BEFORE doing it, not after.`,
          `  To override: --no-evidence-check.`,
          ``,
        ].join("\n"),
      );
      process.exit(2);
    }
  }

  // --- The gate that keeps one subject in one conversation -----------------
  //
  // A key is bound to a conversation URL, so a new key is a new conversation.
  // Five keys were born in eight minutes on 2026-08-21 across four URLs; Qwen's
  // follow-up was left unanswered in the conversation the agent had just walked
  // out of. An anchored subject (--cv-id / --task / --vip) is exempt: isolation
  // is its whole purpose.
  // ACP_QWEN_ALLOW_NEW_SESSION is set by the in-process callers (`ask()`, the
  // advisor) whose keys are derived from a subject rather than typed. Without
  // it this refusal broke them: a first consultation about a new job posting or
  // a new advice run has, by definition, no conversation yet.
  const allowNewSessionEnv = process.env.ACP_QWEN_ALLOW_NEW_SESSION === "1";
  if (!subjectId && !parsed.vip && !parsed.newSession && !allowNewSessionEnv) {
    const known = getSession(effectiveSessionName) || lastConsultForSession(effectiveSessionName);
    if (!known) {
      const seen = listConsults({ limit: 400 })
        .map((r) => r.session)
        .filter((x): x is string => Boolean(x));
      const recent = [...new Set(seen)].slice(0, 8);
      process.stderr.write(
        [
          `error: --session ${effectiveSessionName} has no conversation yet, so this would open a new one.`,
          `  A new conversation cannot see what Qwen already asked you.`,
          ``,
          `  Continue an existing conversation:`,
          ...recent.map((r) => `    acp qwen "<question>" --session ${r} --json`),
          ``,
          `  Read what is waiting there first:  acp qwen last --session <name>`,
          `  Or open a new one on purpose:      add --new-session`,
          ``,
        ].join("\n"),
      );
      process.exit(2);
    }
  }

  // Feature 4: Auto-prune idle tabs before starting consultation
  await autoPruneIdleTabs(effectiveSessionName);

  // Mandatory consultation execution path
  const extStatus = await ensureExtensionReady();
  if (!extStatus.ready) {
    process.stderr.write("extension not connected — run `acp web hub start` and switch the bridge on in the extension popup\n");
    process.exit(4);
  }

  // Feature 1 & 2: PII Redaction processing
  const extraLiterals: string[] = [];
  if (parsed.vip) {
    extraLiterals.push(parsed.vip);
  }
  if (parsed.redact && parsed.redact.length > 0) {
    extraLiterals.push(...parsed.redact);
  }

  // An evaluation is just a consultation whose question is the rubric. Reusing
  // the same pipeline means it inherits redaction, the anchor, the correlation
  // tag, the retries and the archive for free.
  if (parsed.cvFile) {
    if (!cvFp) {
      process.stderr.write(
        "error: --cv-file requires --cv-id (an evaluation belongs to a candidate)\n",
      );
      process.exitCode = 2;
      return;
    }
    let cvText = "";
    try {
      cvText = readFileSyncNode(parsed.cvFile, "utf8");
    } catch (err: any) {
      process.stderr.write(
        `error: cannot read CV file: ${String(err?.message || err)}\n`,
      );
      process.exitCode = 2;
      return;
    }
    parsed.question = buildEvaluationPrompt({
      cvText,
      criteria: parsed.criteria,
      jobTitle: parsed.jobId,
    });
  }

  let questionToSend: string = parsed.question ?? "";
  let redactionMeta: Record<string, any> = {};

  if (parsed.noRedact) {
    process.stderr.write("warning: PII redaction disabled by --no-redact flag\n");
    redactionMeta = { redactionDisabled: true };
  } else {
    const redactRes = redactPII(questionToSend, extraLiterals);
    questionToSend = redactRes.text;
    if (!redactRes.clean) {
      const counts: Record<string, number> = {};
      for (const h of redactRes.hits) {
        counts[h.kind] = (counts[h.kind] || 0) + 1;
      }
      const summaryStr = Object.entries(counts)
        .map(([k, c]) => `${c} ${k}`)
        .join(", ");
      process.stderr.write(`redacted: ${summaryStr}\n`);
    }
    redactionMeta = {
      redactions: redactRes.hits.map((h) => ({ kind: h.kind, placeholder: h.placeholder })),
    };
  }

  let resumeUrl: string | null = null;
  if (!parsed.isNew) {
    const last = lastConsultForSession(effectiveSessionName);
    if (last?.conversation_url) {
      resumeUrl = last.conversation_url;
    }
  }

  // Dry run: show the exact text that WOULD leave this machine, and send nothing.
  // This is the only place a human can catch a redaction miss, because after the
  // send it is already outside.
  if (argv.includes("--preview")) {
    const preview = {
      ok: true,
      preview: true,
      session: effectiveSessionName,
      wouldSend: questionToSend,
      redactions: redactionMeta,
    };
    if (parsed.isJson) {
      process.stdout.write(JSON.stringify(preview) + "\n");
    } else {
      process.stdout.write("=== ما سيُرسل فعلاً (لم يُرسل شيء) ===\n");
      process.stdout.write(questionToSend + "\n");
    }
    process.exitCode = 0;
    return;
  }

  // One writer per candidate. Two runs interleaving inside one conversation is
  // exactly the mixing this must make impossible; different candidates stay
  // fully parallel.
  let lockedKey: string | null = null;
  if (cvFp) {
    const got = acquireLock(effectiveSessionName);
    if (!got.ok) {
      process.stderr.write(
        `error: another run holds this candidate's conversation (pid ${got.heldBy.pid}, since ${got.heldBy.acquiredAt})\n`,
      );
      process.exitCode = 4;
      return;
    }
    lockedKey = effectiveSessionName;
    const release = () => {
      if (lockedKey) releaseLock(lockedKey);
      lockedKey = null;
    };
    process.once("exit", release);
    process.once("SIGINT", () => {
      release();
      process.exit(130);
    });
  }

  // Every question carries a tag the answer must repeat, so a stale or duplicated
  // answer is detected instead of silently accepted. A brand-new CV conversation
  // also opens with the anchor line that proves whose conversation it is.
  const seq = cvFp ? (lastConsultForSession(effectiveSessionName) ? 2 : 1) : 0;
  const token = cvFp ? correlationToken(seq) : null;
  if (token) {
    // The anchor must live where it can be READ back later. Qwen's UI does not
    // expose the user's own messages to innerText — only the model's replies —
    // so an anchor typed into the question is invisible to any later check and
    // every resume looked like a foreign conversation. The model is therefore
    // asked to echo the anchor ONCE, in its first reply; from then on the check
    // is a pure DOM read with no model involvement.
    // Open with a neutral line so the site's auto-generated conversation TITLE is
    // derived from it. Checking the account showed one conversation titled with
    // our raw anchor fingerprint — not personal data (it is an HMAC), but the
    // title is stored on a third-party service and should carry nothing but a
    // generic label.
    const anchorInstruction = resumeUrl
      ? ""
      : `استشارة مهنية.\n${anchorLine(cvFp!)}\nابدأ ردّك الأول بسطر مطابق حرفياً: ${anchorLine(cvFp!)}\n`;
    questionToSend = `${anchorInstruction}${token} ابدأ جوابك بترديد الوسم ${token} حرفياً ثم أجب.\n\n${questionToSend}`;
  }

  // Do not open a browser to be told "no" again.
  //
  // The site states a daily limit once, in a toast that is gone in seconds. Every
  // run that forgets it repeats the whole expensive discovery — tab, load, type,
  // send, wait — and each repetition is another request against an account that
  // has already been asked to stop. Refusing here is the correct answer, and it
  // takes a second instead of a minute.
  preMark("boot");
  const known = readLimit();
  const verdict = checkLimit(known, Date.now());
  if (verdict.blocked && !parsed.force) {
    process.stderr.write(
      `الحساب موقوف: ${known?.notice ?? "حدّ استخدام"}\n` +
        `تبقّى ${describeWait(verdict.remainingMinutes)}. للتجاوز: --force\n`,
    );
    process.exitCode = 5;
    return;
  }
  if (verdict.probeDue) {
    process.stderr.write("انتهت المدة المقدّرة — هذه المحاولة جسّ للتأكد.\n");
  }

  preMark("prep");
  const startUrl = resumeUrl || "https://chat.qwen.ai/";

  // Go back to this key's OWN tab instead of opening another one.
  //
  // The session record has carried a targetId all along and nothing ever read it
  // back, so every consultation opened a fresh tab: ten questions left ten tabs
  // behind, each paying a full page load, and each starting from the account
  // default mode rather than the one the previous run had already set. The
  // machinery to return was there — `ExtensionTransport.attachTab` — merely
  // unused.
  //
  // A stale record is expected, not exceptional: the owner closes tabs. So a
  // failed attach is not an error, it just means opening a new one.
  let transport: ExtensionTransport | null = null;
  let tab: BrowserTab | null = null;
  // Did this run actually load a page? Everything that waits for "the page to
  // settle" is only meaningful when something was loaded.
  let didNavigate = false;
  const previous = getSession(effectiveSessionName);

  if (previous?.targetId) {
    try {
      const candidate = await ExtensionTransport.attachTab({ tabId: Number(previous.targetId) });
      const candidateTab = BrowserTab.fromTransport(candidate);

      // Attaching is not proof the tab is alive.
      //
      // A closed tab still attaches — the id is accepted and every call after it
      // fails instead. Ten questions in a row died 0.4s apart because of exactly
      // that, after `gc` had closed the tabs the session records still pointed
      // at. So the attachment is PROVED with one cheap read before anything is
      // built on it, and a stale record simply means opening a new tab.
      const probe = await candidateTab.evaluate("location.href");
      const at = probe.ok && typeof probe.value === "string" ? probe.value : "";
      if (at) {
        transport = candidate;
        tab = candidateTab;
        // Navigate only when the tab is not already where it needs to be:
        // reloading the conversation we are already looking at throws away the
        // rendered history and the thinking mode for nothing.
        if (sameConversation(at, startUrl)) {
          process.stderr.write(`tab: reused ${previous.targetId} (no reload)\n`);
        } else {
          process.stderr.write(`tab: reused ${previous.targetId}, moving to the conversation\n`);
          await tab.navigate(startUrl);
        }
      }
    } catch {
      transport = null;
      tab = null;
    }
  }

  preMark("attach");
  if (!transport || !tab) {
    process.stderr.write("tab: opened a new one\n");
    transport = await ExtensionTransport.createTab({ url: startUrl });
    tab = BrowserTab.fromTransport(transport);
  }

  // Waiting for the composer to EXIST is not enough. The page ships a shell with
  // a textarea, and when hydration finishes the app rebuilds the composer and
  // WIPES whatever was typed into it. Everything downstream then looks like a
  // silent send failure: the text is gone, the send button is gone, and the run
  // reports "no response started". Wait for the app itself to be mounted —
  // document complete, the composer present, and the model/thinking widget
  // rendered (that widget only appears once the real UI has taken over).
  const ready = await tab.waitFor({
    untilJs: COMPOSER_READY_JS,
    timeoutMs: 30000,
  });
  if (!ready.ok) {
    process.stderr.write(
      `error: chat.qwen.ai did not finish loading (${String(ready.error ?? "no composer")})\n`
    );
    process.exitCode = 4;
    return;
  }

  // Identity check before a single character is written into a resumed
  // conversation: the stored URL must be the URL we actually landed on, AND the
  // anchor in the conversation's first message must be this candidate's.
  // The anchor is read from the DOM — the model is never asked to vouch for it.
  // Any mismatch abandons the conversation rather than risking a note about one
  // candidate landing in another's file.
  if (cvFp && resumeUrl) {
    // Scan the WHOLE conversation text, not the first answer block.
    // The anchor travels in the user's opening message, and the user's messages
    // are not rendered inside the markdown containers that hold the model's
    // replies — reading tops[0] returned the assistant's first answer, found no
    // anchor, and declared a mismatch on a perfectly valid conversation. That is
    // the worst kind of check: it fired correctly-looking alarms for a wrong
    // reason and silently discarded the candidate's real history.
    // A resumed conversation renders its history a few seconds AFTER the page is
    // otherwise ready. Judging identity before that is judging an empty page:
    // the anchor is missing simply because nothing has been drawn yet, and the
    // check then throws away a perfectly good conversation. Wait for the history
    // to actually appear first.
    await tab.waitFor({
      untilJs: `/ACP-LOCK:/i.test(document.body ? document.body.innerText : '') || document.querySelectorAll('[class*=markdown]').length > 0`,
      timeoutMs: 15000,
    });

    const idRes = await tab.evaluate(`(() => {
      const body = (document.body ? document.body.innerText : '') || '';
      const m = body.match(/ACP-LOCK:\\s*[0-9a-f]{8,64}/i);
      return JSON.stringify({ url: location.href, first: m ? m[0] : '' });
    })()`);
    let landedUrl: string | null = null;
    let firstMsg = "";
    if (idRes.ok && typeof idRes.value === "string") {
      try {
        const parsedId = JSON.parse(idRes.value);
        landedUrl = parsedId.url ?? null;
        firstMsg = parsedId.first ?? "";
      } catch {}
    }
    const urlOk = Boolean(landedUrl && resumeUrl && landedUrl.split("?")[0] === resumeUrl.split("?")[0]);
    const anchorOk = anchorMatches(parseAnchor(firstMsg), cvFp);
    if (!urlOk || !anchorOk) {
      process.stderr.write(
        `identity check failed (url ${urlOk ? "ok" : "mismatch"}, anchor ${anchorOk ? "ok" : "mismatch"}) — starting a fresh anchored conversation\n`,
      );
      insertConsult({
        session: effectiveSessionName,
        question: "[identity-check]",
        answer: null,
        model: null,
        thinking: null,
        conversation_url: resumeUrl,
        duration_ms: 0,
        status: "error",
        error: `identity check failed (url ${urlOk ? "ok" : "mismatch"}, anchor ${anchorOk ? "ok" : "mismatch"})`,
        metadata: JSON.stringify({ identityCheck: "failed" }),
      });
      resumeUrl = null;
      // The archive is the source of truth, so a lost conversation is a
      // recoverable event: rebuild the replacement from what we stored locally
      // instead of restarting this candidate's file from nothing.
      const past = listConsults({ session: effectiveSessionName, limit: 12 });
      const brief = buildRehydrationBrief(past);
      if (brief) {
        process.stderr.write(`rehydrating from archive (${past.length} records)\n`);
      }
      questionToSend =
        `${anchorLine(cvFp)}\n` +
        `ابدأ ردّك الأول بسطر مطابق حرفياً: ${anchorLine(cvFp)}\n` +
        (brief ? `${brief}\n\n` : "") +
        questionToSend;
      await tab.navigate("https://chat.qwen.ai/");
      didNavigate = true;
      await tab.waitFor({
        untilJs: COMPOSER_READY_JS,
        timeoutMs: 30000,
      });
    }
  }

  // The thinking mode belongs to the USER's account, so it is handled by one
  // owner with one rule: only change it when asked, and put it back no matter
  // how this process ends.
  //
  // A marker on disk holds the user's own mode from the moment we touch it. That
  // is what makes the promise keepable: the previous implementation restored in a
  // `finally`, and `process.exit` jumps over `finally` — so a single failed
  // --deep run left this account permanently in Thinking without anyone knowing.
  // Whoever runs next reads the marker and repairs it.
  const pending = readPendingRestore();
  preMark("limitNote");
  const observed = normalizeMode((await readMode(tab)).value);
  preMark("readMode");
  // The user's mode is what a crashed run recorded, or failing that, whatever the
  // widget shows right now.
  const userMode: ThinkingMode | null = pending?.mode ?? observed;

  if (pending && observed && pending.mode !== observed) {
    process.stderr.write(
      `note: repairing the thinking mode left as '${observed}' by an earlier run (yours is '${pending.mode}')\n`,
    );
  }

  const requestedMode: ThinkingMode | null = parsed.mode ?? null;
  // With no explicit request we still honour a pending repair, so the account
  // does not stay on someone else's setting.
  const targetMode: ThinkingMode | null = requestedMode ?? (pending ? pending.mode : null);

  // --- `--expect-model`: refuse to consult the wrong brain -----------------
  //
  // On 2026-08-20 at 23:42 the user said, of a consultation reported as
  // Qwen3.8-Max: "you wrote that you consulted Qwen 3.8 but the truth was it
  // was on 3.7". The model was read only AFTER the answer, and only into the
  // archive, so nothing ever compared it to what had been claimed.
  //
  // This reads the widget BEFORE the question is sent and stops there on a
  // mismatch. Refusing costs seconds; an answer credited to the wrong model
  // costs a decision. Note the CLI cannot yet SET the model — the composer
  // module has readModel but no setter — so this verifies rather than fixes,
  // and says so.
  if (parsed.expectModel) {
    const active = (await readModel(tab)).value;
    const want = parsed.expectModel.trim().toLowerCase();
    const got = (active ?? "").trim().toLowerCase();
    if (!got) {
      process.stderr.write(
        `error: --expect-model ${parsed.expectModel} but the active model could not be read from the page.\n` +
          `  Refusing rather than crediting the answer to a model nobody checked.\n`,
      );
      process.exitCode = 4;
      return;
    }
    if (got !== want) {
      process.stderr.write(
        [
          `error: --expect-model ${parsed.expectModel} but the page is on ${active}.`,
          `  Nothing was sent.`,
          ``,
          `  Pick the model in the Qwen model dropdown, then run this again.`,
          `  (acp qwen cannot switch it for you yet — it can only check.)`,
          ``,
          `  To consult ${active} anyway, drop the flag or pass --expect-model "${active}".`,
          ``,
        ].join("\n"),
      );
      process.exitCode = 2;
      return;
    }
    process.stderr.write(`model verified: ${active}\n`);
  }

  preMark("readyIdentity");
  // The mode is settled AFTER the question is typed, not before.
  //
  // Measured, twice, on tabs that both started from the same mode: setting it
  // first cost 9.4s and 8.2s and the send did not take effect at all; typing
  // first cost 6.6s and 4.8s and is the only order in which the send worked. The
  // likely cause is that operating the dropdown while the composer is empty
  // leaves the page in a state that swallows the send click — the owner noticed
  // this from watching the browser before any of it showed up in a measurement.
  //
  // Correctness is unaffected: the mode still governs the answer because it is
  // set before the SEND, and the record still reports the mode read after the
  // reply arrives.
  let switchedMode = false;
  const applyMode = async (): Promise<boolean> => {
    if (!targetMode) return true;
    try {
      const res = await ensureMode(tab, targetMode);
      preMark("ensureMode");
      // Asking for a mode is a PREFERENCE; --deep is a loan.
      //
      // Borrowing and returning made every call pay for both directions: a caller
      // that passes --mode Fast on every consultation had it set to Fast, used,
      // then put back to Thinking, so the next call switched again — 2.7s of
      // dropdown and settle on every single question, measured. A caller who
      // states the same mode every time is not borrowing; they are telling us
      // what their mode is.
      //
      // So an explicit --mode sticks, and only --deep (a one-off deep answer)
      // is returned afterwards. The record still reports the mode observed AFTER
      // the answer, so nothing about its truthfulness depends on this.
      const borrowed = Boolean(parsed.deep) && !parsed.mode;
      if (res.changed) {
        switchedMode = borrowed && targetMode !== userMode;
        if (switchedMode && userMode) writePendingRestore(userMode);
        else clearPendingRestore(); // this mode is now simply the tab's mode
      } else if (pending && targetMode === pending.mode) {
        clearPendingRestore();
      }
    } catch (err) {
      // Hard failure, and BEFORE a single character is written into the composer.
      // Running in the wrong mode corrupts the answer's depth, the wait budget
      // and the archived record of what produced it — all at once, all silently.
      const msg = err instanceof WidgetError ? err.message : String(err);
      process.stderr.write(`error: ${msg}
`);
      if (err instanceof WidgetError && err.rungsTried.length) {
        process.stderr.write(`       selectors tried: ${err.rungsTried.join(" | ")}
`);
      }
      process.exitCode = 4;
      return false;
    }
    return true;
  };

  let model: string | null = null;
  let thinking: string | null = null;

  try {
    const maxRetries = parsed.retries ?? 1;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) {
        // Every attempt measures itself.
        //
        // The pre-flight marks were module-level, so a mark taken at the top of
        // attempt 2 measured the whole of attempt 1 — one reading came out as
        // "mode: 29137ms" and sent me looking for a slow widget that was never
        // slow. A counter that inherits a previous attempt does not report, it
        // misleads.
        for (const k of Object.keys(preflight)) delete preflight[k];
        preAt = Date.now();
        await new Promise((r) => setTimeout(r, 3000));

        // Retry in place. Reload only if we must.
        //
        // This used to navigate unconditionally, which is a refresh — and a
        // refresh costs the rendered conversation, the thinking mode, and a full
        // page load, to recover from what is usually a dropped click. The rule
        // now lives in `retryNeedsReload`, so it is one testable decision instead
        // of an implicit habit.
        const here = await tab.evaluate("location.href");
        const at = here.ok && typeof here.value === "string" ? here.value : "";
        const stillReady = at
          ? (await tab.waitFor({ untilJs: COMPOSER_READY_JS, timeoutMs: 5000 })).ok
          : false;

        if (!stillReady || retryNeedsReload(at, startUrl)) {
          process.stderr.write("retry: reloading the page\n");
          await tab.navigate(startUrl);
          await tab.waitFor({ untilJs: COMPOSER_READY_JS, timeoutMs: 30000 });
          // The widget resets to the account default on every navigation, so a
          // reload has to put the mode back. Without this, attempt 2 silently ran
          // in a different mode than attempt 1 — same question, different engine,
          // no trace. Nothing to restore on the no-reload path: the mode never
          // moved.
          if (targetMode) {
            try {
              await ensureMode(tab, targetMode);
            } catch (err) {
              process.stderr.write(
                `could not restore ${targetMode} after the retry navigation: ` +
                  `${err instanceof Error ? err.message : String(err)}\n`,
              );
              process.exitCode = 4;
              return;
            }
          }
        } else {
          process.stderr.write("retry: same tab, no reload\n");
        }
      }

      preMark("mode");
      const startTime = Date.now();
      // Where the time actually goes, recorded with every consultation.
      //
      // Tuning this loop by intuition produced a 900ms sleep here and a 1.5s one
      // there, and nobody could say what any of them cost. Phase marks are a few
      // bytes in the archive and turn "it feels slow" into a number you can point
      // at — which is how the fixed waits above were found in the first place.
      const phases: Record<string, number> = {};
      let phaseAt = Date.now();
      const mark = (name: string) => {
        phases[name] = Date.now() - phaseAt;
        phaseAt = Date.now();
      };
      // Type, then confirm the text SURVIVED. A late hydration pass rebuilds the
      // composer and silently discards what was typed, so a fill that reported
      // success a moment ago can leave an empty box behind. Re-type until the
      // value is still there after a beat.
      // Typing is an action like any other: do it, then prove the text is in the
      // box and that the site did not object. The proof matters here more than
      // anywhere — a late hydration pass rebuilds the composer and silently
      // discards what was typed, and every symptom downstream then looks like a
      // send failure instead of a lost question.
      let fillVerdict = await actAndVerify(
        tab,
        () => tab.fill(COMPOSER_SELECTOR, questionToSend),
        { composerEmpty: false, composerSelector: COMPOSER_SELECTOR },
        { what: "كتابة السؤال", graceMs: 2000 },
      );
      let fillRes: { ok: boolean; error?: string } = fillVerdict.ok
        ? { ok: true }
        : { ok: false, error: fillVerdict.reason };
      for (let typeTry = 0; typeTry < 3; typeTry++) {
        if (!fillRes.ok) {
          await new Promise((r) => setTimeout(r, 1000));
          fillVerdict = await actAndVerify(
            tab,
            () => tab.fill(COMPOSER_SELECTOR, questionToSend),
            { composerEmpty: false, composerSelector: COMPOSER_SELECTOR },
            { what: "كتابة السؤال", graceMs: 2000 },
          );
          fillRes = fillVerdict.ok ? { ok: true } : { ok: false, error: fillVerdict.reason };
          continue;
        }
        // Wait for the CONDITION, not for a guess at how long hydration takes.
        //
        // This was a flat 900ms sleep on every single question. What it was
        // really checking is that the text is still in the box after the app has
        // had a beat to rebuild the composer — so it now polls for exactly that
        // and stops the moment it is satisfied. Same guarantee, a third of the
        // wait, and it waits LONGER than 900ms when the page is genuinely slow.
        const survived = await tab.waitFor({
          untilJs: `((document.querySelector(${JSON.stringify(COMPOSER_SELECTOR)})||{}).value||'').length > 0`,
          timeoutMs: 1500,
          intervalMs: 120,
        });
        // One more beat and one more read: hydration can wipe the box a moment
        // after the text first appears, which is the failure this loop exists
        // for. Two sightings a beat apart is the proof; a single one is not.
        if (survived.ok) {
          await new Promise((r) => setTimeout(r, 150));
          const kept = await tab.evaluate(
            `((document.querySelector(${JSON.stringify(COMPOSER_SELECTOR)})||{}).value||'').length`,
          );
          if (kept.ok && typeof kept.value === "number" && kept.value > 0) break;
        }
        fillRes = { ok: false, error: "composer was cleared by the page after typing" };
      }

      if (!fillRes.ok) {
        const duration_ms = Date.now() - startTime;
        const errText = fillRes.error ? String(fillRes.error) : "fill failed";
        const errRec = insertConsult({
          session: effectiveSessionName,
          question: questionToSend,
          answer: null,
          model,
          thinking,
          conversation_url: resumeUrl,
          duration_ms,
          status: "error",
          error: errText,
          metadata: JSON.stringify({ submitted: false, ...redactionMeta, attempt }),
        });
        if (attempt < maxRetries) {
          process.stderr.write(`fill failed on attempt ${attempt + 1}, retrying...\n`);
          continue;
        }
        if (parsed.isJson) {
          process.stdout.write(JSON.stringify(errRec) + "\n");
        } else {
          process.stderr.write(`error: ${errText}\n`);
        }
        // NOT process.exit: it jumps over the finally that hands the user their
        // thinking mode back. That leak is why this account sat on Thinking.
        process.exitCode = 4;
        return;
      }

      // The question is in the box; NOW settle the mode, then send.
      //
      // This ordering is the whole point of deferring it: with the composer
      // already holding text, the same switch that used to cost 8-9 seconds and
      // leave the send inert costs the same milliseconds and the send goes
      // through.
      if (!(await applyMode())) return;

      // Send, then VERIFY the composer actually emptied — a click that reports ok
      // but changes nothing was the single most misleading failure in this project.
      // If it did not go through, fall back to a trusted Enter: key events are
      // delivered to the focused element and are NOT hit-tested against a rendered
      // frame, so they survive the cases where a coordinate click silently misses.
      // How many answer blocks existed BEFORE this question. Everything that
      // appears after this index belongs to the reply we are about to request.
      // Measure the baseline only once the count has STOPPED changing.
      //
      // A resumed conversation paints its history a moment after the page is
      // otherwise usable. Sampling once caught a half-drawn page, the baseline
      // came out too low, and blocks that were merely late to render were then
      // treated as this question's answer — three different services returned
      // the same old reply, each looking perfectly successful.
      const countBlocks = async (): Promise<number> => {
        const r = await tab.evaluate(
          `(() => { const md=[...document.querySelectorAll('[class*=markdown]')]; return md.filter(e=>!e.parentElement||!e.parentElement.closest('[class*=markdown]')).length; })()`,
        );
        return r.ok && typeof r.value === "number" ? r.value : 0;
      };
      let baselineBlocks = await countBlocks();
      // Wait for the history to settle only if the history could still be moving.
      //
      // This loop exists because a resumed conversation paints its history a
      // moment after the page is otherwise usable, and a baseline measured too
      // early made late-rendering blocks look like this question's answer. But
      // that is a property of a page that just LOADED. When the tab was reused
      // without a reload — the common case now — nothing is pending: the history
      // has been on screen since the previous question, and 1.5s of sleeping
      // bought nothing. So it is skipped there, and made condition-driven rather
      // than sleep-driven where it is still needed.
      if (didNavigate) {
        for (let stable = 0; stable < 2; ) {
          await new Promise((r) => setTimeout(r, 200));
          const again = await countBlocks();
          if (again === baselineBlocks) stable++;
          else {
            baselineBlocks = again;
            stable = 0;
          }
        }
      }

      mark("fill");
      // Identity, not an index.
      //
      // Counting blocks assumed the page only ever APPENDS. It does not: a
      // resumed conversation re-renders its history, and after one such reshuffle
      // an older reply sat past the baseline index and was merged into the new
      // one — an answer came back with a previous answer glued to the front of
      // it, and nothing in the record showed that. So every block present before
      // we send is STAMPED, and its text is also hashed: a block that gets
      // destroyed and re-created by virtualisation loses the stamp but keeps its
      // text, and is still recognised as old.
      //
      // The deliberate trade: if the model ever repeats an earlier answer word
      // for word, we will not see it and the wait will time out. A loud timeout
      // is the better failure — the alternative is filing someone else's text.
      const seenRes = await tab.evaluate(`(() => {
        const h = (t) => { let x = 0; for (let i = 0; i < t.length; i++) { x = (x * 31 + t.charCodeAt(i)) | 0; } return x; };
        const md = [...document.querySelectorAll('[class*=markdown]')];
        const tops = md.filter(e => !e.parentElement || !e.parentElement.closest('[class*=markdown]'));
        // How MANY blocks carried each text, not merely which texts existed.
        // The count is what later distinguishes "the page re-created this block"
        // from "the model said the same thing again".
        const counts = {};
        for (const e of tops) {
          e.setAttribute('data-acp-seen', '1');
          const k = h((e.innerText || '').trim().slice(0, 300));
          counts[k] = (counts[k] || 0) + 1;
        }
        return JSON.stringify(counts);
      })()`);
      let seenCounts: Record<string, number> = {};
      if (seenRes.ok && typeof seenRes.value === "string") {
        try {
          seenCounts = JSON.parse(seenRes.value);
        } catch {}
      }

      mark("baseline");

      // The send button does not EXIST while the composer is empty.
      //
      // Measured, not assumed: probing the page before typing returns no
      // `.send-button` at all, and it appears about 40ms after the text lands.
      // So every consultation was clicking an element that had not been created
      // yet — the click failed, the run sat through a two-second timeout, and the
      // Enter fallback did the actual work. That was 3.2 seconds of the send
      // phase, blamed on the site.
      //
      // Waiting for the button to appear costs about 40ms and removes the
      // timeout, the fallback, and the wrong conclusion.
      await tab.waitFor({ selector: ".send-button", timeoutMs: 3000, intervalMs: 40 });
      let clickRes = await tab.click(".send-button");
      if (clickRes.ok) {
        // A successful send empties the composer. Watch for that instead of
        // sleeping through it: the signal usually arrives in under 200ms, and the
        // fixed 900ms wait was paid on every question whether or not it was
        // needed. The fallback below is unchanged — this only decides how long we
        // look before concluding the click did nothing.
        // Settle, then prove the send happened — the standing rule for every
        // action: what should vanish, what should appear, and did the site put up
        // a notice. A send that worked empties the composer AND removes the send
        // button (it only exists while there is text), and a refusal shows up as
        // a toast that would otherwise be discovered a minute later.
        const sent = await verifyAfterAction(
          tab,
          { composerEmpty: true, gone: [".send-button"], composerSelector: COMPOSER_SELECTOR },
          { settleMs: 400, graceMs: 1600 },
        );
        if (!sent.ok && sent.siteError) {
          process.stderr.write(`الموقع ردّ بإشعار بعد الإرسال: ${sent.state.notice}\n`);
        }
        const still = await tab.evaluate(
          `((document.querySelector(${JSON.stringify(COMPOSER_SELECTOR)})||{}).value||'').length`,
        );
        if (still.ok && typeof still.value === "number" && still.value > 0) {
          await tab.evaluate(
            `(()=>{const t=document.querySelector(${JSON.stringify(COMPOSER_SELECTOR)});if(t){t.focus();}return 1})()`,
          );
          // The fallback gets the same treatment: Enter is only a send if the
          // composer empties afterwards.
          const enterVerdict = await actAndVerify(
            tab,
            () => tab.press("Enter"),
            { composerEmpty: true, composerSelector: COMPOSER_SELECTOR },
            { what: "الإرسال بـ Enter", graceMs: 2000 },
          );
          if (!enterVerdict.ok) {
            clickRes = {
              ok: false,
              error: `send did not take effect: ${String(enterVerdict.reason)}`,
            };
          }
        }
      }
      if (!clickRes.ok) {
        const duration_ms = Date.now() - startTime;
        const errText = clickRes.error ? String(clickRes.error) : "click failed";
        const errRec = insertConsult({
          session: effectiveSessionName,
          question: questionToSend,
          answer: null,
          model,
          thinking,
          conversation_url: resumeUrl,
          duration_ms,
          status: "error",
          error: errText,
          metadata: JSON.stringify({ submitted: false, ...redactionMeta, attempt }),
        });
        if (attempt < maxRetries) {
          process.stderr.write(`click failed on attempt ${attempt + 1}, retrying...\n`);
          continue;
        }
        if (parsed.isJson) {
          process.stdout.write(JSON.stringify(errRec) + "\n");
        } else {
          process.stderr.write(`error: ${errText}\n`);
        }
        // NOT process.exit: it jumps over the finally that hands the user their
        // thinking mode back. That leak is why this account sat on Thinking.
        process.exitCode = 4;
        return;
      }

      const clickTime = Date.now();
      const timeoutMs = parsed.timeoutMs ?? modeTimeoutMs(thinking);

      mark("send");
      let pollStatus: "ok" | "site_error" | "stalled" | "timeout" | "error" | "tag_missing" | null = null;
      let siteErrorMatch: SiteErrorMatch | null = null;
      let siteErrorText = "";
      let extractedAnswer: string | null = null;
      let tagEchoed = true;
      let pollError: string | null = null;
      // "The text stopped changing AND the site is not working" — the shared
      // rule from web/stability.ts, not a second copy of it living here.
      //
      // This file used to carry its own hand-rolled version, and the copy drifted
      // in the way copies do: it never reset its quiet clock when the page said
      // it was still generating, so a window opened during one idle read could be
      // cashed in on another idle read many seconds later, with the site visibly
      // busy in between. That is how a reply reached a real member cut off
      // mid-word. The shared version folds the busy signal into every
      // observation, so the whole window must be quiet on both signals.
      let settle: StabilityState = initialState();
      let settleCheck = { settled: false, requiredMs: 0, quietMs: 0, idleSamples: 0, graced: false };
      const settleOpts = qwenSettleOptions(thinking);

      // The deadline applies to INACTIVITY, not to thinking.
      //
      // A flat total timeout cut off a long evaluation while the model was
      // visibly still generating — we threw away real work because a clock ran
      // out, which is the one failure the caller cannot recover from. As long as
      // the page shows generation in progress, or the answer text is still
      // growing, the wait is extended. Only silence ends it, plus a generous
      // absolute ceiling so nothing can hang forever.
      let lastProgressAt = Date.now();
      let lastLen = 0;
      const inactivityMs = Math.max(60000, timeoutMs);
      const hardCeilingMs = Math.max(15 * 60 * 1000, timeoutMs * 4);

      while (
        Date.now() - lastProgressAt < inactivityMs &&
        Date.now() - clickTime < hardCeilingMs
      ) {
        await new Promise((r) => setTimeout(r, 250));

        // a. Check site error
        // Scan ONLY real notification containers — never the page text.
        //
        // Feeding the last 1500 characters of body.innerText into the detector
        // meant the MODEL'S OWN ANSWER was searched for error wording: a reply
        // that happens to discuss "rate limit" or says "please try again" was
        // reported as a Qwen outage and a healthy consultation was aborted.
        // (Confirmed by the owner: his account has no rate limit at all.)
        // An error banner is a UI element, so look for the element.
        const pageErrRes = await tab.evaluate(`(() => {
          const containers = [...document.querySelectorAll('[role=alert], [class*=toast], .ant-message, [class*=notification]')];
          const texts = containers
            // Anything inside an answer block is content, not a page error.
            .filter(e => !e.closest('[class*=markdown]'))
            .map(e => (e.innerText || '').trim())
            // A real banner is short; a long paragraph is prose that happens to
            // sit in a styled container.
            .filter(t => t && t.length < 300);
          return texts.join('\\n');
        })()`);

        if (pageErrRes.ok && typeof pageErrRes.value === "string") {
          const match = detectSiteError(pageErrRes.value);
          if (match) {
            pollStatus = "site_error";
            siteErrorMatch = match;
            // Keep the WHOLE notice, not just the marker that matched it.
            //
            // A toast disappears within seconds, so by the time anyone looks the
            // evidence is gone and all that remains is a two-word fragment like
            // "You have reached" — enough to raise an alarm, not enough to tell a
            // real limit from a false positive. That ambiguity already cost this
            // project one wrong conclusion.
            siteErrorText = pageErrRes.value.slice(0, 300);
            pollError = `${match.kind}: ${match.marker}`;
            break;
          }
        }

        // b. Check answer state
        // Take EVERY block produced since we sent, not just the last one.
        //
        // A long structured answer is not one container: the page renders each
        // section as its own top-level block. Reading only the last one returned
        // two lines of a full CV evaluation and filed it as complete — the
        // truncation was invisible because the text that did arrive looked fine.
        // We know how many blocks existed before sending, so everything after
        // that index is this answer.
        const answerState = await tab.evaluate(`(() => {
          const stop = document.querySelector("[aria-label='Stop']");
          const md = document.querySelectorAll("[class*=markdown]");
          const tops = [...md].filter(e => !e.parentElement || !e.parentElement.closest('[class*=markdown]'));
          // Freshness is STRUCTURAL: a block that was not here when we sent.
          //
          // The stamp says that directly. The hashes exist only to catch the one
          // case the stamp cannot: the page destroying and re-creating a block,
          // which loses the attribute while keeping the text.
          //
          // Comparing text alone was wrong, and it failed in the obvious way —
          // ask the same question twice, get the same one-word answer, and the
          // reply was discarded as "already seen". The run then waited out its
          // budget and reported that nothing had arrived. Repeating an answer is
          // something a model is entitled to do.
          //
          // So the count decides: if every original bearing this text is still
          // present and stamped, an unstamped copy is an ADDITION — a new reply
          // that happens to match. Only when originals have gone missing do we
          // read a matching block as one of them, re-created.
          const seen = ${JSON.stringify(seenCounts)};
          const h = (t) => { let x = 0; for (let i = 0; i < t.length; i++) { x = (x * 31 + t.charCodeAt(i)) | 0; } return x; };
          const stampedNow = {};
          for (const e of tops) {
            if (!e.hasAttribute('data-acp-seen')) continue;
            const k = h((e.innerText || '').trim().slice(0, 300));
            stampedNow[k] = (stampedNow[k] || 0) + 1;
          }
          const fresh = tops.filter(e => {
            if (e.hasAttribute('data-acp-seen')) return false;
            const k = h((e.innerText || '').trim().slice(0, 300));
            const wasSeen = seen[k] || 0;
            if (wasSeen === 0) return true;
            return (stampedNow[k] || 0) >= wasSeen;
          });
          const text = fresh.map(e => (e.innerText || '').trim()).filter(Boolean).join('\\n\\n').trim();
          return JSON.stringify({
            generating: Boolean(stop),
            hasAnswer: fresh.length > 0 && text.length > 0,
            text,
            blocks: tops.length,
          });
        })()`);

        let isGenerating = false;
        let hasAnswer = false;
        let curText = "";
        if (answerState.ok && typeof answerState.value === "string") {
          try {
            const parsedState = JSON.parse(answerState.value);
            isGenerating = parsedState.generating;
            hasAnswer = parsedState.hasAnswer;
            curText = parsedState.text;
          } catch {}
        }

        // Fold this read into the completion state BEFORE deciding anything:
        // a read that says "busy" must count even though the branch below never
        // looks at it, because its whole job is to invalidate the silence.
        const nowMs = Date.now();
        settle = observe(settle, curText, nowMs, isGenerating);

        // Any sign of life resets the inactivity clock: the Stop button showing,
        // or the answer getting longer. Deep reasoning can be silent for a while
        // before text appears, and that is not a failure.
        if (isGenerating || curText.length > lastLen) {
          lastProgressAt = nowMs;
          lastLen = Math.max(lastLen, curText.length);
        }

        if (!isGenerating && hasAnswer && curText) {
          // One sample of the Stop button is not proof that generation ended.
          //
          // In Thinking mode the page falls silent BETWEEN the reasoning phase
          // and the answer stream: Stop disappears for an instant while only the
          // opening words of the reply are on screen. This branch fired inside
          // that gap and filed a 52-character sentence fragment as a complete
          // answer with status ok — it cut off a council member mid-word, and
          // nothing downstream could tell, because a short answer looks fine.
          // The site playbook always demanded BOTH signals: the button back to
          // Send AND the text unchanged across consecutive reads. Only the first
          // half was ever implemented here.
          //
          // And "both signals" has to mean both signals FOR THE WHOLE WINDOW,
          // held across several consecutive reads — not one signal now plus the
          // other at some point in the past. See qwenSettleOptions for the three
          // archived answers that proved the difference.
          settleCheck = isSettled(settle, nowMs, isGenerating, settleOpts);
          if (!settleCheck.settled) continue;

          // For a CV consultation the answer must echo this question's tag.
          // Without it, a retry that actually double-submitted, or a rendered
          // block left over from the previous question, would be filed as the
          // answer to THIS question — a silent mix-up inside a correct
          // conversation, which no amount of session isolation would catch.
          // Freshness is proved STRUCTURALLY, not by the model's compliance.
          //
          // The tag echo was originally a hard requirement, which quietly made
          // acceptance depend on the model doing as it was told — the same
          // probabilistic verification the design review rejected elsewhere. On
          // long prompts the model simply omits the tag and perfectly good
          // evaluations were thrown away.
          //
          // The deterministic guarantee is that we only read blocks that appeared
          // AFTER this question was sent (baselineBlocks), so a stale or
          // duplicated reply cannot reach us. The tag is kept as a corroborating
          // signal and recorded, not as a gate.
          tagEchoed = token ? answerEchoesToken(curText, token) : true;

          // A missing tag is now a RETRY, not an acceptance.
          //
          // It was downgraded to a soft signal after it rejected good answers on
          // long prompts — and that downgrade is exactly what let a stale reply
          // through: three services once filed the same old answer, each looking
          // successful. The review was blunt about it: an answer we cannot tie to
          // the question we asked must not be filed just because it is plausible.
          // The right shape is neither "always reject" nor "always accept": retry,
          // and only surface it to a human if the retries also come back untagged.
          if (token && !tagEchoed && !isGenerating) {
            if (Date.now() - clickTime < 20000) {
              await new Promise((r) => setTimeout(r, 500));
              continue;
            }
            pollStatus = "tag_missing";
            pollError = `the answer never repeated the question tag ${token} — cannot prove it belongs to this question`;
            break;
          }

          // A FOREIGN tag is proof of staleness and must never be accepted:
          // it means we are reading the reply to an earlier question. A MISSING
          // tag only means the model ignored the instruction on a long prompt,
          // which is not a reason to discard good work.
          const foreignTag = /\[Q-\d+-[0-9a-f]{2,8}\]/.exec(curText);
          const hasForeignTag = Boolean(token && foreignTag && !answerEchoesToken(curText, token));

          if (token && !tagEchoed && Date.now() - clickTime < 15000) {
            await new Promise((r) => setTimeout(r, 500));
            continue;
          }
          if (hasForeignTag) {
            pollStatus = "error";
            pollError = `read an answer tagged ${foreignTag![0]} while waiting for ${token} — refusing to file another question's reply`;
            break;
          }
          pollStatus = "ok";
          extractedAnswer = token ? stripToken(curText, token) : curText;
          break;
        }

        // c. Stall detection at 25s
        if (Date.now() - clickTime >= 25000 && !isGenerating && !hasAnswer) {
          pollStatus = "stalled";
          pollError = "no response started after 25s — the message may not have been submitted";
          break;
        }
      }

      if (!pollStatus) {
        pollStatus = "timeout";
        const idleFor = Math.round((Date.now() - lastProgressAt) / 1000);
        const totalFor = Math.round((Date.now() - clickTime) / 1000);
        pollError =
          Date.now() - clickTime >= hardCeilingMs
            ? `hit the ${Math.round(hardCeilingMs / 60000)}min ceiling after ${totalFor}s`
            : `no activity for ${idleFor}s (total ${totalFor}s) — the page stopped producing output`;
      }

      // Re-read model and thinking metadata. Both come from the widget module,
      // which identifies each selector by the text it DISPLAYS - the old code
      // took the first Ant select on the page and called it the mode.
      const settledMeta = {
        ok: true,
        value: JSON.stringify({
          model: (await readModel(tab)).value,
          thinking: (await readMode(tab)).value,
        }),
      };
      if (settledMeta.ok && typeof settledMeta.value === "string") {
        try {
          const m = JSON.parse(settledMeta.value);
          if (m.model) model = m.model;
          if (m.thinking) thinking = m.thinking;
        } catch {}
      }

      const curLoc = await tab.evaluate("document.location.href");
      let finalUrl: string | null = resumeUrl;
      if (curLoc.ok && typeof curLoc.value === "string" && curLoc.value.includes("/c/")) {
        finalUrl = curLoc.value;
        putSession(effectiveSessionName, {
          targetId: tab.targetId,
          readOnly: false,
          createdAt: new Date().toISOString(),
          resumeUrl: finalUrl,
          lastUrl: finalUrl,
        });
      }

      const duration_ms = Date.now() - startTime;
      mark("answer");
      const attemptMeta: Record<string, any> = {
        submitted: true,
        phases,
        preflight: { ...preflight, elapsedAtRecord: Date.now() - PROC_START },
        reusedTab: !didNavigate,
        ...redactionMeta,
        deep: Boolean(parsed.deep),
        attempt,
        // Write down WHY this was called finished. When the next truncation is
        // reported, the record itself says how much silence was demanded and how
        // much it got, instead of leaving the next reader to guess from the text.
        settle: {
          requiredMs: settleCheck.requiredMs,
          quietMs: settleCheck.quietMs,
          idleSamples: settleCheck.idleSamples,
          graced: settleCheck.graced,
          maxGrowthGapMs: settle.maxGrowthGap,
          ceilingMs: settleOpts.ceilingMs,
        },
      };
      if (siteErrorText) attemptMeta.siteNotice = siteErrorText;
      // Write the block down the moment it is stated, and forget it the moment an
      // answer proves it lifted — a stale block is as costly as a forgotten one.
      if (siteErrorMatch?.kind === "rate_limit") {
        const prior = readLimit();
        writeLimit(
          prior && checkLimit(prior, Date.now()).probeDue
            ? extendAfterProbe(prior, Date.now())
            : limitFrom(siteErrorText || pollError || "حدّ استخدام", parseWaitHint(siteErrorText), Date.now()),
        );
      } else if (pollStatus === "ok") {
        clearLimit();
      }
      if (siteErrorMatch) {
        attemptMeta.siteError = siteErrorMatch;
      }

      if (pollStatus === "ok" && extractedAnswer) {
        const rec = insertConsult({
          session: effectiveSessionName,
          question: questionToSend,
          answer: extractedAnswer,
          model,
          thinking,
          conversation_url: finalUrl,
          duration_ms,
          status: "ok",
          error: null,
          metadata: JSON.stringify(attemptMeta),
        });

        if (parsed.isJson) {
          process.stdout.write(JSON.stringify(rec) + "\n");
        } else {
          process.stdout.write(extractedAnswer + "\n");
        }
        return; // Success exit
      }

      // Record failed attempt row
      const errRec = insertConsult({
        session: effectiveSessionName,
        question: questionToSend,
        answer: null,
        model,
        thinking,
        conversation_url: finalUrl,
        duration_ms,
        status: pollStatus,
        error: pollError,
        metadata: JSON.stringify(attemptMeta),
      });

      if (pollStatus === "site_error") {
        process.stderr.write(`qwen site error (${siteErrorMatch?.kind || "unknown"}): ${siteErrorMatch?.marker || pollError}\n`);
      } else if (pollStatus === "stalled") {
        process.stderr.write(`qwen consultation stalled: ${pollError}\n`);
      }

      // Automatic retry ONLY for site_error or stalled
      // A stated limit is believed, not retried. Retrying a daily quota sends the
      // same question again seconds later and can only make things worse.
      const retryable =
        pollStatus !== "site_error" || !siteErrorMatch || isRetryableSiteError(siteErrorMatch.kind);
      if (!retryable) {
        const waitMins = parseWaitHint(siteErrorText);
        process.stderr.write(
          `الحساب بلغ حدّه: ${siteErrorText || pollError}\n` +
            (waitMins
              ? `انتظر ${waitMins >= 60 ? `${Math.round(waitMins / 60)} ساعة` : `${waitMins} دقيقة`} قبل المحاولة.\n`
              : ""),
        );
      }
      if (
        retryable &&
        (pollStatus === "site_error" || pollStatus === "stalled" || pollStatus === "tag_missing") &&
        attempt < maxRetries
      ) {
        process.stderr.write(`retrying consultation (attempt ${attempt + 2}/${maxRetries + 1})...\n`);
        continue;
      }

      // Final failure output
      if (parsed.isJson) {
        process.stdout.write(JSON.stringify(errRec) + "\n");
      } else {
        process.stderr.write(`consultation failed (${pollStatus}): ${pollError}\n`);
      }
      // NOT process.exit: it jumps over the finally that hands the user their
      // thinking mode back. That leak is why this account sat on Thinking.
      process.exitCode = 4;
      return;
    }
  } finally {
    // First line of defence only. The marker on disk is what actually guarantees
    // the restore, because no finally survives a signal or a hard exit.
    if (switchedMode && userMode) {
      const back = await restoreMode(tab, userMode);
      if (back.error) {
        process.stderr.write(
          `warning: could not put your thinking mode back to '${userMode}' (${back.error}); ` +
            `the next run will repair it\n`,
        );
      }
    }
  }
}

// ESM entry execution check
if (process.argv[1] && process.argv[1].endsWith("qwen-cli.js")) {
  main().catch((err) => {
    process.stderr.write(`error: ${String(err?.message || err)}\n`);
    process.exit(1);
  });
}
