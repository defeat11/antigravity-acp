import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { reservedPorts, allocateProfilePortSync } from "./chrome.js";

import type { Fingerprint } from "./fingerprint.js";

export const SESSIONS_PATH = join(homedir(), ".acp", "web-sessions.json");
export const DOMAINS_PATH = join(homedir(), ".acp", "web-domains.json");
export const PROFILES_PATH = join(homedir(), ".acp", "web-profiles.json");
export const FINGERPRINTS_PATH = join(homedir(), ".acp", "web-fingerprints.json");

export interface ProfileRecord {
  port: number;
  createdAt: string;
  lastUsed?: string;
  reallocatedFrom?: number;
}

export interface WebSessionRecord {
  targetId: string;
  readOnly: boolean;
  createdAt: string;
  lastUrl?: string;
  via?: "direct" | "extension";
  profile?: string;
  /**
   * The page this session should be reopened at when its tab is gone (closed by
   * hand, or lost to a browser restart). A tab id dies with the tab; a URL does
   * not — so this is what makes a named session stick to the SAME conversation
   * across restarts.
   */
  resumeUrl?: string;
  lastUsedAt?: string;
  handedOver?: boolean;
}

export interface SelectSessionsOptions {
  maxAgeMin?: number;
  keep?: number;
  now?: number;
  exclude?: string[];
}

export function selectSessionsToClose(
  sessions: Record<string, WebSessionRecord>,
  options?: SelectSessionsOptions
): string[] {
  const maxAgeMin = options?.maxAgeMin ?? 60;
  const keep = options?.keep ?? 3;
  const now = options?.now ?? Date.now();
  const excludeSet = new Set(options?.exclude ?? []);

  const candidates: { name: string; timestamp: number }[] = [];

  for (const [name, rec] of Object.entries(sessions)) {
    if (excludeSet.has(name)) continue;
    if (rec.handedOver) continue;
    if (!rec.targetId) continue;

    const tsStr = rec.lastUsedAt || rec.createdAt;
    const ts = Date.parse(tsStr);
    candidates.push({ name, timestamp: isNaN(ts) ? 0 : ts });
  }

  // Sort newest first
  candidates.sort((a, b) => b.timestamp - a.timestamp);

  // Keep top `keep` sessions
  const eligible = candidates.slice(keep);

  const selected: string[] = [];
  for (const item of eligible) {
    const ageMin = (now - item.timestamp) / 60000;
    if (ageMin >= maxAgeMin) {
      selected.push(item.name);
    }
  }

  return selected;
}

export async function autoPruneIdleTabs(excludeSessionName?: string): Promise<string[]> {
  try {
    const sessions = readSessions();
    const selected = selectSessionsToClose(sessions, {
      maxAgeMin: 60,
      keep: 3,
      exclude: excludeSessionName ? [excludeSessionName] : [],
    });
    const toClose = selected.slice(0, 5);
    if (toClose.length === 0) return [];

    const { ExtensionTransport } = await import("./transport.js");
    const { BrowserTab } = await import("./actions.js");

    const closed: string[] = [];
    for (const name of toClose) {
      const rec = sessions[name];
      if (!rec || !rec.targetId) continue;
      try {
        if (rec.via === "extension") {
          const transport = await ExtensionTransport.attachTab({ tabId: Number(rec.targetId) });
          await transport.closeTab();
        } else {
          const profRec = touchProfileRecord(rec.profile || "default");
          const tab = await BrowserTab.attach({ port: profRec.port, targetId: rec.targetId });
          await tab.close();
        }
      } catch {}
      putSession(name, { ...rec, targetId: "" });
      closed.push(name);
    }
    return closed;
  } catch {
    return [];
  }
}

/**
 * Is this URL worth storing as a session's resume point?
 *
 * Excludes pages that cannot restore anything: blank tabs, roots (a fresh chat),
 * and — importantly — temporary/ephemeral conversations, which the site never
 * persists server-side, so reopening their URL yields an empty page rather than
 * the conversation.
 */
export function isResumableUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  if (u.pathname === "/" || u.pathname === "") return false;
  // Ephemeral conversations: never restorable.
  if (u.searchParams.has("temporary-chat")) return false;
  if (/\/c\/local\/?$/.test(u.pathname)) return false;
  return true;
}

export function getSessionsPath(): string {
  return join(homedir(), ".acp", "web-sessions.json");
}

export function getDomainsPath(): string {
  return join(homedir(), ".acp", "web-domains.json");
}

export function getProfilesPath(): string {
  return join(homedir(), ".acp", "web-profiles.json");
}

export function readProfiles(): Record<string, ProfileRecord> {
  try {
    const path = getProfilesPath();
    if (!existsSync(path)) return {};
    const content = readFileSync(path, "utf8");
    const parsed = JSON.parse(content);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function writeProfiles(map: Record<string, ProfileRecord>): void {
  const path = getProfilesPath();
  ensureAcpDir(path);
  writeFileSync(path, JSON.stringify(map, null, 2), "utf8");
}

export function getProfileRecord(name: string): ProfileRecord | null {
  const map = readProfiles();
  return map[name] ?? null;
}

export function touchProfileRecord(
  name: string,
  port?: number,
  o?: { env?: Record<string, string | undefined> }
): ProfileRecord {
  const env = o?.env ?? process.env;
  const resPorts = new Set(reservedPorts(env));
  const map = readProfiles();
  const existing = map[name];
  const now = new Date().toISOString();

  if (existing) {
    existing.lastUsed = now;

    // Check if existing port is reserved or duplicated
    let needsReallocation = resPorts.has(existing.port);
    if (!needsReallocation) {
      for (const [otherName, otherRec] of Object.entries(map)) {
        if (otherName !== name && otherRec.port === existing.port && otherName < name) {
          needsReallocation = true;
          break;
        }
      }
    }

    if (needsReallocation) {
      const oldPort = existing.port;
      const newPort = allocateProfilePortSync(name, map, { env });
      existing.port = newPort;
      existing.reallocatedFrom = oldPort;
    } else if (port && !existing.port) {
      existing.port = port;
    }

    writeProfiles(map);
    return existing;
  }

  let allocatedPort = port;
  if (!allocatedPort || resPorts.has(allocatedPort)) {
    allocatedPort = allocateProfilePortSync(name, map, { env });
  }

  const rec: ProfileRecord = {
    port: allocatedPort,
    createdAt: now,
    lastUsed: now,
  };
  map[name] = rec;
  writeProfiles(map);
  return rec;
}

function ensureAcpDir(filePath: string): void {
  const dir = join(filePath, "..");
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

export function readSessions(): Record<string, WebSessionRecord> {
  try {
    const path = getSessionsPath();
    if (!existsSync(path)) return {};
    const content = readFileSync(path, "utf8");
    const parsed = JSON.parse(content);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function writeSessions(map: Record<string, WebSessionRecord>): void {
  const path = getSessionsPath();
  ensureAcpDir(path);
  writeFileSync(path, JSON.stringify(map, null, 2), "utf8");
}

export function getSession(name: string): WebSessionRecord | null {
  const sessions = readSessions();
  return sessions[name] ?? null;
}

export function putSession(name: string, rec: WebSessionRecord): void {
  const sessions = readSessions();
  rec.lastUsedAt = rec.lastUsedAt || new Date().toISOString();
  sessions[name] = rec;
  writeSessions(sessions);
}

export function dropSession(name: string): void {
  const sessions = readSessions();
  if (name in sessions) {
    delete sessions[name];
    writeSessions(sessions);
  }
}

export function readDomains(): string[] {
  try {
    const path = getDomainsPath();
    if (!existsSync(path)) return [];
    const content = readFileSync(path, "utf8");
    const parsed = JSON.parse(content);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function writeDomains(list: string[]): void {
  const path = getDomainsPath();
  ensureAcpDir(path);
  writeFileSync(path, JSON.stringify(list, null, 2), "utf8");
}

export function normalizeDomainInput(entry: string): string {
  let s = entry.trim().toLowerCase();
  if (s === "*") return "*";

  if (s.startsWith("http://") || s.startsWith("https://")) {
    try {
      const u = new URL(s);
      s = u.hostname.toLowerCase();
    } catch {
      // use as-is if unparseable
    }
  } else {
    const slashIdx = s.indexOf("/");
    if (slashIdx >= 0) {
      s = s.slice(0, slashIdx);
    }
  }

  if (s.startsWith("www.")) {
    s = s.slice(4);
  }

  return s;
}

export function addDomain(entry: string): string[] {
  const norm = normalizeDomainInput(entry);
  if (!norm) return readDomains();

  const list = readDomains();
  if (!list.includes(norm)) {
    list.push(norm);
    writeDomains(list);
  }
  return list;
}

export function removeDomain(entry: string): string[] {
  const norm = normalizeDomainInput(entry);
  const list = readDomains().filter((d) => d !== norm);
  writeDomains(list);
  return list;
}

export function getFingerprintsPath(): string {
  return join(homedir(), ".acp", "web-fingerprints.json");
}

export function readFingerprints(): Record<string, Fingerprint> {
  try {
    const path = getFingerprintsPath();
    if (!existsSync(path)) return {};
    const content = readFileSync(path, "utf8");
    const parsed = JSON.parse(content);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function writeFingerprints(map: Record<string, Fingerprint>): void {
  const path = getFingerprintsPath();
  ensureAcpDir(path);
  writeFileSync(path, JSON.stringify(map, null, 2), "utf8");
}

export function getFingerprint(host: string): Fingerprint | null {
  const fps = readFingerprints();
  return fps[host] ?? null;
}

export function putFingerprint(host: string, fp: Fingerprint): void {
  const fps = readFingerprints();
  fps[host] = fp;
  writeFingerprints(fps);
}

export function dropFingerprint(host: string): void {
  const fps = readFingerprints();
  if (host in fps) {
    delete fps[host];
    writeFingerprints(fps);
  }
}

/**
 * Are these two URLs the same Qwen conversation?
 *
 * Used to decide whether a reused tab needs navigating at all. Compared by
 * origin and path only: the query string carries UI state (`?temporary-chat=`,
 * tracking parameters the app appends after load) that says nothing about WHICH
 * conversation is open, and treating it as significant would reload the page on
 * every single run — which is the cost this check exists to avoid.
 */
export function sameConversation(a: string, b: string): boolean {
  if (!a || !b) return false;
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    const norm = (p: string) => p.replace(/\/+$/, "");
    return ua.origin === ub.origin && norm(ua.pathname) === norm(ub.pathname);
  } catch {
    return a === b;
  }
}

/**
 * Does a retry have to reload the page, or can it just type again?
 *
 * Reloading is the expensive, lossy option and it was the unconditional one: a
 * retry navigated every time. That discards the rendered conversation, resets
 * the thinking mode to the account default — so attempt two could answer in a
 * different mode than attempt one, with nothing in the record to show it — and
 * pays a full page load for a failure that is usually a dropped click. Nothing
 * needs cleaning up either: `fill` selects all before typing, so a half-typed
 * composer is overwritten rather than appended to.
 *
 * A reload is warranted only when we cannot see where we are, or we are looking
 * at the wrong conversation.
 */
export function retryNeedsReload(currentUrl: string, startUrl: string): boolean {
  // No reading of the page at all: the tab is not answering, so start clean.
  if (!currentUrl) return true;
  if (sameConversation(currentUrl, startUrl)) return false;

  // The first message of a NEW conversation moves the tab from the site root to
  // /c/<id>. That conversation is the one this run just created, so retrying in
  // it is correct — and reloading to the root instead would abandon it and open a
  // second conversation under the same key, which is precisely what the isolation
  // audit exists to catch.
  try {
    const now = new URL(currentUrl);
    const start = new URL(startUrl);
    const startIsRoot = start.pathname === "/" || start.pathname === "";
    if (startIsRoot && now.origin === start.origin && /^\/c\//.test(now.pathname)) {
      return false;
    }
  } catch {
    return true;
  }
  return true;
}
