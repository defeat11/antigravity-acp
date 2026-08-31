/**
 * One writer per candidate.
 *
 * Two processes consulting the same candidate at the same time would interleave
 * their questions inside one conversation — the exact "mixing" this project must
 * make impossible. Parallelism is still allowed ACROSS candidates, which is where
 * the throughput actually is.
 *
 * A lock file records the owning pid so a crashed run cannot block the candidate
 * forever: a lock whose process is gone, or which is older than the max age, is
 * reclaimed.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface LockInfo {
  pid: number;
  key: string;
  acquiredAt: string;
}

export const LOCK_MAX_AGE_MS = 10 * 60 * 1000;

export function locksDir(): string {
  return join(homedir(), ".acp", "cv-locks");
}

function lockPath(key: string): string {
  const safe = key.replace(/[^a-zA-Z0-9_-]/g, "_");
  return join(locksDir(), `${safe}.lock`);
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    // EPERM means it exists but belongs to someone else — still alive.
    return err?.code === "EPERM";
  }
}

export function readLock(key: string): LockInfo | null {
  const p = lockPath(key);
  try {
    if (!existsSync(p)) return null;
    const parsed = JSON.parse(readFileSync(p, "utf8"));
    if (typeof parsed?.pid !== "number" || typeof parsed?.acquiredAt !== "string") return null;
    return parsed as LockInfo;
  } catch {
    return null;
  }
}

/** Pure decision so the reclaim rule is testable without touching the disk. */
export function isLockStale(lock: LockInfo, now: number, alive: (pid: number) => boolean): boolean {
  if (!alive(lock.pid)) return true;
  const age = now - Date.parse(lock.acquiredAt);
  return Number.isFinite(age) && age > LOCK_MAX_AGE_MS;
}

export function acquireLock(
  key: string,
  o?: { pid?: number; now?: number; alive?: (pid: number) => boolean },
): { ok: true; lock: LockInfo } | { ok: false; heldBy: LockInfo } {
  const pid = o?.pid ?? process.pid;
  const now = o?.now ?? Date.now();
  const alive = o?.alive ?? isProcessAlive;

  mkdirSync(locksDir(), { recursive: true });
  const existing = readLock(key);
  if (existing && existing.pid !== pid && !isLockStale(existing, now, alive)) {
    return { ok: false, heldBy: existing };
  }

  const lock: LockInfo = { pid, key, acquiredAt: new Date(now).toISOString() };
  writeFileSync(lockPath(key), JSON.stringify(lock), "utf8");
  return { ok: true, lock };
}

export function releaseLock(key: string, o?: { pid?: number }): void {
  const pid = o?.pid ?? process.pid;
  const existing = readLock(key);
  if (existing && existing.pid !== pid) return; // never release someone else's lock
  try {
    rmSync(lockPath(key), { force: true });
  } catch {
    // A lock we cannot remove ages out on its own.
  }
}

/** Housekeeping: drop locks whose owner died. */
export function pruneStaleLocks(o?: { now?: number; alive?: (pid: number) => boolean }): string[] {
  const now = o?.now ?? Date.now();
  const alive = o?.alive ?? isProcessAlive;
  const dir = locksDir();
  if (!existsSync(dir)) return [];
  const dropped: string[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".lock")) continue;
    try {
      const parsed = JSON.parse(readFileSync(join(dir, name), "utf8")) as LockInfo;
      if (isLockStale(parsed, now, alive)) {
        rmSync(join(dir, name), { force: true });
        dropped.push(parsed.key ?? name);
      }
    } catch {
      rmSync(join(dir, name), { force: true });
      dropped.push(name);
    }
  }
  return dropped;
}
