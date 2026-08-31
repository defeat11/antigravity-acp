import { describe, it, expect } from "vitest";
import { getProcessStartTimes } from "../../src/registry.js";

describe("registry process start times", () => {
  it("returns empty map when input is empty", () => {
    const times = getProcessStartTimes([]);
    expect(times instanceof Map).toBe(true);
    expect(times.size).toBe(0);
  });

  it("resolves correct start time for current node process", () => {
    const currentPid = process.pid;
    const times = getProcessStartTimes([currentPid]);
    expect(times.has(currentPid)).toBe(true);
    const date = times.get(currentPid);
    expect(date instanceof Date).toBe(true);
    expect(Number.isNaN(date!.getTime())).toBe(false);
    // The current process should have started at some point in the past
    expect(date!.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it("does not return times for non-existent pids", () => {
    // 999999 is highly unlikely to exist, or we can use a very large PID number
    const nonExistentPid = 9999999;
    const times = getProcessStartTimes([nonExistentPid]);
    expect(times.has(nonExistentPid)).toBe(false);
  });

  it("still resolves the real pid when a non-existent pid is mixed into the same batch", () => {
    // Regression test: `Get-Process -Id <a>,<b>` (and some `ps` builds) exit
    // non-zero the moment ANY requested pid is missing, even though they still
    // print the ones they did find. A batch query must not let one dead pid
    // wipe out every valid result in the same call.
    const currentPid = process.pid;
    const nonExistentPid = 9999999;
    const times = getProcessStartTimes([currentPid, nonExistentPid]);
    expect(times.has(currentPid)).toBe(true);
    expect(times.has(nonExistentPid)).toBe(false);
  });
});
