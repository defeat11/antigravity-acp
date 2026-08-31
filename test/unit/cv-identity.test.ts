import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cvFingerprint,
  cvSessionName,
  anchorLine,
  parseAnchor,
  anchorMatches,
  correlationToken,
  answerEchoesToken,
  stripToken,
} from "../../src/web/cv-identity.js";
import {
  acquireLock,
  releaseLock,
  readLock,
  isLockStale,
  pruneStaleLocks,
  LOCK_MAX_AGE_MS,
} from "../../src/web/cv-lock.js";

const SECRET = "0".repeat(64);

describe("cv-identity: fingerprints", () => {
  it("is stable for the same parts and different for any change", () => {
    const base = { candidateId: "cand-1", jobId: "backend", cvVersion: "v1" };
    const fp = cvFingerprint(base, SECRET);
    expect(cvFingerprint(base, SECRET)).toBe(fp);
    expect(cvFingerprint({ ...base, candidateId: "cand-2" }, SECRET)).not.toBe(fp);
    expect(cvFingerprint({ ...base, jobId: "frontend" }, SECRET)).not.toBe(fp);
    // A new CV version must never reuse the old conversation.
    expect(cvFingerprint({ ...base, cvVersion: "v2" }, SECRET)).not.toBe(fp);
  });

  it("never leaks the raw identifier and is not reversible", () => {
    const fp = cvFingerprint({ candidateId: "نورة العتيبي", jobId: "j" }, SECRET);
    expect(fp).toMatch(/^[0-9a-f]{24}$/);
    expect(fp).not.toContain("نورة");
    expect(cvSessionName(fp)).toBe(`cv-${fp}`);
  });

  it("changes with the secret, so fingerprints are not portable across machines", () => {
    const parts = { candidateId: "cand-1" };
    expect(cvFingerprint(parts, SECRET)).not.toBe(cvFingerprint(parts, "f".repeat(64)));
  });

  it("rejects an empty candidate id", () => {
    expect(() => cvFingerprint({ candidateId: "  " }, SECRET)).toThrow();
  });
});

describe("cv-identity: anchor", () => {
  it("round-trips through a conversation's first message", () => {
    const fp = cvFingerprint({ candidateId: "cand-9" }, SECRET);
    const line = anchorLine(fp);
    const firstMessage = `${line}\n\nالرجاء تقييم هذا الملف.`;
    expect(parseAnchor(firstMessage)).toBe(fp);
    expect(anchorMatches(parseAnchor(firstMessage), fp)).toBe(true);
  });

  it("refuses a missing, empty or foreign anchor", () => {
    const fp = cvFingerprint({ candidateId: "a" }, SECRET);
    const other = cvFingerprint({ candidateId: "b" }, SECRET);
    expect(parseAnchor("محادثة بلا مرساة")).toBeNull();
    expect(anchorMatches(null, fp)).toBe(false);
    expect(anchorMatches(other, fp)).toBe(false);
    expect(anchorMatches(fp.slice(0, 10), fp)).toBe(false);
  });
});

describe("cv-identity: correlation token", () => {
  it("is unique per question and detected in the answer", () => {
    const t1 = correlationToken(1);
    const t2 = correlationToken(2);
    expect(t1).not.toBe(t2);
    expect(answerEchoesToken(`${t1} الجواب هنا`, t1)).toBe(true);
    expect(answerEchoesToken("Q-1-abcd الجواب", correlationToken(1, "abcd"))).toBe(true);
  });

  it("rejects an answer that belongs to a different question", () => {
    const asked = correlationToken(7, "aaaa");
    const stale = correlationToken(6, "bbbb");
    expect(answerEchoesToken(`${stale} جواب قديم`, asked)).toBe(false);
    expect(answerEchoesToken("جواب بلا وسم", asked)).toBe(false);
  });

  it("strips the token before the answer is shown or stored", () => {
    const t = correlationToken(3, "beef");
    expect(stripToken(`${t}: الدوحة`, t)).toBe("الدوحة");
  });
});

describe("cv-lock", () => {
  let tmpHome: string;
  let origHome: string | undefined;
  let origUserProfile: string | undefined;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "acp-cv-lock-"));
    origHome = process.env.HOME;
    origUserProfile = process.env.USERPROFILE;
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;
  });

  afterEach(() => {
    process.env.HOME = origHome;
    process.env.USERPROFILE = origUserProfile;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("grants the lock once and refuses a second live holder", () => {
    const first = acquireLock("cv-abc", { pid: 1111, alive: () => true });
    expect(first.ok).toBe(true);
    const second = acquireLock("cv-abc", { pid: 2222, alive: () => true });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.heldBy.pid).toBe(1111);
  });

  it("lets the same process re-enter its own lock", () => {
    acquireLock("cv-abc", { pid: 1111, alive: () => true });
    expect(acquireLock("cv-abc", { pid: 1111, alive: () => true }).ok).toBe(true);
  });

  it("reclaims a lock whose owner died", () => {
    acquireLock("cv-abc", { pid: 4242, alive: () => true });
    const taken = acquireLock("cv-abc", { pid: 5555, alive: (pid) => pid !== 4242 });
    expect(taken.ok).toBe(true);
  });

  it("reclaims a lock that outlived the max age even if the pid is alive", () => {
    const start = Date.now();
    acquireLock("cv-abc", { pid: 6666, now: start, alive: () => true });
    const later = start + LOCK_MAX_AGE_MS + 1000;
    expect(acquireLock("cv-abc", { pid: 7777, now: later, alive: () => true }).ok).toBe(true);
  });

  it("never releases a lock held by another process", () => {
    acquireLock("cv-abc", { pid: 1111, alive: () => true });
    releaseLock("cv-abc", { pid: 2222 });
    expect(readLock("cv-abc")?.pid).toBe(1111);
    releaseLock("cv-abc", { pid: 1111 });
    expect(readLock("cv-abc")).toBeNull();
  });

  it("keeps different candidates independent", () => {
    expect(acquireLock("cv-aaa", { pid: 1, alive: () => true }).ok).toBe(true);
    expect(acquireLock("cv-bbb", { pid: 2, alive: () => true }).ok).toBe(true);
  });

  it("prunes only dead locks", () => {
    acquireLock("cv-dead", { pid: 9001, alive: () => true });
    acquireLock("cv-live", { pid: 9002, alive: () => true });
    const dropped = pruneStaleLocks({ alive: (pid) => pid === 9002 });
    expect(dropped).toContain("cv-dead");
    expect(readLock("cv-live")?.pid).toBe(9002);
  });
});

describe("isLockStale", () => {
  it("is stale when the pid is gone, fresh when alive and young", () => {
    const now = Date.now();
    const lock = { pid: 10, key: "k", acquiredAt: new Date(now - 1000).toISOString() };
    expect(isLockStale(lock, now, () => false)).toBe(true);
    expect(isLockStale(lock, now, () => true)).toBe(false);
  });
});
