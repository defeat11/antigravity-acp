import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";

// Mock node:fs module
vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>();
  return {
    ...original,
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    existsSync: vi.fn(),
    mkdirSync: vi.fn(),
  };
});

// Import the module under test AFTER defining mocks
import {
  quotaRegex,
  markExhausted,
  isExhausted,
  nextAccount,
  clearExhausted,
  DEFAULT_COOLDOWN_MS
} from "../../src/accounts.js";

// Setup fs mock implementations
const mockFiles: Record<string, string> = {};

vi.mocked(readFileSync).mockImplementation((path: any) => {
  const p = String(path);
  if (p.endsWith("accounts.json")) {
    return mockFiles.accounts || JSON.stringify({ accounts: [] });
  }
  if (p.endsWith("account-state.json")) {
    return mockFiles.state || JSON.stringify({});
  }
  throw new Error("unexpected read of " + p);
});

vi.mocked(existsSync).mockImplementation((path: any) => {
  const p = String(path);
  if (p.endsWith("accounts.json") || p.endsWith("account-state.json")) {
    return true;
  }
  return false;
});

vi.mocked(mkdirSync).mockImplementation(() => undefined);

vi.mocked(writeFileSync).mockImplementation((path: any, data: any) => {
  const p = String(path);
  if (p.endsWith("accounts.json")) {
    mockFiles.accounts = String(data);
  } else if (p.endsWith("account-state.json")) {
    mockFiles.state = String(data);
  }
});

describe("accounts failover and quota detection tests", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    mockFiles.accounts = JSON.stringify({ accounts: [] });
    mockFiles.state = JSON.stringify({});
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe("quotaRegex", () => {
    it("matches realistic quota/rate-limit/429 error strings", () => {
      const regex = quotaRegex();
      expect(regex.test("Resource has been exhausted (e.g. API rate limit exceeded).")).toBe(true);
      expect(regex.test("ResourceExhausted")).toBe(true);
      expect(regex.test("quota exceeded for quota metric")).toBe(true);
      expect(regex.test("rate limit exceeded")).toBe(true);
      expect(regex.test("out of credit")).toBe(true);
      expect(regex.test("out of quota")).toBe(true);
      expect(regex.test("insufficient credit")).toBe(true);
      expect(regex.test("API call failed with 429 Too Many Requests")).toBe(true);
      expect(regex.test("you have exceeded your current quota")).toBe(true);
    });

    it("does NOT match unrelated error strings", () => {
      const regex = quotaRegex();
      expect(regex.test("Cannot find module './accounts.js'")).toBe(false);
      expect(regex.test("SyntaxError: Unexpected token")).toBe(false);
      expect(regex.test("EACCES: permission denied, open 'file.txt'")).toBe(false);
      expect(regex.test("TypeError: Cannot read properties of undefined")).toBe(false);
    });

    it("uses custom regex from env if provided", () => {
      process.env.ACP_AGY_QUOTA_REGEX = "^custom-error-pattern$";
      const regex = quotaRegex();
      expect(regex.test("custom-error-pattern")).toBe(true);
      expect(regex.test("quota")).toBe(false);
    });
  });

  describe("exhaustion and failover", () => {
    it("manages account exhaustion and cycles to next non-exhausted account", () => {
      // Configure 3 accounts
      const accountsCfg = {
        accounts: [
          { name: "acct1", home: "/home/acct1" },
          { name: "acct2", home: "/home/acct2" },
          { name: "acct3", home: "/home/acct3" }
        ],
        active: "acct1"
      };
      mockFiles.accounts = JSON.stringify(accountsCfg);

      // Verify initial exhaustion state is false
      expect(isExhausted("acct1")).toBe(false);
      expect(isExhausted("acct2")).toBe(false);
      expect(isExhausted("acct3")).toBe(false);

      // Call nextAccount starting from acct1. Since acct2 is not exhausted, it should return acct2.
      const next1 = nextAccount("acct1");
      expect(next1?.name).toBe("acct2");

      // Mark acct2 as exhausted
      markExhausted("acct2");
      expect(isExhausted("acct2")).toBe(true);

      // Now nextAccount("acct1") should skip acct2 (exhausted) and return acct3 (non-exhausted).
      const next2 = nextAccount("acct1");
      expect(next2?.name).toBe("acct3");

      // Mark acct3 as exhausted
      markExhausted("acct3");
      expect(isExhausted("acct3")).toBe(true);

      // Now nextAccount("acct1") has both next accounts (acct2, acct3) exhausted.
      const next3 = nextAccount("acct1");
      expect(next3).toBeNull();

      // Clear exhaustion state for acct2
      clearExhausted("acct2");
      expect(isExhausted("acct2")).toBe(false);

      // Now nextAccount("acct1") should find acct2 again
      const next4 = nextAccount("acct1");
      expect(next4?.name).toBe("acct2");
    });
  });

  describe("exhaustion cooldown and time mocking", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("DEFAULT_COOLDOWN_MS is exactly 5 hours in milliseconds", () => {
      expect(DEFAULT_COOLDOWN_MS).toBe(5 * 60 * 60 * 1000);
    });

    it("an account marked exhausted stays exhausted until the 5-hour window passes", () => {
      const accountName = "test-acct";
      markExhausted(accountName);
      expect(isExhausted(accountName)).toBe(true);

      // Advance time by 4 hours and 59 minutes (less than 5 hours)
      vi.advanceTimersByTime(5 * 60 * 60 * 1000 - 1000);
      expect(isExhausted(accountName)).toBe(true);

      // Advance time past the remaining 1 second (total 5 hours)
      vi.advanceTimersByTime(2000);
      expect(isExhausted(accountName)).toBe(false);
    });

    it("markExhausted followed immediately by isExhausted returns true, and clearing it after advancing time past 5 hours returns false", () => {
      const accountName = "test-acct-2";
      markExhausted(accountName);
      expect(isExhausted(accountName)).toBe(true);

      // Clear the exhausted state
      clearExhausted(accountName);
      expect(isExhausted(accountName)).toBe(false);

      // Check advancing time past 5 hours
      markExhausted(accountName);
      expect(isExhausted(accountName)).toBe(true);
      vi.advanceTimersByTime(5 * 60 * 60 * 1000 + 1000);
      expect(isExhausted(accountName)).toBe(false);
    });
  });
});
