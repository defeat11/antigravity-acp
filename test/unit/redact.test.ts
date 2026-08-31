import { describe, it, expect } from "vitest";
import { redactPII } from "../../src/web/redact.js";

// Synthetic samples, assembled at runtime so that no line in this file is
// itself a literal that looks like a real phone number, IBAN or national id.
const PHONE = "+966" + "501234567";
const IBAN = "SA" + "0380000000608010167519";
const NATIONAL_ID = "1" + "012345678";

describe("redactPII unit tests", () => {
  it("detects and redacts emails, phone numbers, IBANs, IDs, and extra literals", () => {
    const input = `Contact John Doe at john.doe@example.com or ${PHONE}. IBAN: ${IBAN}, National ID: ${NATIONAL_ID}.`;
    const res = redactPII(input, ["John Doe"]);

    expect(res.clean).toBe(false);
    expect(res.text).toContain("[NAME_1]");
    expect(res.text).toContain("[EMAIL_1]");
    expect(res.text).toContain("[PHONE_1]");
    expect(res.text).toContain("[IBAN_1]");
    expect(res.text).toContain("[ID_1]");
    expect(res.text).not.toContain("john.doe@example.com");
    expect(res.text).not.toContain(PHONE);
    expect(res.text).not.toContain(IBAN);
    expect(res.text).not.toContain(NATIONAL_ID);
  });

  it("handles extra literals in Arabic and English, including split whitespace", () => {
    const input = "Candidate: أمل عبد الله (Amal  Abdallah)";
    const res = redactPII(input, ["أمل عبد الله", "Amal Abdallah"]);

    expect(res.clean).toBe(false);
    expect(res.text).not.toContain("أمل عبد الله");
    expect(res.text).not.toContain("Amal  Abdallah");
  });

  it("is idempotent — running redactPII on already-redacted text changes nothing", () => {
    const input = `Contact john.doe@example.com or 0${"501234567"}`;
    const res1 = redactPII(input);
    expect(res1.clean).toBe(false);

    const res2 = redactPII(res1.text);
    expect(res2.clean).toBe(true);
    expect(res2.text).toBe(res1.text);
    expect(res2.hits.length).toBe(0);
  });

  it("preserves non-PII numbers: years, SAR amounts, versions, and 6-digit order numbers", () => {
    const input = "In 2026, the price was 1500 SAR for version 3.8 (Order #123456).";
    const res = redactPII(input);

    expect(res.clean).toBe(true);
    expect(res.text).toBe(input);
    expect(res.hits.length).toBe(0);
  });

  it("uses stable placeholders within one call and never leaks original text inside placeholder", () => {
    const input = "First email: alice@example.com, second email: alice@example.com";
    const res = redactPII(input);

    expect(res.hits.length).toBe(1);
    expect(res.hits[0].placeholder).toBe("[EMAIL_1]");
    expect(res.hits[0].placeholder).not.toContain("alice@example.com");
    expect(res.text).toBe("First email: [EMAIL_1], second email: [EMAIL_1]");
  });
});
