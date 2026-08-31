import { describe, it, expect } from "vitest";
import { assignLaneAccounts } from "../../src/swarm.js";
import type { Account } from "../../src/accounts.js";

describe("assignLaneAccounts unit tests", () => {
  it("should distribute 2 accounts to 4 lanes in round-robin fashion", () => {
    const accounts: Account[] = [
      { name: "a", home: "/home/a" },
      { name: "b", home: "/home/b" },
    ];
    const result = assignLaneAccounts(accounts, 4);
    expect(result).toEqual([
      { name: "a", home: "/home/a" },
      { name: "b", home: "/home/b" },
      { name: "a", home: "/home/a" },
      { name: "b", home: "/home/b" },
    ]);
  });

  it("should distribute 3 accounts to 2 lanes", () => {
    const accounts: Account[] = [
      { name: "a", home: "/home/a" },
      { name: "b", home: "/home/b" },
      { name: "c", home: "/home/c" },
    ];
    const result = assignLaneAccounts(accounts, 2);
    expect(result).toEqual([
      { name: "a", home: "/home/a" },
      { name: "b", home: "/home/b" },
    ]);
  });

  it("should handle empty accounts array and 3 lanes by returning nulls", () => {
    const accounts: Account[] = [];
    const result = assignLaneAccounts(accounts, 3);
    expect(result).toEqual([null, null, null]);
  });
});
