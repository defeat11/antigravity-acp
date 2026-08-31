/**
 * Retire a key whose isolation is no longer provable.
 *
 * A key that accumulated more than one conversation URL is not a catastrophe —
 * no two people ever shared a conversation — but it means we can no longer say
 * which of its conversations is authoritative. A review put it plainly: an
 * isolation mechanism cannot carry an "open item". So such keys are retired
 * explicitly: their live conversation is abandoned, and the next consultation
 * opens a fresh anchored one rehydrated from the archive, which is the source of
 * truth anyway. Nothing is deleted — the history stays queryable.
 */
import type { ConsultRecord } from "./qwen-db.js";

/**
 * Only keys that carry an isolation promise are audited: a candidate (cv-), a
 * VIP (vip-) or a unit of work (task-). The canary deliberately opens a fresh
 * conversation on every run, and scratch sessions have no isolation contract at
 * all — flagging them turns the audit into noise, and an audit that cries wolf
 * stops being read.
 */
export function isIsolationKey(session: string): boolean {
  return /^(cv|vip|task)-/.test(session);
}

export interface RetirementCandidate {
  session: string;
  urls: string[];
  consults: number;
}

/** Was this record the retirement marker that draws the line? */
function isRetirementMarker(r: ConsultRecord): boolean {
  if (!r.metadata) return false;
  try {
    return JSON.parse(r.metadata)?.retired === true;
  } catch {
    return false;
  }
}

/**
 * Which sessions hold more than one conversation URL — counting only what
 * happened AFTER the key was last retired.
 *
 * The archive never forgets, deliberately: history is the source of truth. But
 * that means a retired key would stay flagged forever and the audit could never
 * go green, which trains people to ignore it. Retirement draws a line in time;
 * only what comes after it says anything about the key's current health.
 */
export function findDualUrlSessions(records: ConsultRecord[]): RetirementCandidate[] {
  const bySession = new Map<string, { urls: Set<string>; count: number }>();

  // Newest retirement per session.
  const retiredAt = new Map<string, string>();
  for (const r of records) {
    if (!r.session || !isIsolationKey(r.session) || !isRetirementMarker(r)) continue;
    const prev = retiredAt.get(r.session);
    if (!prev || r.created_at > prev) retiredAt.set(r.session, r.created_at);
  }

  for (const r of records) {
    if (!r.session || !isIsolationKey(r.session)) continue;
    const line = retiredAt.get(r.session);
    if (line && r.created_at <= line) continue; // before the line: history, not health
    if (isRetirementMarker(r)) continue;
    const entry = bySession.get(r.session) ?? { urls: new Set<string>(), count: 0 };
    entry.count++;
    if (r.conversation_url) entry.urls.add(r.conversation_url);
    bySession.set(r.session, entry);
  }

  const out: RetirementCandidate[] = [];
  for (const [session, entry] of bySession) {
    if (entry.urls.size > 1) {
      out.push({ session, urls: [...entry.urls], consults: entry.count });
    }
  }
  return out.sort((a, b) => a.session.localeCompare(b.session));
}

/** Pure: does any single conversation URL appear under two different keys? */
export function findSharedUrls(records: ConsultRecord[]): { url: string; sessions: string[] }[] {
  const byUrl = new Map<string, Set<string>>();
  for (const r of records) {
    if (!r.conversation_url || !r.session || !isIsolationKey(r.session)) continue;
    const set = byUrl.get(r.conversation_url) ?? new Set<string>();
    set.add(r.session);
    byUrl.set(r.conversation_url, set);
  }
  const out: { url: string; sessions: string[] }[] = [];
  for (const [url, sessions] of byUrl) {
    if (sessions.size > 1) out.push({ url, sessions: [...sessions] });
  }
  return out;
}
