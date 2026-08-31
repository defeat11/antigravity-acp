import { describe, it, expect } from "vitest";
import { parseRating, summarize, renderReport, type Feedback } from "../../src/feedback.js";

describe("parseRating", () => {
  it.each([
    ["up", "up"],
    ["good", "up"],
    ["👍", "up"],
    ["down", "down"],
    ["bad", "down"],
    ["3", 3],
    ["5", 5],
  ])("%s -> %s", (input, expected) => {
    expect(parseRating(input as string)).toBe(expected);
  });

  it("rejects out-of-range / unknown", () => {
    expect(parseRating("9")).toBeNull();
    expect(parseRating("meh")).toBeNull();
    expect(parseRating(undefined)).toBeNull();
  });
});

describe("summarize", () => {
  const items: Feedback[] = [
    { ts: "2026-06-12T10:00", rating: "up", source: "cli" },
    { ts: "2026-06-12T10:01", rating: "down", source: "viewer", note: "slow" },
    { ts: "2026-06-12T10:02", rating: 4, source: "cli" },
    { ts: "2026-06-12T10:03", rating: 2, source: "chat" },
    { ts: "2026-06-12T10:04", rating: null, source: "cli", note: "just a note" },
  ];

  it("counts thumbs and averages numeric scores", () => {
    const s = summarize(items);
    expect(s.total).toBe(5);
    expect(s.up).toBe(1);
    expect(s.down).toBe(1);
    expect(s.scored).toBe(2);
    expect(s.avgScore).toBe(3);
  });

  it("renders a report with counts", () => {
    const r = renderReport(items);
    expect(r).toContain("5 total");
    expect(r).toContain("👍 1");
    expect(r).toContain("avg 3/5");
  });

  it("handles empty feedback", () => {
    expect(summarize([]).total).toBe(0);
    expect(renderReport([])).toContain("no feedback yet");
  });
});
