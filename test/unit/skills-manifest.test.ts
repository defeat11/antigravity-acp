import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { buildSkillsManifest } from "../../src/skills-manifest.js";

describe("skills manifest", () => {
  it("composes shared and project skills without replacing conflicts", () => {
    const dir = mkdtempSync(join(tmpdir(), "acp-skills-"));
    const shared = mkdtempSync(join(tmpdir(), "acp-shared-skills-"));
    try {
      mkdirSync(join(dir, "skills", "review"), { recursive: true });
      mkdirSync(join(shared, "review"), { recursive: true });
      writeFileSync(join(dir, "skills", "review", "SKILL.md"), "---\nname: review\n---\nproject", "utf8");
      writeFileSync(join(shared, "review", "SKILL.md"), "---\nname: review\n---\nshared", "utf8");

      const manifest = buildSkillsManifest(dir, { ACP_SKILLS_ROOTS: [shared].join(delimiter) });
      expect(manifest.entries).toHaveLength(2);
      expect(manifest.conflicts).toEqual(["review"]);
      expect(new Set(manifest.entries.map((e) => e.hash)).size).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(shared, { recursive: true, force: true });
    }
  });
});
