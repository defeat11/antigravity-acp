import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { detectConfigTamper } from "../../src/config-guard.js";

describe("Config Tamper Guard Tests", () => {
  it("detects config file changes not mentioned in the task", () => {
    // 1. tsconfig.json changed, not in task
    const r1 = detectConfigTamper("/dummy", ["tsconfig.json"], "أصلح الاستيراد في src/foo.ts");
    expect(r1.tampered).toBe(true);
    expect(r1.files).toContain("tsconfig.json");

    // 2. tsconfig.json changed, mentioned in task
    const r2 = detectConfigTamper("/dummy", ["tsconfig.json"], "عدّل tsconfig.json لإضافة path جديد");
    expect(r2.tampered).toBe(false);

    // 3. Normal file changed (no config file)
    const r3 = detectConfigTamper("/dummy", ["src/foo.ts"], "أصلح الاستيراد في src/foo.ts");
    expect(r3.tampered).toBe(false);
  });

  it("handles package.json edits correctly in a git repository", () => {
    const dir = mkdtempSync(join(tmpdir(), "acp-tamper-"));
    try {
      execSync("git init", { cwd: dir, stdio: "ignore" });
      execSync("git config user.name 'Test User'", { cwd: dir, stdio: "ignore" });
      execSync("git config user.email 'test@example.com'", { cwd: dir, stdio: "ignore" });
      execSync("git config commit.gpgsign false", { cwd: dir, stdio: "ignore" });

      const initialPkg = {
        name: "test-project",
        version: "1.0.0",
        scripts: {
          lint: "eslint",
          test: "vitest run"
        }
      };
      writeFileSync(join(dir, "package.json"), JSON.stringify(initialPkg, null, 2), "utf8");
      execSync("git add package.json", { cwd: dir, stdio: "ignore" });
      execSync("git commit --no-gpg-sign -m \"commit package.json\"", { cwd: dir, stdio: "ignore" });

      // Case A: modifying a non-sensitive field (e.g., dependencies)
      const pkgWithDep = {
        ...initialPkg,
        dependencies: {
          lodash: "^4.17.21"
        }
      };
      writeFileSync(join(dir, "package.json"), JSON.stringify(pkgWithDep, null, 2), "utf8");
      const rA = detectConfigTamper(dir, ["package.json"], "add lodash dependency");
      expect(rA.tampered).toBe(false);

      // Case B: adding eslintConfig (sensitive) without mentioning it in task
      const pkgWithEslint = {
        ...initialPkg,
        eslintConfig: {
          rules: {
            semi: "error"
          }
        }
      };
      writeFileSync(join(dir, "package.json"), JSON.stringify(pkgWithEslint, null, 2), "utf8");
      const rB = detectConfigTamper(dir, ["package.json"], "add some rules to main file");
      expect(rB.tampered).toBe(true);
      expect(rB.files).toContain("package.json");

      // Case C: modifying scripts.lint (sensitive) without mentioning it in task
      const pkgWithModLint = {
        ...initialPkg,
        scripts: {
          ...initialPkg.scripts,
          lint: "eslint --fix"
        }
      };
      writeFileSync(join(dir, "package.json"), JSON.stringify(pkgWithModLint, null, 2), "utf8");
      const rC = detectConfigTamper(dir, ["package.json"], "change rule styles");
      expect(rC.tampered).toBe(true);
      expect(rC.files).toContain("package.json");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
