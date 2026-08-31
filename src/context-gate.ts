import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, relative, resolve, sep } from "node:path";

const BASE_FILES = [
  "README.md", "AGENTS.md", "GEMINI.md", "package.json", "tsconfig.json",
  "pyproject.toml", "requirements.txt", "Cargo.toml", "go.mod", ".acp-verify",
];
const SOURCE_EXTS = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs", ".py", ".go", ".rs", ".java", ".cs", ".php", ".md"]);
const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", "coverage", ".acp-sessions", "backups", "logs", "hermes-data", "__pycache__"]);
const STOP_WORDS = new Set(["this", "that", "with", "from", "into", "project", "file", "task", "على", "إلى", "هذا", "هذه", "التي", "الذي", "المشروع", "ملف", "مهمة"]);

export interface ContextGateResult {
  filesRead: string[];
  relevantFiles: string[];
  text: string;
}

function isInside(root: string, file: string): boolean {
  const base = resolve(root);
  const full = resolve(file);
  return full === base || full.startsWith(base + sep);
}

function safeRead(root: string, rel: string, maxChars: number): string | null {
  const full = resolve(root, rel);
  if (!isInside(root, full) || !existsSync(full)) return null;
  try {
    if (!statSync(full).isFile()) return null;
    return readFileSync(full, "utf8").slice(0, maxChars);
  } catch {
    return null;
  }
}

function taskTokens(task: string): string[] {
  const tokens = task.toLowerCase().match(/[a-z_][a-z0-9_-]{3,}|[\u0600-\u06ff]{4,}/g) ?? [];
  return [...new Set(tokens.filter((t) => !STOP_WORDS.has(t)))].slice(0, 12);
}

function walkSources(cwd: string, limit = 1200): string[] {
  const out: string[] = [];
  const stack = [cwd];
  while (stack.length && out.length < limit) {
    const dir = stack.pop()!;
    let names: string[] = [];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (name === ".env" || name.startsWith(".env.")) continue;
      const full = join(dir, name);
      try {
        const st = statSync(full);
        if (st.isDirectory()) {
          if (!SKIP_DIRS.has(name)) stack.push(full);
        } else if (st.isFile() && SOURCE_EXTS.has(extname(name).toLowerCase()) && st.size <= 1_000_000) {
          out.push(relative(cwd, full));
        }
      } catch {
        // Ignore files racing with the scan.
      }
      if (out.length >= limit) break;
    }
  }
  return out;
}

function scoreFile(cwd: string, rel: string, tokens: string[]): number {
  const pathText = rel.toLowerCase();
  let score = tokens.reduce((n, token) => n + (pathText.includes(token) ? 5 : 0), 0);
  if (score >= 10) return score;
  const content = safeRead(cwd, rel, 12_000)?.toLowerCase() ?? "";
  for (const token of tokens) if (content.includes(token)) score += 1;
  return score;
}

export function buildContextGate(cwd: string, task: string, maxChars = 18_000): ContextGateResult {
  const filesRead: string[] = [];
  const sections: string[] = [];
  let remaining = Math.max(4_000, maxChars);

  const add = (rel: string, content: string, perFile = 3_000): void => {
    if (filesRead.includes(rel) || remaining <= 200) return;
    const clipped = content.slice(0, Math.min(perFile, remaining));
    sections.push(`### ${rel}\n${clipped}`);
    filesRead.push(rel);
    remaining -= clipped.length;
  };

  for (const rel of BASE_FILES) {
    const content = safeRead(cwd, rel, 4_000);
    if (content !== null) add(rel, content);
  }

  const tokens = taskTokens(task);
  const ranked = tokens.length
    ? walkSources(cwd)
        .map((rel) => ({ rel, score: scoreFile(cwd, rel, tokens) }))
        .filter((x) => x.score > 0 && !filesRead.includes(x.rel))
        .sort((a, b) => b.score - a.score || a.rel.localeCompare(b.rel))
        .slice(0, 8)
    : [];
  for (const item of ranked) {
    const content = safeRead(cwd, item.rel, 3_000);
    if (content !== null) add(item.rel, content, 2_500);
  }

  const relevantFiles = ranked.map((x) => x.rel);
  const text = sections.length
    ? `## Context Gate — اقرأ هذا السياق قبل أي كتابة\nالملفات المقروءة حتميًا: ${filesRead.join(", ")}\nالملفات المرشحة للمهمة: ${relevantFiles.join(", ") || "لا يوجد تطابق نصي؛ افحص بالبحث قبل التعديل."}\n\n${sections.join("\n\n")}\n\n---\n`
    : "";
  return { filesRead, relevantFiles, text };
}
