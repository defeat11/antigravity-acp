import { describe, it, expect } from "vitest";
import type { DelegateResult } from "../../src/delegate.js";

describe("escalate type check", () => {
  it("verifies DelegateResult interface structure with escalate field", () => {
    // Just a compile-time check that DelegateResult can have escalate: boolean
    const fakeResult: Partial<DelegateResult> = {
      escalate: true,
      destructiveWarning: false,
    };
    expect(fakeResult.escalate).toBe(true);
    expect(fakeResult.destructiveWarning).toBe(false);
  });
});
