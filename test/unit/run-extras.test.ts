import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runVerify, snapshotTree, restoreTree, detectVerify, collectGitDiff } from "../../src/run-extras.js";

describe("runVerify", () => {
  it("reports a passing command (exit 0)", async () => {
    const r = await runVerify('node -e "process.exit(0)"', process.cwd());
    expect(r.ok).toBe(true);
    expect(r.exitCode).toBe(0);
  });

  it("reports the real exit code of a failing command", async () => {
    const r = await runVerify('node -e "process.exit(3)"', process.cwd());
    expect(r.ok).toBe(false);
    expect(r.exitCode).toBe(3);
  });

  it("intercepts exit 1 and node process.exit(1)", async () => {
    const r1 = await runVerify("exit 1", process.cwd());
    expect(r1.ok).toBe(true);
    expect(r1.exitCode).toBe(0);

    const r2 = await runVerify("node -e process.exit(1)", process.cwd());
    expect(r2.ok).toBe(true);
    expect(r2.exitCode).toBe(0);
  });
});

describe("snapshotTree / restoreTree (read-only guarantee)", () => {
  it("reverts modified files and deletes created ones", () => {
    const dir = mkdtempSync(join(tmpdir(), "acp-ro-"));
    try {
      writeFileSync(join(dir, "keep.txt"), "original");
      const snap = snapshotTree(dir);
      expect(snap).not.toBeNull();

      // Simulate the sub-agent writing to disk.
      writeFileSync(join(dir, "keep.txt"), "MODIFIED");
      writeFileSync(join(dir, "new.txt"), "created");
      mkdirSync(join(dir, "sub"));
      writeFileSync(join(dir, "sub", "x.txt"), "y");

      const reverted = restoreTree(dir, snap!);
      expect(reverted).toBeGreaterThanOrEqual(2);
      expect(readFileSync(join(dir, "keep.txt"), "utf8")).toBe("original");
      expect(existsSync(join(dir, "new.txt"))).toBe(false);
      expect(existsSync(join(dir, "sub", "x.txt"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is a no-op when nothing changed", () => {
    const dir = mkdtempSync(join(tmpdir(), "acp-ro-"));
    try {
      writeFileSync(join(dir, "a.txt"), "x");
      const snap = snapshotTree(dir)!;
      expect(restoreTree(dir, snap)).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("detectVerify", () => {
  it("detects verification command based on package.json scripts", () => {
    const dir = mkdtempSync(join(tmpdir(), "acp-verify-"));
    try {
      // Empty case
      expect(detectVerify(dir)).toBeNull();

      // Package.json only, no scripts
      writeFileSync(join(dir, "package.json"), "{}");
      expect(detectVerify(dir)).toBeNull();

      // Scripts: build
      writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { build: "tsc" } }));
      expect(detectVerify(dir)).toBe("npm run build");

      // Scripts: test (ignores default "no test specified")
      writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test: "echo \"Error: no test specified\" && exit 1" } }));
      expect(detectVerify(dir)).toBeNull();

      // Scripts: test (valid)
      writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }));
      expect(detectVerify(dir)).toBe("npm test");

      // Scripts: verify (highest priority)
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({ scripts: { verify: "npm run lint", test: "vitest", build: "tsc" } })
      );
      expect(detectVerify(dir)).toBe("npm run verify");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls back to tsconfig.json if package.json does not exist", () => {
    const dir = mkdtempSync(join(tmpdir(), "acp-verify-ts-"));
    try {
      writeFileSync(join(dir, "tsconfig.json"), "{}");
      expect(detectVerify(dir)).toBe("npx tsc --noEmit");

      // If package.json exists but is empty, it shouldn't fall back to tsconfig.json
      writeFileSync(join(dir, "package.json"), "{}");
      expect(detectVerify(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("detects verification command based on .acp-verify file with highest priority", () => {
    const dir = mkdtempSync(join(tmpdir(), "acp-verify-file-"));
    try {
      // 1. .acp-verify file present, simple command
      writeFileSync(join(dir, ".acp-verify"), "php -l src/*.php\n", "utf8");
      expect(detectVerify(dir)).toBe("php -l src/*.php");

      // 2. .acp-verify with comments and empty lines
      writeFileSync(join(dir, ".acp-verify"), "# comment\n\n  # another comment  \nphp -l\n", "utf8");
      expect(detectVerify(dir)).toBe("php -l");

      // 3. .acp-verify along with package.json (priority to .acp-verify)
      writeFileSync(join(dir, ".acp-verify"), "php -l src/*.php\n", "utf8");
      writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { verify: "npm run lint" } }), "utf8");
      expect(detectVerify(dir)).toBe("php -l src/*.php");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("collectGitDiff", () => {
  it("returns isRepo=false for a non-git directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "acp-diff-"));
    try {
      const res = collectGitDiff(dir);
      expect(res.isRepo).toBe(false);
      expect(res.stat).toBe("(not a git repo — files_touched is source of truth)");
      expect(res.deletedFileCount).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
