import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const MAP_FILE_NAME = ".acp-map.md";
const MAX_MAP_ENTRIES = 60;
const MAX_DESC_CHARS = 200;

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max) + "…";
}

export function computeFileHash(cwd: string, relPath: string): string | null {
  try {
    const fullPath = join(cwd, relPath);
    if (!existsSync(fullPath)) {
      return null;
    }
    const res = spawnSync("git", ["hash-object", relPath], {
      cwd,
      encoding: "utf8",
      windowsHide: true,
    });
    if (res.status === 0 && !res.error) {
      return res.stdout.trim();
    }
    return null;
  } catch {
    return null;
  }
}

export function readMapPreamble(cwd: string): string {
  try {
    const mapPath = join(cwd, MAP_FILE_NAME);
    if (!existsSync(mapPath)) {
      return "";
    }
    const content = readFileSync(mapPath, "utf8");
    const lines = content.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const regex = /^- `([^`]+)` \[([a-f0-9]+|no-git)\]: (.*)$/;
    const processedLines: string[] = [];

    for (const line of lines) {
      const match = regex.exec(line);
      if (!match) continue;
      const pathVal = match[1]!;
      const storedHash = match[2]!;

      const currentHash = computeFileHash(cwd, pathVal);
      if (currentHash === null) {
        processedLines.push(`[تعذّر التحقق] ${line}`);
      } else if (storedHash === "no-git") {
        processedLines.push(line);
      } else if (currentHash !== storedHash) {
        processedLines.push(`[STALE — الملف تغيّر منذ آخر تحديث، أعد قراءته] ${line}`);
      } else {
        processedLines.push(line);
      }
    }

    if (processedLines.length === 0) {
      return "";
    }

    return (
      "## خريطة المشروع (اجتهاد سابق لملفات سبق لمسها في تفويضات سابقة — معلومات وصفية فقط، وليست بديلاً عن قراءة الملف الذي ستُعدّله فعلاً في هذه المهمة. الأسطر المُعلَّمة [STALE] تغيّر ملفها منذ آخر تحديث):\n" +
      processedLines.join("\n") +
      "\n\n---\n\n"
    );
  } catch {
    return "";
  }
}

export function extractMapUpdates(message: string): Array<{ path: string; description: string }> {
  const lines = message.split(/\r?\n/);
  const idx = lines.findIndex((l) => l.trim() === "MAP_UPDATE:");
  if (idx === -1) return [];

  const updates: Array<{ path: string; description: string }> = [];
  let emptyLineCount = 0;

  for (let i = idx + 1; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();
    if (trimmed === "") {
      emptyLineCount++;
      if (emptyLineCount >= 2) {
        break;
      }
      continue;
    }
    emptyLineCount = 0;

    if (trimmed.startsWith("- ")) {
      const parts = trimmed.slice(2).trim();
      const colonIdx = parts.indexOf(":");
      if (colonIdx === -1) continue;
      const pathVal = parts.slice(0, colonIdx).trim();
      const descVal = parts.slice(colonIdx + 1).trim();
      if (pathVal) {
        updates.push({ path: pathVal, description: descVal });
      }
    }
  }

  return updates.slice(0, 20);
}

export function updateMap(cwd: string, message: string): void {
  try {
    const entries = extractMapUpdates(message);
    if (entries.length === 0) {
      return;
    }

    const mapPath = join(cwd, MAP_FILE_NAME);
    const existingLines: string[] = [];
    if (existsSync(mapPath)) {
      try {
        const content = readFileSync(mapPath, "utf8");
        existingLines.push(...content.split(/\r?\n/).map((l) => l.trim()).filter(Boolean));
      } catch {
        // Ignore read errors
      }
    }

    const regex = /^- `([^`]+)` \[([a-f0-9]+|no-git)\]: (.*)$/;
    const lineMap = new Map<string, string>();
    for (const line of existingLines) {
      const match = regex.exec(line);
      if (match && match[1]) {
        lineMap.set(match[1], line);
      }
    }

    for (const entry of entries) {
      const fullPath = join(cwd, entry.path);
      if (!existsSync(fullPath)) {
        continue;
      }
      const hash = computeFileHash(cwd, entry.path) ?? "no-git";
      const newLine = `- \`${entry.path}\` [${hash}]: ${truncate(entry.description, MAX_DESC_CHARS)}`;
      lineMap.delete(entry.path);
      lineMap.set(entry.path, newLine);
    }

    let values = Array.from(lineMap.values());
    if (values.length > MAX_MAP_ENTRIES) {
      values = values.slice(-MAX_MAP_ENTRIES);
    }

    const header =
      "# خريطة المشروع (acp)\n\nهذا الملف يُنشئه ويُحدّثه agy تلقائياً بعد كل تفويض ناجح. لا تعدّله يدوياً — أي تعديل يدوي سيُكتشف كـ[تعذّر التحقق] أو يُستبدَل عند أول تحديث تالٍ لنفس الملف.\n\n";
    writeFileSync(mapPath, header + values.join("\n") + "\n", "utf8");
  } catch {
    // never let map updates break the run
  }
}
