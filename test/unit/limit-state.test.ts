import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  limitFrom, checkLimit, extendAfterProbe, backoffMinutes, describeWait,
  readLimit, writeLimit, clearLimit, limitPath,
} from "../../src/web/limit-state.js";

const T0 = Date.parse("2026-08-05T20:00:00.000Z");
const NOTICE = "You have reached the daily usage limit. Please wait 8 hours before trying again.";

describe("limit-state: remembering a stated block", () => {
  it("keeps the stated duration as a ceiling and probes long before it", () => {
    // Observed live: an account told to "wait 8 hours" answered minutes later.
    // Obeying the notice literally would idle a working account all day.
    const rec = limitFrom(NOTICE, 480, T0);
    expect(rec.statedUntil).toBe("2026-08-06T04:00:00.000Z");
    expect(rec.until).toBe("2026-08-05T20:02:00.000Z");
    expect(rec.notice).toBe(NOTICE);
    expect(rec.probes).toBe(0);
  });

  it("assumes an hour when the notice states no duration", () => {
    // "Not now" with no number still means not now. Guessing short is the safe
    // direction: a probe costs one question, an over-long guess idles an account
    // that may already be free.
    expect(limitFrom("You have reached the limit.", null, T0).statedUntil).toBe("2026-08-05T21:00:00.000Z");
  });

  it("blocks while the expiry holds and reports what is left", () => {
    const rec = limitFrom(NOTICE, 480, T0);
    const v = checkLimit(rec, T0 + 60_000);
    expect(v.blocked).toBe(true);
    expect(v.remainingMinutes).toBe(1);
    expect(v.probeDue).toBe(false);
  });

  it("does not claim the block lifted — it asks for a probe", () => {
    // The expiry is an estimate: "8 hours" has an hour's resolution and the
    // clock started before we saw the notice. Passing it earns one cheap
    // question, not confidence.
    const v = checkLimit(limitFrom(NOTICE, 480, T0), T0 + 3 * 60_000);
    expect(v.blocked).toBe(false);
    expect(v.probeDue).toBe(true);
  });

  it("widens the wait each time a probe is refused", () => {
    let rec = limitFrom(NOTICE, 480, T0);
    const t1 = T0 + 2 * 60_000;
    rec = extendAfterProbe(rec, t1);
    expect(rec.probes).toBe(1);
    expect(Date.parse(rec.until) - t1).toBe(5 * 60_000);
    rec = extendAfterProbe(rec, t1);
    expect(Date.parse(rec.until) - t1).toBe(15 * 60_000);
    rec = extendAfterProbe(rec, t1);
    expect(Date.parse(rec.until) - t1).toBe(30 * 60_000);
  });

  it("never schedules past the ceiling the site itself named", () => {
    // Beyond that point the site says it should work, so that is when to ask.
    let rec = limitFrom(NOTICE, 10, T0);
    rec = extendAfterProbe(rec, T0 + 9 * 60_000);
    expect(Date.parse(rec.until)).toBe(Date.parse(rec.statedUntil));
  });

  it("stops widening at two hours instead of growing without bound", () => {
    expect(backoffMinutes(0)).toBe(2);
    expect(backoffMinutes(9)).toBe(120);
  });

  it("says nothing about a block that was never recorded", () => {
    const v = checkLimit(null, T0);
    expect(v).toEqual({ blocked: false, remainingMinutes: 0, probeDue: false });
  });

  it("phrases the wait without false precision", () => {
    expect(describeWait(0)).toBe("الآن");
    expect(describeWait(45)).toBe("45 دقيقة");
    expect(describeWait(58)).toBe("58 دقيقة");
    expect(describeWait(420)).toBe("7 ساعات تقريباً");
  });
});

describe("limit-state: on disk", () => {
  let home = "";
  let prevHome: string | undefined;
  let prevProfile: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "acp-limit-"));
    prevHome = process.env.HOME;
    prevProfile = process.env.USERPROFILE;
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    mkdirSync(join(home, ".acp"), { recursive: true });
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    if (prevProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevProfile;
    rmSync(home, { recursive: true, force: true });
  });

  it("survives a round trip", () => {
    expect(readLimit()).toBeNull();
    writeLimit(limitFrom(NOTICE, 480, T0));
    expect(readLimit()?.statedUntil).toBe("2026-08-06T04:00:00.000Z");
    clearLimit();
    expect(readLimit()).toBeNull();
  });

  it("treats a corrupt note as no note rather than blocking forever", () => {
    writeFileSync(limitPath(), "{broken", "utf8");
    expect(readLimit()).toBeNull();
    writeFileSync(limitPath(), JSON.stringify({ until: "not a date" }), "utf8");
    expect(readLimit()).toBeNull();
  });
});
