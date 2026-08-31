import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getProjectFingerprint } from "../../src/run-extras.js";

describe("getProjectFingerprint", () => {
  it("generates correct project fingerprint and caches it", () => {
    const dir = mkdtempSync(join(tmpdir(), "acp-fingerprint-test-"));
    try {
      const pkgContent = JSON.stringify({
        name: "test-fingerprint-pkg",
        type: "module",
        devDependencies: {
          vitest: "^2.1.0",
          eslint: "^9.0.0"
        }
      });
      const tsContent = JSON.stringify({
        compilerOptions: {
          strict: true
        }
      });

      writeFileSync(join(dir, "package.json"), pkgContent, "utf8");
      writeFileSync(join(dir, "tsconfig.json"), tsContent, "utf8");

      const fp1 = getProjectFingerprint(dir);
      expect(fp1).toContain("runtime: Node.js (ESM)");
      expect(fp1).toContain("test framework: Vitest");
      expect(fp1).toContain("lint: ESLint");
      expect(fp1).toContain("typescript: tsconfig.json present (strict)");

      // Second consecutive call
      const fp2 = getProjectFingerprint(dir);
      expect(fp2).toBe(fp1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("handles an empty directory cleanly", () => {
    const dir = mkdtempSync(join(tmpdir(), "acp-fingerprint-empty-"));
    try {
      const fp = getProjectFingerprint(dir);
      expect(fp).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
