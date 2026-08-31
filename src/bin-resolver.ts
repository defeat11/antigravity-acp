/**
 * Cross-platform resolution of the `agy` executable.
 *
 * Node's child_process.spawn with shell:false does not consult PATHEXT on
 * Windows, so spawning the bare name "agy" fails even when `agy.exe` is on PATH.
 * We resolve to an absolute path here and always spawn with shell:false, which
 * also avoids shell-quoting/injection issues with the prompt argument.
 */

import { existsSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join, dirname } from "node:path";

const WINDOWS_EXTS = [".exe", ".cmd", ".bat", ".com"];

function isExecutableFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * Resolve `bin` to an absolute executable path.
 *
 * - An absolute/relative path (containing a separator) is used as-is, trying
 *   the platform executable extensions on Windows.
 * - A bare name is searched across PATH entries.
 *
 * Returns null when nothing is found, letting the caller emit a friendly error.
 */
export function resolveExecutable(bin: string): string | null {
  const exts = process.platform === "win32" ? ["", ...WINDOWS_EXTS] : [""];

  const hasSep = bin.includes("/") || bin.includes("\\");
  if (isAbsolute(bin) || hasSep) {
    for (const ext of exts) {
      const candidate = bin + ext;
      if (isExecutableFile(candidate)) return candidate;
    }
    // Already explicit but missing — also try resolving within its directory
    // in case the caller passed e.g. "./agy".
    const dir = dirname(bin);
    const base = bin.slice(dir.length).replace(/^[\\/]/, "");
    for (const ext of exts) {
      const candidate = join(dir, base + ext);
      if (isExecutableFile(candidate)) return candidate;
    }
    return null;
  }

  const pathVar = process.env.PATH ?? process.env.Path ?? "";
  for (const dir of pathVar.split(delimiter)) {
    if (!dir) continue;
    const cleanDir = dir.replace(/^"(.*)"$/, "$1");
    for (const ext of exts) {
      const candidate = join(cleanDir, bin + ext);
      if (existsSync(candidate) && isExecutableFile(candidate)) return candidate;
    }
  }
  return null;
}
