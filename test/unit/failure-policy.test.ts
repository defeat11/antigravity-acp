import { describe, expect, it } from "vitest";
import { classifyOperationalFailure, shouldFailOverAccount } from "../../src/failure-policy.js";

describe("operational failure policy", () => {
  it("keeps authentication distinct from quota", () => {
    expect(classifyOperationalFailure("You are not logged into Antigravity")).toBe("auth_required");
    expect(shouldFailOverAccount("You are not logged into Antigravity")).toBe(false);
  });

  it("fails over only for confirmed account quota", () => {
    expect(classifyOperationalFailure("429 quota exceeded")).toBe("quota_exhausted");
    expect(shouldFailOverAccount("429 quota exceeded")).toBe(true);
    expect(shouldFailOverAccount("tests failed with exit code 1")).toBe(false);
    expect(shouldFailOverAccount("EPERM access is denied")).toBe(false);
  });

  it("does not confuse shared model capacity with account quota", () => {
    expect(classifyOperationalFailure("MODEL_CAPACITY_EXHAUSTED: No capacity available")).toBe("model_capacity");
    expect(shouldFailOverAccount("MODEL_CAPACITY_EXHAUSTED: No capacity available")).toBe(false);
  });
});
