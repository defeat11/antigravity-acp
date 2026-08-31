/**
 * Persistent named sessions — maps a friendly session name to the agy
 * conversation it owns, so a follow-up edit RESUMES the same agent (which still
 * remembers what it built) instead of starting cold. Stored per project at
 * `<cwd>/.acp-sessions/sessions.json`.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface SavedSession {
  conversationId: string | null;
  lastStepIdx: number;
  cwd: string;
  model: string;
  created: string;
  updated: string;
  turns: number;
  /** Account that owns the conversation store containing conversationId. */
  accountName?: string;
}

export type SessionStoreFile = Record<string, SavedSession>;

function storePath(cwd: string): string {
  return join(cwd, ".acp-sessions", "sessions.json");
}

export function loadSessions(cwd: string): SessionStoreFile {
  try {
    const parsed: unknown = JSON.parse(readFileSync(storePath(cwd), "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as SessionStoreFile) : {};
  } catch {
    return {};
  }
}

export function getSession(cwd: string, name: string): SavedSession | undefined {
  return loadSessions(cwd)[name];
}

export function resolveSessionForAccount(
  cwd: string,
  name: string,
  accountName: string | undefined,
): { name: string; session: SavedSession | undefined; mismatch: boolean } {
  const primary = getSession(cwd, name);
  const mismatch = Boolean(primary?.accountName && accountName && primary.accountName !== accountName);
  if (!mismatch) return { name, session: primary, mismatch: false };
  const scopedName = `${name}@${accountName}`;
  return { name: scopedName, session: getSession(cwd, scopedName), mismatch: true };
}

export function saveSession(cwd: string, name: string, entry: SavedSession): void {
  const store = loadSessions(cwd);
  store[name] = entry;
  try {
    mkdirSync(join(cwd, ".acp-sessions"), { recursive: true });
    writeFileSync(storePath(cwd), JSON.stringify(store, null, 2), "utf8");
  } catch {
    /* non-fatal: persistence is best-effort */
  }
}

/** Merge the result of a turn into a saved session entry (create or update). */
export function recordTurn(
  cwd: string,
  name: string,
  fields: { conversationId: string | null; lastStepIdx: number; model: string; accountName?: string },
  nowIso: string,
): SavedSession {
  const existing = getSession(cwd, name);
  const entry: SavedSession = {
    conversationId: fields.conversationId,
    lastStepIdx: fields.lastStepIdx,
    cwd,
    model: fields.model,
    created: existing?.created ?? nowIso,
    updated: nowIso,
    turns: (existing?.turns ?? 0) + 1,
    accountName: fields.accountName ?? existing?.accountName,
  };
  saveSession(cwd, name, entry);
  return entry;
}
