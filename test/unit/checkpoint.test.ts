import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import {
  isWorkingTreeClean,
  prepareCheckpoint,
  commitCheckpoint,
  getHeadHash
} from "../../src/checkpoint.js";

describe("Checkpoint & Rollback system tests", () => {
  it("covers all working tree, prepare, and commit scenarios in a real git repository", () => {
    const dir = mkdtempSync(join(tmpdir(), "acp-checkpoint-test-"));
    try {
      // 1. Initialize git repo
      execSync("git init", { cwd: dir, stdio: "ignore" });
      execSync("git config user.name 'Test User'", { cwd: dir, stdio: "ignore" });
      execSync("git config user.email 'test@example.com'", { cwd: dir, stdio: "ignore" });
      execSync("git config commit.gpgsign false", { cwd: dir, stdio: "ignore" });

      // Test 1: isWorkingTreeClean on a clean empty repo (no commits yet)
      expect(isWorkingTreeClean(dir)).toBe(true);

      // Test 2: isWorkingTreeClean returns false after writing a new file (untracked/uncommitted)
      const filename = "test-file.txt";
      writeFileSync(join(dir, filename), "hello world", "utf8");
      expect(isWorkingTreeClean(dir)).toBe(false);

      // Test 3: prepareCheckpoint on an unclean repo returns eligible: false with uncommitted reason
      const prepUnclean = prepareCheckpoint(dir);
      expect(prepUnclean.eligible).toBe(false);
      expect(prepUnclean.reason).toContain("uncommitted");

      // Clean the repo by git adding and committing the test file
      execSync("git add -A", { cwd: dir, stdio: "ignore" });
      execSync("git commit --no-gpg-sign -m \"commit test file\"", { cwd: dir, stdio: "ignore" });

      // Test 4: prepareCheckpoint on a clean repo returns eligible: true
      expect(isWorkingTreeClean(dir)).toBe(true);
      const prepClean = prepareCheckpoint(dir);
      expect(prepClean.eligible).toBe(true);
      expect(prepClean.reason).toBeNull();
      const initialHead = getHeadHash(dir);
      expect(prepClean.beforeHash).toBe(initialHead);

      // Test 5: commitCheckpoint after writing a new file on a clean tree returns committed: true
      writeFileSync(join(dir, "another.txt"), "more content", "utf8");
      const commitRes = commitCheckpoint(dir, "my checkpoint commit");
      expect(commitRes.committed).toBe(true);
      expect(commitRes.afterHash).not.toBeNull();
      expect(commitRes.afterHash).not.toBe(initialHead);

      // Test 6: commitCheckpoint on an unchanged working tree returns committed: false
      const commitUnchanged = commitCheckpoint(dir, "unchanged commit");
      expect(commitUnchanged.committed).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
