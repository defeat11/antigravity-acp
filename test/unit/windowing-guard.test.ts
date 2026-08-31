import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Guards against the exact bug that caused today's "a new tab/window keeps
 * popping up" complaint: four different source files (delegate, fanout,
 * swarm, monitor) each grew their own copy-pasted browser/console-opening
 * helper over ~a year, and their defaults silently drifted out of sync.
 *
 * windowing.ts is now the only file allowed to spawn `cmd /c start` (browser
 * tab or console window). If a second implementation reappears anywhere else
 * in src/, this test fails loudly instead of the bug resurfacing silently.
 */
describe("windowing guard", () => {
  it("only windowing.ts spawns `cmd ... start` (browser tabs / console windows)", () => {
    const srcDir = join(__dirname, "..", "..", "src");
    const offenders: string[] = [];

    for (const name of readdirSync(srcDir)) {
      if (!name.endsWith(".ts") || name === "windowing.ts") continue;
      const text = readFileSync(join(srcDir, name), "utf8");
      if (/\bstart\b.*\burl\b|"\/c",\s*"start"/.test(text) || /spawn\(\s*"cmd"/.test(text)) {
        offenders.push(name);
      }
    }

    expect(offenders).toEqual([]);
  });
});
