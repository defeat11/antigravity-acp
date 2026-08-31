import { describe, it, expect } from "vitest";
import { vipSlug } from "../../src/web/redact.js";

describe("vipSlug unit tests", () => {
  it("converts standard English name to slug", () => {
    expect(vipSlug("John Smith")).toBe("john-smith");
    expect(vipSlug("  Alice   B.  ")).toBe("alice-b");
  });

  it("handles punctuation, numbers and spaces", () => {
    expect(vipSlug("Candidate #123 (Senior Dev)")).toBe("candidate-123-senior-dev");
  });

  it("handles Arabic text cleanly by generating a stable hash fallback", () => {
    const slug1 = vipSlug("أحمد محمد");
    const slug2 = vipSlug("أحمد محمد");
    expect(slug1).toBe(slug2);
    expect(slug1.length).toBeGreaterThan(0);
    expect(slug1).not.toContain(" ");
  });

  it("truncates long input to max 48 characters", () => {
    const longName = "a".repeat(100);
    const slug = vipSlug(longName);
    expect(slug.length).toBeLessThanOrEqual(48);
  });

  it("throws an error on empty or whitespace-only input", () => {
    expect(() => vipSlug("")).toThrow("VIP identifier cannot be empty");
    expect(() => vipSlug("   ")).toThrow("VIP identifier cannot be empty");
  });
});
