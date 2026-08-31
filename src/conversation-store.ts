/**
 * Reader for the Antigravity CLI conversation store.
 *
 * WHY THIS EXISTS: in non-interactive `--print` mode, agy 1.0.7 performs the
 * work (it really does edit files) and persists the full turn — assistant text
 * and tool calls — into a per-conversation SQLite "trajectory" database, but it
 * does not reliably echo the assistant text to stdout when stdout is not a TTY
 * (a silent-auth race tears down the stream first). So we run agy to do the
 * work, then read the result back from its store.
 *
 * The store format is undocumented protobuf-in-SQLite and MAY CHANGE between
 * agy versions. All of that fragility is contained in this one module; the rest
 * of the adapter degrades gracefully if extraction returns nothing (the files
 * agy wrote are still on disk). The adapter also prefers real stdout when agy
 * does emit it, so this reader is a robust fallback, not the only path.
 *
 * Discovered layout (agy 1.0.7), per `steps` row `step_payload` (protobuf):
 *   top-level f1 (varint) = step_type   (14=user, 15=assistant, 5=tool exec)
 *   top-level f4 (varint) = status
 *   step_type 15: f20 = content message; prose text lives as a string field
 *                 inside it (a tool-call turn instead carries f20.f7.{f2,f3}).
 *   step_type 5:  f5.f4 = { f2: toolName, f3: JSON args }, f5.f30 = summary.
 */

import { homedir } from "node:os";
import { join, isAbsolute } from "node:path";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import type { ToolKind } from "@agentclientprotocol/sdk";

// node:sqlite has no ESM named export in some Node builds; load it via require.
const nodeRequire = createRequire(import.meta.url);

// node:sqlite is "experimental" and prints a process warning on first use.
// Silence just that warning so it never clutters our stderr log channel.
const originalEmitWarning = process.emitWarning.bind(process);
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const text = typeof warning === "string" ? warning : warning?.message ?? "";
  if (text.includes("SQLite is an experimental feature")) return;
  return (originalEmitWarning as (...a: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;

export interface ExtractedToolCall {
  readonly name: string;
  readonly title: string;
  readonly kind: ToolKind;
  readonly targetFile?: string;
  readonly args?: Record<string, unknown>;
}

export interface ConversationResult {
  /** Concatenated assistant prose for the requested step range. */
  readonly text: string;
  readonly toolCalls: readonly ExtractedToolCall[];
  /** Highest step index seen; used to read only new steps on later turns. */
  readonly maxIdx: number;
}

// ---- protobuf wire reader ------------------------------------------------

interface PbField {
  field: number;
  wire: number;
  varint?: bigint;
  bytes?: Buffer;
}

/** Returns [value, nextPos, complete]. `complete` is false for a truncated or
 *  over-long varint, letting callers stop rather than trust a partial value. */
export function readVarint(buf: Buffer, pos: number): [bigint, number, boolean] {
  let result = 0n;
  let shift = 0n;
  let p = pos;
  let complete = false;
  while (p < buf.length) {
    const b = buf[p++]!;
    result |= BigInt(b & 0x7f) << shift;
    if ((b & 0x80) === 0) {
      complete = true;
      break;
    }
    shift += 7n;
    if (shift > 70n) break; // varint exceeds 10 bytes — malformed
  }
  return [result, p, complete];
}

export function* walkFields(buf: Buffer): Generator<PbField> {
  let pos = 0;
  while (pos < buf.length) {
    const [tag, p1, ok] = readVarint(buf, pos);
    if (!ok || p1 === pos) return;
    const field = Number(tag >> 3n);
    const wire = Number(tag & 7n);
    pos = p1;
    if (wire === 0) {
      const [v, p2, ok2] = readVarint(buf, pos);
      if (!ok2) return;
      pos = p2;
      yield { field, wire, varint: v };
    } else if (wire === 1) {
      pos += 8;
    } else if (wire === 5) {
      pos += 4;
    } else if (wire === 2) {
      const [len, p2, ok2] = readVarint(buf, pos);
      const end = p2 + Number(len);
      if (!ok2 || end > buf.length || Number(len) < 0) return;
      yield { field, wire, bytes: buf.subarray(p2, end) };
      pos = end;
    } else {
      return; // unknown wire type — stop
    }
  }
}

function firstField(buf: Buffer, n: number): PbField | undefined {
  for (const f of walkFields(buf)) if (f.field === n) return f;
  return undefined;
}

function firstVarint(buf: Buffer, n: number): bigint | undefined {
  return firstField(buf, n)?.varint;
}

function firstBytes(buf: Buffer, n: number): Buffer | undefined {
  return firstField(buf, n)?.bytes;
}

// ---- text / tool extraction ----------------------------------------------

export function isProse(s: string): boolean {
  const t = s.trim();
  if (t.length < 2) return false;
  if (t.startsWith("{") || t.startsWith("[")) return false; // JSON, not prose
  if (!/[A-Za-z]/.test(t)) return false;
  // Reject id-like single tokens (uuids, bot-<hex>, tool-call ids like
  // "qf3nacye", sessionID values, hashes). A single token with no whitespace is
  // an id if it's long, hex-ish, or mixes letters with digits. Short plain words
  // like "OK"/"DONE" are kept.
  if (!/\s/.test(t)) {
    if (t.length > 12) return false;
    if (/[0-9a-f]{6,}/i.test(t)) return false;
    if (/\d/.test(t) && t.length >= 6) return false;
  }
  // Reject mostly-control / mostly-non-ascii blobs.
  let bad = 0;
  for (const ch of t) {
    const c = ch.codePointAt(0)!;
    if (c < 0x09 || (c > 0x0d && c < 0x20)) bad++;
  }
  return bad / t.length < 0.05;
}

/** Collect candidate strings within a message, descending up to `maxDepth`. */
function collectStrings(buf: Buffer, maxDepth: number, acc: string[] = []): string[] {
  for (const f of walkFields(buf)) {
    if (f.wire !== 2 || !f.bytes) continue;
    const text = f.bytes.toString("utf8");
    if (isProse(text)) {
      acc.push(text);
    } else if (maxDepth > 0 && f.bytes.length > 1) {
      collectStrings(f.bytes, maxDepth - 1, acc);
    }
  }
  return acc;
}

export function extractAssistantText(payload: Buffer): string | null {
  const content = firstBytes(payload, 20); // f20 = assistant content message
  if (!content) return null;

  // A tool-invocation turn carries its call in f20.f7 and no prose — skip it so
  // internal tool-call ids never leak as assistant text.
  if (firstBytes(content, 7)) return null;

  // The assistant message text lives in f20.f1 (duplicated in f8). Use it
  // directly — no heuristics — so legit short replies (codes, versions) survive.
  const direct = (firstBytes(content, 1) ?? firstBytes(content, 8))?.toString("utf8")?.trim();
  if (direct) return direct;

  // Fallback for any structural drift across agy versions: longest prose string.
  const candidates = collectStrings(content, 3);
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.length - a.length);
  return candidates[0]!.trim();
}

export function guessKind(toolName: string): ToolKind {
  const n = toolName.toLowerCase();
  if (/(write|edit|create|replace|patch|propose_code|apply)/.test(n)) return "edit";
  if (/(delete|remove|rm)/.test(n)) return "delete";
  if (/(move|rename)/.test(n)) return "move";
  if (/(run|exec|command|terminal|shell)/.test(n)) return "execute";
  if (/(search|grep|find|glob|codebase)/.test(n)) return "search";
  if (/(read|view|open|cat)/.test(n)) return "read";
  if (/(fetch|http|url|web|browse)/.test(n)) return "fetch";
  return "other";
}

export function extractToolCall(payload: Buffer): ExtractedToolCall | null {
  // f5 (header/exec) -> f4 (the tool invocation) -> { f2: name, f3: JSON args }
  const f5 = firstBytes(payload, 5);
  if (!f5) return null;
  const invocation = firstBytes(f5, 4);
  if (!invocation) return null;

  const name = firstBytes(invocation, 2)?.toString("utf8")?.trim();
  if (!name) return null;

  const argsJson = firstBytes(invocation, 3)?.toString("utf8");
  let args: Record<string, unknown> | undefined;
  if (argsJson) {
    try {
      const parsed: unknown = JSON.parse(argsJson);
      if (parsed && typeof parsed === "object") args = parsed as Record<string, unknown>;
    } catch {
      /* leave args undefined */
    }
  }

  const summary =
    (typeof args?.["toolSummary"] === "string" && (args["toolSummary"] as string)) ||
    firstBytes(f5, 30)?.toString("utf8")?.trim() ||
    name;
  const targetFile =
    typeof args?.["TargetFile"] === "string" ? (args["TargetFile"] as string) : undefined;

  return { name, title: summary, kind: guessKind(name), targetFile, args };
}

// ---- public API ----------------------------------------------------------

/**
 * Reject a path that is relative or contains a `..` traversal segment. The
 * `appDataDir` value comes from parsing agy's log, so it is treated as
 * untrusted and must not be allowed to redirect reads outside its own tree.
 */
function isSafeAbsolute(p: string): boolean {
  if (!isAbsolute(p)) return false;
  return !p.split(/[\\/]/).includes("..");
}

/** Resolve the directory holding per-conversation `.db` files. */
export function resolveConversationsDir(override?: string, appDataDir?: string): string {
  if (override && existsSync(override)) return override;
  if (appDataDir && isSafeAbsolute(appDataDir)) {
    const dir = join(appDataDir, "conversations");
    if (existsSync(dir)) return dir;
  }
  return join(homedir(), ".gemini", "antigravity-cli", "conversations");
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One extracted step, in conversation order: either assistant text or a tool call. */
export interface ConvStep {
  readonly idx: number;
  readonly text?: string;
  readonly tool?: ExtractedToolCall;
}

/**
 * Read completed steps (status=3) with `idx > afterIdx` in order. Safe to call
 * repeatedly while agy is still running (read-only); each call returns only the
 * newly-completed steps so callers can stream live. Returns null if the DB
 * can't be opened/parsed (caller should fall back / retry).
 */
export function readConversationSteps(
  conversationsDir: string,
  conversationId: string,
  afterIdx: number,
): { steps: ConvStep[]; maxIdx: number } | null {
  // Defense-in-depth: the id is used in a file path, so only accept a strict
  // UUID (which is also how agy names its conversation db files).
  if (!UUID_RE.test(conversationId)) return null;
  const dbPath = join(conversationsDir, `${conversationId}.db`);
  if (!existsSync(dbPath)) return null;

  // Lazy require so a missing node:sqlite never crashes module load.
  let DatabaseSync: typeof import("node:sqlite").DatabaseSync;
  try {
    ({ DatabaseSync } = nodeRequire("node:sqlite") as typeof import("node:sqlite"));
  } catch {
    return null;
  }

  let db: import("node:sqlite").DatabaseSync;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch {
    return null;
  }

  try {
    // status=3 means the step is fully written; skip partial steps mid-stream.
    const rows = db
      .prepare("SELECT idx, step_type, step_payload FROM steps WHERE idx > ? AND status = 3 ORDER BY idx")
      .all(afterIdx) as Array<{ idx: number; step_type: number; step_payload: Uint8Array }>;

    const steps: ConvStep[] = [];
    let maxIdx = afterIdx;

    for (const row of rows) {
      maxIdx = Math.max(maxIdx, row.idx);
      const payload = Buffer.from(row.step_payload);
      const stepType = Number(firstVarint(payload, 1) ?? row.step_type);

      if (stepType === 15) {
        const text = extractAssistantText(payload);
        if (text) steps.push({ idx: row.idx, text });
      } else if (stepType === 5) {
        const tool = extractToolCall(payload);
        if (tool) steps.push({ idx: row.idx, tool });
      }
    }

    return { steps, maxIdx };
  } catch {
    return null;
  } finally {
    try {
      db.close();
    } catch {
      /* ignore */
    }
  }
}

/**
 * Aggregate form of {@link readConversationSteps}: assistant text joined +
 * tool calls collected, for the post-run (non-streaming) path and tests.
 */
export function readConversation(
  conversationsDir: string,
  conversationId: string,
  afterIdx: number,
): ConversationResult | null {
  const result = readConversationSteps(conversationsDir, conversationId, afterIdx);
  if (!result) return null;

  const textParts: string[] = [];
  const toolCalls: ExtractedToolCall[] = [];
  for (const step of result.steps) {
    if (step.text) textParts.push(step.text);
    if (step.tool) toolCalls.push(step.tool);
  }
  return { text: textParts.join("\n\n").trim(), toolCalls, maxIdx: result.maxIdx };
}
