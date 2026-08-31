import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { collectChangedFiles } from "../../src/run-extras.js";

describe("Scope Guard collectChangedFiles", () => {
  it("collects changed and untracked files in a git repo", () => {
    const dir = mkdtempSync(join(tmpdir(), "acp-scope-test-"));
    try {
      execSync("git init", { cwd: dir, stdio: "ignore" });
      execSync("git config user.name 'Test User'", { cwd: dir, stdio: "ignore" });
      execSync("git config user.email 'test@example.com'", { cwd: dir, stdio: "ignore" });
      execSync("git config commit.gpgsign false", { cwd: dir, stdio: "ignore" });

      // Create initial file and commit it
      const file1 = "initial.txt";
      writeFileSync(join(dir, file1), "initial content", "utf8");
      execSync("git add initial.txt", { cwd: dir, stdio: "ignore" });
      execSync("git commit --no-gpg-sign -m \"Initial commit\"", { cwd: dir, stdio: "ignore" });

      // Now modify the initial file, and create a new untracked file
      writeFileSync(join(dir, file1), "modified content", "utf8");

      const file2 = "new-untracked.txt";
      writeFileSync(join(dir, file2), "new content", "utf8");

      const changed = collectChangedFiles(dir);
      expect(changed).not.toBeNull();
      expect(changed).toContain("initial.txt");
      expect(changed).toContain("new-untracked.txt");
      expect(changed!.length).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns null for a non-git directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "acp-scope-non-git-"));
    try {
      const changed = collectChangedFiles(dir);
      expect(changed).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
