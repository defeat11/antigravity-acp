import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { extractMapUpdates, updateMap, readMapPreamble } from "../../src/map.js";

describe("Project Map Unit Tests", () => {
  it("extractMapUpdates extracts updates correctly", () => {
    const msg = [
      "Here is a message.",
      "MAP_UPDATE:",
      "- src/foo.ts: manages foo operations",
      "- src/bar.ts: manages bar operations",
      "",
      "Some other text afterwards."
    ].join("\n");

    const updates = extractMapUpdates(msg);
    expect(updates).toEqual([
      { path: "src/foo.ts", description: "manages foo operations" },
      { path: "src/bar.ts", description: "manages bar operations" }
    ]);

    const empty = extractMapUpdates("some random message without header");
    expect(empty).toEqual([]);
  });

  it("updates the map file and detects stale file modifications", () => {
    const dir = mkdtempSync(join(tmpdir(), "acp-map-test-"));
    try {
      // 1. Initialize git repo
      execSync("git init", { cwd: dir, stdio: "ignore" });
      execSync("git config user.name 'Test User'", { cwd: dir, stdio: "ignore" });
      execSync("git config user.email 'test@example.com'", { cwd: dir, stdio: "ignore" });
      execSync("git config commit.gpgsign false", { cwd: dir, stdio: "ignore" });

      // Create hello.js and commit it
      const filename = "hello.js";
      writeFileSync(join(dir, filename), "console.log('hello');", "utf8");
      execSync("git add hello.js", { cwd: dir, stdio: "ignore" });
      execSync("git commit --no-gpg-sign -m \"Initial commit\"", { cwd: dir, stdio: "ignore" });

      // 2. Call updateMap
      updateMap(dir, "MAP_UPDATE:\n- hello.js: file description");

      // 3. Call readMapPreamble
      const preamble1 = readMapPreamble(dir);
      expect(preamble1).toContain("hello.js");
      expect(preamble1).not.toContain("[STALE — الملف تغيّر");
      expect(preamble1).not.toContain("[تعذّر التحقق]");

      // 4. Modify the file on disk (changing its hash-object)
      writeFileSync(join(dir, filename), "console.log('hello modified');", "utf8");

      // 5. Call readMapPreamble again
      const preamble2 = readMapPreamble(dir);
      expect(preamble2).toContain("hello.js");
      expect(preamble2).toContain("[STALE");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
