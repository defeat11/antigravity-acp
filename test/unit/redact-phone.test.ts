import { describe, it, expect } from "vitest";
import { redactPII } from "../../src/web/redact.js";

const redacted = (t: string) => !redactPII(t, []).clean;

// Synthetic sample number, assembled at runtime so that no line in this file
// is itself a literal that looks like somebody's real phone number.
const NATIONAL = "5" + "00000000"; // national form, nine digits
const LOCAL = "0" + NATIONAL; // same number with the trunk zero

describe("redact: a number is a phone only when it looks like one", () => {
  it("redacts numbers carrying a real phone signal", () => {
    // country code, trunk zero, separators, or an explicit label
    expect(redacted(`+966 ${NATIONAL}`)).toBe(true);
    expect(redacted(`00966${NATIONAL}`)).toBe(true);
    expect(redacted(LOCAL)).toBe(true);
    expect(redacted("+1 415 555 0132")).toBe(true);
    expect(redacted("055 123 4567")).toBe(true);
    expect(redacted("(011) 234-5678")).toBe(true);
    expect(redacted(`هاتف: ${NATIONAL}`)).toBe(true);
    expect(redacted(`Mobile: ${NATIONAL}`)).toBe(true);
    expect(redacted(`واتساب ${LOCAL}`)).toBe(true);
  });

  it("leaves ordinary numbers alone — over-redaction destroys facts the evaluation needs", () => {
    // A Telegram id that used to be swallowed because it starts with 5.
    expect(redacted("5352982656")).toBe(false);
    expect(redacted("USER_ID_5352982656")).toBe(false);
    // Metrics, identifiers, money and dates on a CV.
    expect(redacted("خدم 520000000 طلب")).toBe(false);
    expect(redacted("رقم الموظف 501234567")).toBe(false);
    expect(redacted("في 2026 وميزانية 15000 SAR")).toBe(false);
    expect(redacted("2026-08-05")).toBe(false);
    expect(redacted("handled 40000 requests per minute")).toBe(false);
  });

  it("keeps the platform but removes the handle from profile links", () => {
    const r = redactPII("[GitHub](https://github.com/octocat) and linkedin.com/in/some-user", []);
    expect(r.text).toContain("github.com/");
    expect(r.text).not.toContain("octocat");
    expect(r.text).not.toContain("some-user");
    expect(r.hits.filter((h) => h.kind === "handle")).toHaveLength(2);
  });

  it("never stores the original value inside the placeholder", () => {
    const r = redactPII(`+966 ${NATIONAL}`, []);
    expect(r.hits[0]!.placeholder).not.toContain(NATIONAL);
  });
});
