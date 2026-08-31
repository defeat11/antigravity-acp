import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { commitCheckpoint } from "../../src/checkpoint.js";

describe("commitCheckpoint scopeFiles integration tests", () => {
  it("only stages and commits files within scopeFiles, leaving out-of-scope files modified", () => {
    const dir = mkdtempSync(join(tmpdir(), "acp-checkpoint-scope-"));
    try {
      // 1. Initialize git repo
      execSync("git init", { cwd: dir, stdio: "ignore" });
      execSync("git config user.name 'Test User'", { cwd: dir, stdio: "ignore" });
      execSync("git config user.email 'test@example.com'", { cwd: dir, stdio: "ignore" });
      execSync("git config commit.gpgsign false", { cwd: dir, stdio: "ignore" });

      // Create two files
      const file1 = "file1.txt";
      const file2 = "file2.txt";
      writeFileSync(join(dir, file1), "initial content 1", "utf8");
      writeFileSync(join(dir, file2), "initial content 2", "utf8");

      // Stage and commit file1 as baseline
      execSync(`git add ${file1}`, { cwd: dir, stdio: "ignore" });
      execSync("git commit --no-gpg-sign -m \"baseline\"", { cwd: dir, stdio: "ignore" });

      // Modify both files (file1 is modified, file2 is untracked)
      writeFileSync(join(dir, file1), "modified content 1", "utf8");
      writeFileSync(join(dir, file2), "modified content 2", "utf8");

      // Run commitCheckpoint with scopeFiles listing only file1
      const res = commitCheckpoint(dir, "checkpoint commit", [file1]);
      expect(res.committed).toBe(true);
      expect(res.afterHash).not.toBeNull();

      // Check git status
      const status = execSync("git status --porcelain", { cwd: dir, encoding: "utf8" }).trim();
      // file1 should be committed (clean). file2 should still be untracked/modified.
      expect(status).toContain("?? file2.txt");
      expect(status).not.toContain("file1.txt");

      // Verify file1 content is indeed the modified one in git log
      const showContent = execSync(`git show HEAD:${file1}`, { cwd: dir, encoding: "utf8" }).trim();
      expect(showContent).toBe("modified content 1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("works when both files are tracked, only committing the in-scope file", () => {
    const dir = mkdtempSync(join(tmpdir(), "acp-checkpoint-scope-tracked-"));
    try {
      // Initialize git repo
      execSync("git init", { cwd: dir, stdio: "ignore" });
      execSync("git config user.name 'Test User'", { cwd: dir, stdio: "ignore" });
      execSync("git config user.email 'test@example.com'", { cwd: dir, stdio: "ignore" });
      execSync("git config commit.gpgsign false", { cwd: dir, stdio: "ignore" });

      // Create two files
      const file1 = "file1.txt";
      const file2 = "file2.txt";
      writeFileSync(join(dir, file1), "initial content 1", "utf8");
      writeFileSync(join(dir, file2), "initial content 2", "utf8");

      // Stage and commit both files as baseline
      execSync("git add file1.txt file2.txt", { cwd: dir, stdio: "ignore" });
      execSync("git commit --no-gpg-sign -m \"baseline\"", { cwd: dir, stdio: "ignore" });

      // Modify both files
      writeFileSync(join(dir, file1), "modified content 1", "utf8");
      writeFileSync(join(dir, file2), "modified content 2", "utf8");

      // Run commitCheckpoint with scopeFiles listing only file1
      const res = commitCheckpoint(dir, "checkpoint commit 2", [file1]);
      expect(res.committed).toBe(true);

      // Check git status
      const status = execSync("git status --porcelain", { cwd: dir, encoding: "utf8" }).trim();
      // file1 should be committed (clean). file2 should still be modified.
      expect(status).toBe("M file2.txt");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
