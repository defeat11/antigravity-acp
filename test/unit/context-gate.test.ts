import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildContextGate } from "../../src/context-gate.js";

describe("Context Gate", () => {
  it("reads baseline and task-relevant files without reading secrets", () => {
    const dir = mkdtempSync(join(tmpdir(), "acp-context-"));
    try {
      mkdirSync(join(dir, "src"));
      writeFileSync(join(dir, "README.md"), "project architecture", "utf8");
      writeFileSync(join(dir, "package.json"), '{"scripts":{"test":"vitest"}}', "utf8");
      writeFileSync(join(dir, "src", "accounts.ts"), "export function switchAccount() {}", "utf8");
      writeFileSync(join(dir, ".env"), "SECRET=never-read", "utf8");

      const result = buildContextGate(dir, "fix switchAccount in accounts", 8000);
      expect(result.filesRead).toContain("README.md");
      expect(result.filesRead).toContain("package.json");
      expect(result.relevantFiles).toContain(join("src", "accounts.ts"));
      expect(result.filesRead).not.toContain(".env");
      expect(result.text).not.toContain("never-read");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
