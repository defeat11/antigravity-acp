/**
 * Feedback loop — anyone who uses the sub-agent can rate the result, so the
 * toolkit keeps improving. Entries are appended to a global JSONL log at
 * `~/.acp/feedback.jsonl`; `acp feedback` reports an aggregate.
 */

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type Rating = "up" | "down" | number;

export interface Feedback {
  ts: string;
  rating: Rating | null;
  note?: string;
  source: "cli" | "viewer" | "chat";
  task?: string;
  session?: string | null;
  conversationId?: string | null;
  model?: string;
  files?: string[];
  verifyOk?: boolean | null;
  elapsedSec?: number;
  cwd?: string;
}

const DIR = join(homedir(), ".acp");
const LOG = join(DIR, "feedback.jsonl");
const LAST = join(DIR, "last-run.json");

export function recordLastRun(context: Record<string, unknown>): void {
  try {
    mkdirSync(DIR, { recursive: true });
    writeFileSync(LAST, JSON.stringify({ ...context, ts: new Date().toISOString() }, null, 2), "utf8");
  } catch {
    /* best-effort */
  }
}

export function loadLastRun(): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(LAST, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function appendFeedback(entry: Omit<Feedback, "ts"> & { ts?: string }): void {
  const full: Feedback = { ts: new Date().toISOString(), ...entry };
  try {
    mkdirSync(DIR, { recursive: true });
    appendFileSync(LOG, JSON.stringify(full) + "\n", "utf8");
  } catch {
    /* best-effort */
  }
}

export function loadFeedback(): Feedback[] {
  let text = "";
  try {
    text = readFileSync(LOG, "utf8");
  } catch {
    return [];
  }
  const out: Feedback[] = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t) as Feedback);
    } catch {
      /* skip malformed line */
    }
  }
  return out;
}

/** Normalize a raw rating token from the CLI into a Rating. */
export function parseRating(token: string | undefined): Rating | null {
  if (!token) return null;
  const t = token.trim().toLowerCase();
  if (["up", "good", "👍", "+", "y", "yes", "ok"].includes(t)) return "up";
  if (["down", "bad", "👎", "-", "n", "no"].includes(t)) return "down";
  const n = Number.parseInt(t, 10);
  if (Number.isFinite(n) && n >= 1 && n <= 5) return n;
  return null;
}

export interface FeedbackSummary {
  total: number;
  up: number;
  down: number;
  scored: number;
  avgScore: number | null;
  recent: Feedback[];
}

export function summarize(items: Feedback[] = loadFeedback()): FeedbackSummary {
  let up = 0;
  let down = 0;
  let scoreSum = 0;
  let scored = 0;
  for (const f of items) {
    if (f.rating === "up") up++;
    else if (f.rating === "down") down++;
    else if (typeof f.rating === "number") {
      scoreSum += f.rating;
      scored++;
    }
  }
  return {
    total: items.length,
    up,
    down,
    scored,
    avgScore: scored ? Number((scoreSum / scored).toFixed(2)) : null,
    recent: items.slice(-8).reverse(),
  };
}

export function renderReport(items: Feedback[] = loadFeedback()): string {
  const s = summarize(items);
  if (s.total === 0) return "no feedback yet — add one with:  acp feedback up|down \"note\"";
  const lines = [
    `feedback: ${s.total} total · 👍 ${s.up} · 👎 ${s.down}${s.avgScore !== null ? ` · avg ${s.avgScore}/5 (${s.scored})` : ""}`,
    "recent:",
  ];
  for (const f of s.recent) {
    const r = f.rating === null ? "—" : String(f.rating);
    const when = f.ts.slice(0, 16).replace("T", " ");
    const note = f.note ? ` "${f.note}"` : "";
    const ctx = f.task ? ` · task: ${f.task.slice(0, 50)}` : "";
    lines.push(`  [${when}] ${r}${note}${ctx}`);
  }
  return lines.join("\n");
}
