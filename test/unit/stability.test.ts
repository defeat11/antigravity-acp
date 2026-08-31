import { describe, it, expect } from "vitest";
import {
  stabilityWindowMs,
  initialState,
  observe,
  isSettled,
  STABILITY_FLOOR_MS,
  STABILITY_CEILING_MS,
} from "../../src/web/stability.js";

describe("stability: the window a stream earns", () => {
  it("gives a smooth stream the floor and nothing more", () => {
    expect(stabilityWindowMs(0)).toBe(STABILITY_FLOOR_MS);
    expect(stabilityWindowMs(200)).toBe(STABILITY_FLOOR_MS);
  });

  it("doubles the largest observed gap, so a stutterer buys its own patience", () => {
    expect(stabilityWindowMs(900)).toBe(1800);
  });

  it("never exceeds the ceiling", () => {
    expect(stabilityWindowMs(60000)).toBe(STABILITY_CEILING_MS);
  });

  it("honours a caller's floor without dropping below it", () => {
    expect(stabilityWindowMs(0, { floorMs: 1200 })).toBe(1200);
    expect(stabilityWindowMs(100, { floorMs: 1200 })).toBe(1200);
  });
});

describe("stability: folding observations", () => {
  it("does not count the wait before the first character as a gap", () => {
    // That wait is the model thinking, not the stream stuttering. Counting it
    // doubled the window on every short answer and made the adaptive rule
    // slower than the fixed one it replaced.
    let s = initialState();
    s = observe(s, "أهلا", 5000);
    expect(s.maxGrowthGap).toBe(0);
    expect(stabilityWindowMs(s.maxGrowthGap)).toBe(STABILITY_FLOOR_MS);
  });

  it("measures gaps between growths", () => {
    let s = initialState();
    s = observe(s, "a", 1000);
    s = observe(s, "ab", 1300);
    s = observe(s, "abc", 2200);
    expect(s.maxGrowthGap).toBe(900);
  });

  it("measures the quiet run from the last CHANGE, not the first repeat read", () => {
    // The text has been unchanged since 1000; the read at 1200 only confirms it.
    // Dating the silence from the confirmation would charge the poll interval to
    // the stream and make every wait one interval longer than the truth.
    let s = initialState();
    s = observe(s, "abc", 1000);
    s = observe(s, "abc", 1200);
    s = observe(s, "abc", 1600);
    expect(s.settledSince).toBe(1000);
    expect(isSettled(s, 1600, false).quietMs).toBe(600);
  });
});

describe("stability: two signals, never one", () => {
  const streamed = () => {
    let s = initialState();
    s = observe(s, "a", 1000);
    s = observe(s, "ab", 1200);
    return s;
  };

  it("refuses to settle while the site says it is busy", () => {
    // A paused stream and a finished one look identical in the text alone; the
    // busy indicator is what separates them, and trusting stability by itself
    // once archived a 52-character fragment as a complete answer.
    const s = streamed();
    expect(isSettled(s, 9000, true).settled).toBe(false);
    expect(isSettled(s, 9000, false).settled).toBe(true);
  });

  it("refuses to settle on an empty page", () => {
    expect(isSettled(initialState(), 9000, false).settled).toBe(false);
  });

  it("waits out the earned window before settling", () => {
    const s = streamed();
    expect(isSettled(s, 1500, false).settled).toBe(false);
    expect(isSettled(s, 1700, false).settled).toBe(true);
  });

  it("reports what it was waiting for, so a timeout is diagnosable", () => {
    const c = isSettled(streamed(), 1400, false);
    expect(c.requiredMs).toBe(STABILITY_FLOOR_MS);
    expect(c.quietMs).toBe(200);
  });
});
