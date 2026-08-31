import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { delimiter, join, relative, resolve } from "node:path";

export interface SkillManifestEntry {
  name: string;
  path: string;
  hash: string;
  source: "shared" | "project";
}

export interface SkillsManifest {
  entries: SkillManifestEntry[];
  conflicts: string[];
  digest: string;
  roots: string[];
}

function discoverSkillFiles(root: string, limit = 200): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const stack = [root];
  while (stack.length && out.length < limit) {
    const dir = stack.pop()!;
    let names: string[] = [];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      const full = join(dir, name);
      try {
        const st = statSync(full);
        if (st.isDirectory()) stack.push(full);
        else if (st.isFile() && name.toLowerCase() === "skill.md") out.push(full);
      } catch {
        // A concurrently removed or unreadable skill is simply omitted.
      }
      if (out.length >= limit) break;
    }
  }
  return out.sort();
}

function skillName(file: string): string {
  try {
    const text = readFileSync(file, "utf8");
    const frontmatter = text.match(/^---\s*[\r\n]+([\s\S]*?)[\r\n]+---/);
    const named = frontmatter?.[1]?.match(/^name:\s*["']?([^"'\r\n]+)["']?\s*$/m)?.[1]?.trim();
    if (named) return named;
  } catch {
    // Fall back to the containing directory name.
  }
  return file.replace(/[\\/]SKILL\.md$/i, "").replace(/^.*[\\/]/, "");
}

export function buildSkillsManifest(cwd: string, env: NodeJS.ProcessEnv = process.env): SkillsManifest {
  const projectRoots = [
    join(cwd, "skills"),
    join(cwd, ".agents", "skills"),
    join(cwd, ".gemini", "skills"),
    join(cwd, "acp-workspace", "skills"),
    join(cwd, "hermes-data", "skills"),
  ];
  const sharedRoots = (env.ACP_SKILLS_ROOTS ?? "")
    .split(delimiter)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => resolve(p));
  const roots = [...new Set([...sharedRoots, ...projectRoots.map((p) => resolve(p))])].filter(existsSync);
  const shared = new Set(sharedRoots.map((p) => resolve(p).toLowerCase()));
  const entries: SkillManifestEntry[] = [];

  for (const root of roots) {
    for (const file of discoverSkillFiles(root)) {
      let content: Buffer;
      try {
        content = readFileSync(file);
      } catch {
        continue;
      }
      entries.push({
        name: skillName(file),
        path: relative(cwd, file) || file,
        hash: createHash("sha256").update(content).digest("hex"),
        source: shared.has(root.toLowerCase()) ? "shared" : "project",
      });
    }
  }

  entries.sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
  const counts = new Map<string, number>();
  for (const entry of entries) counts.set(entry.name, (counts.get(entry.name) ?? 0) + 1);
  const conflicts = [...counts.entries()].filter(([, count]) => count > 1).map(([name]) => name).sort();
  const digest = createHash("sha256")
    .update(entries.map((e) => `${e.name}\0${e.path}\0${e.hash}`).join("\n"))
    .digest("hex");
  return { entries, conflicts, digest, roots };
}

export function renderSkillsManifest(manifest: SkillsManifest): string {
  if (manifest.entries.length === 0) return "";
  const visible = manifest.entries.slice(0, 40);
  const lines = visible.map((e) => `- ${e.name} [${e.source}] ${e.path} #${e.hash.slice(0, 10)}`);
  if (manifest.entries.length > visible.length) {
    lines.push(`- … و${manifest.entries.length - visible.length} مهارة أخرى في الـmanifest نفسه`);
  }
  const conflicts = manifest.conflicts.length
    ? `\nتعارض أسماء (لا تستبدل أي ملف): ${manifest.conflicts.join(", ")}`
    : "";
  return `## سجل المهارات المتاح (manifest ${manifest.digest.slice(0, 12)})\n${lines.join("\n")}${conflicts}\n\n`;
}
