/**
 * Remember that the account is blocked, and for how long.
 *
 * The site states a limit once, in a toast that disappears within seconds:
 * "You have reached the daily usage limit. Please wait 8 hours before trying
 * again." Without writing that down, every later run rediscovers it the
 * expensive way — open a tab, load the page, type the question, send it, wait
 * for a reply that will never come — and each rediscovery is another request
 * against an account that has already been told to stop.
 *
 * So the block is persisted with an expiry, and consultations refuse to start
 * while it holds. Refusing is not a failure mode here; it is the correct answer,
 * delivered in a second instead of a minute.
 *
 * The expiry is an ESTIMATE and is treated as one. "8 hours" has an hour's
 * resolution at best, and the clock started at an unknown moment before we saw
 * the notice. So reaching the expiry does not mean the block is gone — it means
 * it is worth spending ONE cheap question to find out. If that probe is refused,
 * the wait extends by a widening margin rather than by another guess.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";

export interface LimitRecord {
  /** The notice exactly as the page showed it. */
  notice: string;
  /** When we saw it. */
  seenAt: string;
  /** When the NEXT cheap probe is due. Not a promise that the block holds. */
  until: string;
  /** The ceiling the notice stated — a bound, never a schedule. */
  statedUntil: string;
  /** How many probes have been refused since. */
  probes: number;
}

export function limitPath(): string {
  return join(homedir(), ".acp", "qwen-limit.json");
}

/** Minutes to add after a probe comes back still blocked: 15 → 30 → 60 → 120. */
export function backoffMinutes(probes: number): number {
  // Starts small on purpose. Observed live: an account shown "Please wait 8
  // hours" answered normally minutes later. Taking that notice literally would
  // have idled a working account for the rest of the day — the expensive
  // direction to be wrong in. So the stated duration is treated as a ceiling and
  // the account is asked again soon, then progressively less often.
  const ladder = [2, 5, 15, 30, 60, 120];
  return ladder[Math.min(probes, ladder.length - 1)] ?? 120;
}

export function readLimit(): LimitRecord | null {
  try {
    const raw = JSON.parse(readFileSync(limitPath(), "utf8"));
    if (typeof raw?.until !== "string" || Number.isNaN(Date.parse(raw.until))) return null;
    return {
      notice: String(raw.notice ?? ""),
      seenAt: String(raw.seenAt ?? raw.until),
      until: raw.until,
      statedUntil: typeof raw.statedUntil === "string" ? raw.statedUntil : raw.until,
      probes: Number(raw.probes ?? 0),
    };
  } catch {
    return null;
  }
}

export function writeLimit(rec: LimitRecord): void {
  try {
    mkdirSync(join(homedir(), ".acp"), { recursive: true });
    writeFileSync(limitPath(), JSON.stringify(rec, null, 2), "utf8");
  } catch {
    // A lost note must not break the run that is already failing.
  }
}

export function clearLimit(): void {
  try {
    unlinkSync(limitPath());
  } catch {
    /* already gone */
  }
}

/**
 * Build the record from what the page said.
 *
 * `waitMinutes` is null when the notice states a limit without a duration — a
 * daily quota with no number still means "not now", so a conservative hour is
 * assumed and the probe ladder does the rest. Guessing short is the safe
 * direction: the cost of a probe is one question, while guessing long can idle
 * an account that is already free.
 */
export function limitFrom(notice: string, waitMinutes: number | null, now: number): LimitRecord {
  const stated = waitMinutes && waitMinutes > 0 ? waitMinutes : 60;
  return {
    notice,
    seenAt: new Date(now).toISOString(),
    // The first probe is due in minutes, not when the notice says so.
    until: new Date(now + backoffMinutes(0) * 60_000).toISOString(),
    statedUntil: new Date(now + stated * 60_000).toISOString(),
    probes: 0,
  };
}

export interface LimitVerdict {
  /** Blocked right now — do not send. */
  blocked: boolean;
  /** Minutes left, floored at 0. */
  remainingMinutes: number;
  /** The expiry has passed: one cheap question decides whether it really lifted. */
  probeDue: boolean;
}

export function checkLimit(rec: LimitRecord | null, now: number): LimitVerdict {
  if (!rec) return { blocked: false, remainingMinutes: 0, probeDue: false };
  const left = Date.parse(rec.until) - now;
  if (left <= 0) {
    // Expired by the clock, unproven in fact.
    return { blocked: false, remainingMinutes: 0, probeDue: true };
  }
  return { blocked: true, remainingMinutes: Math.ceil(left / 60_000), probeDue: false };
}

/** A probe was refused: push the expiry out by the next step of the ladder. */
export function extendAfterProbe(rec: LimitRecord, now: number): LimitRecord {
  const probes = rec.probes + 1;
  const next = now + backoffMinutes(probes) * 60_000;
  const ceiling = Date.parse(rec.statedUntil);
  return {
    ...rec,
    probes,
    // Never schedule the next attempt beyond the ceiling the site itself named:
    // past that point the site says it should work, so that is when to ask.
    until: new Date(Number.isFinite(ceiling) ? Math.min(next, ceiling) : next).toISOString(),
  };
}

/** Human phrasing for the wait, in Arabic, without a false sense of precision. */
export function describeWait(minutes: number): string {
  if (minutes <= 0) return "الآن";
  if (minutes < 60) return `${minutes} دقيقة`;
  const hours = Math.round(minutes / 60);
  return hours === 1 ? "ساعة تقريباً" : `${hours} ساعات تقريباً`;
}
