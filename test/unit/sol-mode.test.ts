import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSolPreamble, clearSolCache } from "../../src/sol-mode.js";

describe("SOL mode features", () => {
  let tempDir: string;
  let originalSolMode: string | undefined;
  let originalSolFile: string | undefined;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "acp-sol-test-"));
    originalSolMode = process.env["ACP_SOL_MODE"];
    originalSolFile = process.env["ACP_SOL_FILE"];
    clearSolCache();
  });

  afterEach(() => {
    if (originalSolMode !== undefined) {
      process.env["ACP_SOL_MODE"] = originalSolMode;
    } else {
      delete process.env["ACP_SOL_MODE"];
    }

    if (originalSolFile !== undefined) {
      process.env["ACP_SOL_FILE"] = originalSolFile;
    } else {
      delete process.env["ACP_SOL_FILE"];
    }

    clearSolCache();

    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("returns \"\" when ACP_SOL_MODE=0", () => {
    const tempFile = join(tempDir, "test-sol.md");
    writeFileSync(tempFile, "Some discipline rules here", "utf8");

    process.env["ACP_SOL_FILE"] = tempFile;

    // On: returns wrapped content
    process.env["ACP_SOL_MODE"] = "1";
    let res = readSolPreamble();
    expect(res).toContain("## SOL MODE (mandatory engineering discipline)");
    expect(res).toContain("Some discipline rules here");

    // Clear cache first to test change of mode
    clearSolCache();
    process.env["ACP_SOL_MODE"] = "0";
    expect(readSolPreamble()).toBe("");

    clearSolCache();
    process.env["ACP_SOL_MODE"] = "off";
    expect(readSolPreamble()).toBe("");
  });

  it("returns wrapped content containing \"SOL MODE\" when the file exists", () => {
    const tempFile = join(tempDir, "test-sol.md");
    const testContent = "Engineers must read before write.";
    writeFileSync(tempFile, testContent, "utf8");

    process.env["ACP_SOL_FILE"] = tempFile;
    process.env["ACP_SOL_MODE"] = "on";

    const res = readSolPreamble();
    expect(res).toContain("## SOL MODE (mandatory engineering discipline)\n");
    expect(res).toContain(testContent);
    expect(res).toContain("\n\n---\n");
  });

  it("returns \"\" for a missing ACP_SOL_FILE path", () => {
    const missingFile = join(tempDir, "does-not-exist.md");
    process.env["ACP_SOL_FILE"] = missingFile;
    process.env["ACP_SOL_MODE"] = "on";

    expect(readSolPreamble()).toBe("");
  });

  it("caps content to 9000 chars", () => {
    const tempFile = join(tempDir, "large-sol.md");
    const baseWord = "discipline ";
    const largeContent = baseWord.repeat(1000); // 11000 chars
    expect(largeContent.length).toBeGreaterThan(9000);

    writeFileSync(tempFile, largeContent, "utf8");
    process.env["ACP_SOL_FILE"] = tempFile;
    process.env["ACP_SOL_MODE"] = "on";

    const res = readSolPreamble();
    expect(res).toContain("## SOL MODE (mandatory engineering discipline)\n");
    
    // Assert the returned string length is < 9200.
    expect(res.length).toBeLessThan(9200);

    // Verify it is exactly capped at 9000 of original content + formatting wrapper.
    const expectedWrappedLength = "## SOL MODE (mandatory engineering discipline)\n".length + 9000 + "\n\n---\n".length;
    expect(res.length).toBe(expectedWrappedLength);
  });
});
