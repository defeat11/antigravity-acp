import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { countRecentRunsByAccount } from "../../src/ledger.js";

// Mock the ledger module to control countRecentRunsByAccount
vi.mock("../../src/ledger.js", () => {
  return {
    countRecentRunsByAccount: vi.fn(),
  };
});

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

// Now import the module under test AFTER defining mocks
import { resolveActive, resolveActiveBalanced } from "../../src/accounts.js";

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

describe("resolveActiveBalanced", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    mockFiles.accounts = JSON.stringify({ accounts: [] });
    mockFiles.state = JSON.stringify({});
    vi.mocked(countRecentRunsByAccount).mockReset();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("defaults to resolveActive behavior when ACP_AGY_AUTO_BALANCE is not set", () => {
    delete process.env.ACP_AGY_AUTO_BALANCE;

    // Set up accounts
    const accountsCfg = {
      accounts: [
        { name: "acct1", home: "/home/acct1" },
        { name: "acct2", home: "/home/acct2" }
      ],
      active: "acct1"
    };
    mockFiles.accounts = JSON.stringify(accountsCfg);

    const res1 = resolveActive();
    const resBalanced1 = resolveActiveBalanced();
    expect(resBalanced1).toEqual(res1);
    expect(resBalanced1?.name).toBe("acct1");
  });

  it("bypasses balancing and returns the override account if provided", () => {
    process.env.ACP_AGY_AUTO_BALANCE = "1";

    const accountsCfg = {
      accounts: [
        { name: "acct1", home: "/home/acct1" },
        { name: "acct2", home: "/home/acct2" }
      ],
      active: "acct1"
    };
    mockFiles.accounts = JSON.stringify(accountsCfg);

    const res = resolveActiveBalanced("acct2");
    expect(res?.name).toBe("acct2");
  });

  it("returns null if there are no accounts configured", () => {
    process.env.ACP_AGY_AUTO_BALANCE = "1";
    mockFiles.accounts = JSON.stringify({ accounts: [] });

    const res = resolveActiveBalanced();
    expect(res).toBeNull();
  });

  it("returns the single non-exhausted account directly", () => {
    process.env.ACP_AGY_AUTO_BALANCE = "1";

    const accountsCfg = {
      accounts: [
        { name: "acct1", home: "/home/acct1" },
        { name: "acct2", home: "/home/acct2" }
      ],
      active: "acct1"
    };
    mockFiles.accounts = JSON.stringify(accountsCfg);

    // Mark acct1 as exhausted
    const futureTime = new Date(Date.now() + 10000).toISOString();
    mockFiles.state = JSON.stringify({
      acct1: { exhaustedUntil: futureTime }
    });

    const res = resolveActiveBalanced();
    expect(res?.name).toBe("acct2");
  });

  it("balances by choosing the account with the minimum recent runs", () => {
    process.env.ACP_AGY_AUTO_BALANCE = "1";

    const accountsCfg = {
      accounts: [
        { name: "acct1", home: "/home/acct1" },
        { name: "acct2", home: "/home/acct2" },
        { name: "acct3", home: "/home/acct3" }
      ],
      active: "acct1"
    };
    mockFiles.accounts = JSON.stringify(accountsCfg);

    // Mock recent runs: acct1 has 5, acct2 has 2, acct3 has 8
    vi.mocked(countRecentRunsByAccount).mockReturnValue({
      acct1: 5,
      acct2: 2,
      acct3: 8
    });

    const res = resolveActiveBalanced();
    expect(res?.name).toBe("acct2");
  });

  it("prefers the first account in failover order in case of a tie", () => {
    process.env.ACP_AGY_AUTO_BALANCE = "1";

    const accountsCfg = {
      accounts: [
        { name: "acct1", home: "/home/acct1" },
        { name: "acct2", home: "/home/acct2" },
        { name: "acct3", home: "/home/acct3" }
      ],
      active: "acct1"
    };
    mockFiles.accounts = JSON.stringify(accountsCfg);

    // Mock tie: acct1 has 4, acct2 has 4, acct3 has 6
    vi.mocked(countRecentRunsByAccount).mockReturnValue({
      acct1: 4,
      acct2: 4,
      acct3: 6
    });

    const res = resolveActiveBalanced();
    expect(res?.name).toBe("acct1");
  });

  it("defaults to 0 runs for accounts missing in countRecentRunsByAccount response", () => {
    process.env.ACP_AGY_AUTO_BALANCE = "1";

    const accountsCfg = {
      accounts: [
        { name: "acct1", home: "/home/acct1" },
        { name: "acct2", home: "/home/acct2" }
      ],
      active: "acct1"
    };
    mockFiles.accounts = JSON.stringify(accountsCfg);

    // Mock runs: acct1 is missing (defaults to 0), acct2 has 2
    vi.mocked(countRecentRunsByAccount).mockReturnValue({
      acct2: 2
    });

    const res = resolveActiveBalanced();
    expect(res?.name).toBe("acct1");
  });

  it("falls back to resolveActive behavior if all accounts are exhausted", () => {
    process.env.ACP_AGY_AUTO_BALANCE = "1";

    const accountsCfg = {
      accounts: [
        { name: "acct1", home: "/home/acct1" },
        { name: "acct2", home: "/home/acct2" }
      ],
      active: "acct2"
    };
    mockFiles.accounts = JSON.stringify(accountsCfg);

    // Mark both as exhausted
    const futureTime = new Date(Date.now() + 10000).toISOString();
    mockFiles.state = JSON.stringify({
      acct1: { exhaustedUntil: futureTime },
      acct2: { exhaustedUntil: futureTime }
    });

    const res = resolveActiveBalanced();
    // Since both are exhausted, it should fall back to active (acct2) or the first non-exhausted fallback
    expect(res?.name).toBe("acct1");
  });
});
