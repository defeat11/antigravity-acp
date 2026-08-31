import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  recordIncident,
  readIncidents,
  summarizeIncidents,
  validateSleep,
  logPath,
  SLEEP_CAP_MS,
  type WaitIncident,
} from "../../src/web/blind-wait-log.js";

const inc = (o: Partial<WaitIncident>): WaitIncident => ({
  at: o.at ?? "2026-08-05T20:00:00.000Z",
  kind: o.kind ?? "dead-condition",
  session: o.session ?? "s",
  host: o.host ?? "chat.qwen.ai",
  ms: o.ms ?? 0,
  ...(o.polls !== undefined ? { polls: o.polls } : {}),
  ...(o.detail !== undefined ? { detail: o.detail } : {}),
});

describe("sleep must be short and must say why", () => {
  it("accepts a brief, reasoned pause", () => {
    expect(validateSleep({ ms: 400, reason: "انتظار انتهاء حركة" })).toBeNull();
  });

  it("refuses a pause with no stated reason", () => {
    // "Why can a condition not do this?" is the question that turns a blind
    // sleep back into a signal.
    expect(validateSleep({ ms: 400 })).toContain("--reason");
  });

  it("caps the duration and points at the alternative", () => {
    // The cap is what stops `sleep` becoming the new hiding place: an agent that
    // wants two minutes has to confront that it is waiting for something it
    // could be watching.
    const err = validateSleep({ ms: 120000, reason: "r" });
    expect(err).toContain(String(SLEEP_CAP_MS));
    expect(err).toContain("--stable");
  });

  it("refuses nonsense durations", () => {
    expect(validateSleep({ ms: 0, reason: "r" })).toContain("--ms");
    expect(validateSleep({ ms: Number.NaN, reason: "r" })).toContain("--ms");
  });
});

describe("summarising what waited without watching", () => {
  it("counts each kind and adds up the time actually wasted", () => {
    const s = summarizeIncidents([
      inc({ kind: "dead-condition", ms: 120000, session: "a" }),
      inc({ kind: "sleep", ms: 3000, session: "a" }),
      inc({ kind: "sleep", ms: 2000, session: "b" }),
    ]);
    expect(s.total).toBe(3);
    expect(s.byKind["dead-condition"]).toBe(1);
    expect(s.wastedMs).toBe(125000);
  });

  it("counts a declared no-busy without charging it as waste", () => {
    // Trusting stability alone on an unmeasured site is a risk note, not lost
    // time — filing it as waste would bury the incidents that cost real minutes.
    const s = summarizeIncidents([inc({ kind: "no-busy", ms: 0 })]);
    expect(s.total).toBe(1);
    expect(s.wastedMs).toBe(0);
  });

  it("ranks sessions by time lost, so there is somewhere to look first", () => {
    const s = summarizeIncidents([
      inc({ session: "quiet", ms: 1000 }),
      inc({ session: "loud", ms: 90000 }),
      inc({ session: "loud", ms: 30000 }),
    ]);
    expect(s.worstSessions[0]?.session).toBe("loud");
    expect(s.worstSessions[0]?.count).toBe(2);
  });

  it("says nothing at all about an empty log", () => {
    expect(summarizeIncidents([])).toEqual({
      total: 0,
      byKind: {},
      wastedMs: 0,
      worstSessions: [],
    });
  });
});

describe("the log on disk", () => {
  let home = "";
  let prevHome: string | undefined;
  let prevProfile: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "acp-waits-"));
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

  it("appends and reads back", () => {
    expect(readIncidents()).toEqual([]);
    recordIncident(inc({ ms: 120000, polls: 715, detail: "false" }));
    const read = readIncidents();
    expect(read).toHaveLength(1);
    expect(read[0]?.polls).toBe(715);
    expect(read[0]?.detail).toBe("false");
  });

  it("survives a corrupt line rather than losing the whole log", () => {
    writeFileSync(logPath(), '{"broken\n' + JSON.stringify(inc({ session: "ok" })) + "\n", "utf8");
    const read = readIncidents();
    expect(read).toHaveLength(1);
    expect(read[0]?.session).toBe("ok");
  });

  it("returns only the tail when asked for a limit", () => {
    for (let i = 0; i < 5; i++) recordIncident(inc({ session: `s${i}` }));
    const read = readIncidents(2);
    expect(read.map((r) => r.session)).toEqual(["s3", "s4"]);
  });
});
