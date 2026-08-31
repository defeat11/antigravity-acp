/**
 * A record of every time something waited without watching.
 *
 * The council was blunt about why the 120-second incident went unnoticed: the
 * evidence existed — exit code, elapsed time, a condition that was false at every
 * poll — but it was raw, unclassified and ownerless. Nobody had ever asked the
 * data "was this a blind wait?", so it never answered.
 *
 * This is the safety net, and only that. Detection after the fact does not
 * replace giving agents a signal they can use (`wait --stable --busy`); it
 * catches what slips past, and it makes a pattern visible while it is still a
 * pattern rather than a habit.
 *
 * Three things are worth recording, and they are not equally bad:
 *   - `dead-condition` — a wait whose predicate was never once true. Always wrong.
 *   - `sleep` — an explicit, capped, reasoned pause. Honest, but worth counting:
 *     a session full of them is a session missing a signal.
 *   - `no-busy` — `--stable` with `--busy none`, i.e. stability trusted alone.
 *     Legitimate on sites we have not measured, and exactly what to revisit when
 *     a false completion shows up.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { appendFileSync, readFileSync, mkdirSync } from "node:fs";

export type IncidentKind = "dead-condition" | "sleep" | "no-busy";

export interface WaitIncident {
  at: string;
  kind: IncidentKind;
  session: string;
  host: string;
  /** Milliseconds actually spent not-watching. */
  ms: number;
  /** For a dead condition: how many times it was evaluated. */
  polls?: number;
  /** The predicate, the reason for the sleep, or the selector trusted alone. */
  detail?: string;
}

export function logPath(): string {
  return join(homedir(), ".acp", "blind-waits.jsonl");
}

export function recordIncident(rec: WaitIncident): void {
  try {
    mkdirSync(join(homedir(), ".acp"), { recursive: true });
    appendFileSync(logPath(), JSON.stringify(rec) + "\n", "utf8");
  } catch {
    // Bookkeeping must never break the run it is describing.
  }
}

export function readIncidents(limit = 200): WaitIncident[] {
  let raw = "";
  try {
    raw = readFileSync(logPath(), "utf8");
  } catch {
    return [];
  }
  const out: WaitIncident[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line);
      if (rec && typeof rec.kind === "string" && typeof rec.at === "string") out.push(rec);
    } catch {
      // A corrupt line is one lost observation, not a broken log.
    }
  }
  return out.slice(-limit);
}

export interface WaitSummary {
  total: number;
  byKind: Record<string, number>;
  /** Total time spent not watching, which is the number that persuades. */
  wastedMs: number;
  /** Sessions ranked by wasted time — where to look first. */
  worstSessions: Array<{ session: string; ms: number; count: number }>;
}

export function summarizeIncidents(incidents: WaitIncident[]): WaitSummary {
  const byKind: Record<string, number> = {};
  const bySession = new Map<string, { ms: number; count: number }>();
  let wastedMs = 0;

  for (const i of incidents) {
    byKind[i.kind] = (byKind[i.kind] ?? 0) + 1;
    // A declared no-busy costs nothing by itself; it is a risk note, not waste.
    if (i.kind !== "no-busy") wastedMs += Math.max(0, i.ms || 0);
    const cur = bySession.get(i.session) ?? { ms: 0, count: 0 };
    cur.count++;
    if (i.kind !== "no-busy") cur.ms += Math.max(0, i.ms || 0);
    bySession.set(i.session, cur);
  }

  const worstSessions = [...bySession.entries()]
    .map(([session, v]) => ({ session, ms: v.ms, count: v.count }))
    .sort((a, b) => b.ms - a.ms || b.count - a.count)
    .slice(0, 10);

  return { total: incidents.length, byKind, wastedMs, worstSessions };
}

/** The longest an honest sleep may be. */
export const SLEEP_CAP_MS = 10000;

/**
 * A sleep must be short and must say why.
 *
 * The cap is what stops `sleep` from becoming the new hiding place: an agent that
 * needs to pause for a frame gets it, and one that wants two minutes has to
 * confront the fact that it is waiting for something it could be watching.
 */
export function validateSleep(o: { ms?: number; reason?: string }): string | null {
  if (!Number.isFinite(o.ms) || (o.ms ?? 0) <= 0) {
    return "sleep needs --ms <positive number>";
  }
  if ((o.ms ?? 0) > SLEEP_CAP_MS) {
    return (
      `sleep is capped at ${SLEEP_CAP_MS}ms — for anything longer, wait for a condition ` +
      `(wait --stable <css> --busy <css>) instead of guessing a duration`
    );
  }
  if (!o.reason || !o.reason.trim()) {
    return 'sleep needs --reason "<why a condition will not do>"';
  }
  return null;
}
