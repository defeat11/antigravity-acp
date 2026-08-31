import { existsSync, readdirSync, statSync, mkdirSync, copyFileSync } from "node:fs";
import { join, basename, extname } from "node:path";
import os from "node:os";

/**
 * Captures AI-generated images produced by the agy sub-agent during a run
 * and copies them to <cwd>/.acp-images/
 */
export function collectGeneratedImages(opts: {
  home?: string;
  conversationId: string;
  cwd: string;
  sinceMs: number;
}): Array<{ src: string; dest: string; name: string; bytes: number }> {
  const home = opts.home ?? os.homedir();
  const brainDir = join(home, ".gemini", "antigravity-cli", "brain", opts.conversationId);

  try {
    if (!existsSync(brainDir)) {
      return [];
    }
  } catch {
    return [];
  }

  const results: Array<{ src: string; dest: string; name: string; bytes: number }> = [];
  const imageExtensions = new Set([".jpg", ".jpeg", ".png", ".webp"]);

  let files: string[] = [];
  try {
    files = readdirSync(brainDir);
  } catch {
    return [];
  }

  const destDir = join(opts.cwd, ".acp-images");

  for (const filename of files) {
    try {
      const srcPath = join(brainDir, filename);
      const stats = statSync(srcPath);

      if (!stats.isFile()) {
        continue;
      }

      const ext = extname(filename).toLowerCase();
      if (!imageExtensions.has(ext)) {
        continue;
      }

      if (stats.mtimeMs < opts.sinceMs) {
        continue;
      }

      // Create .acp-images dir if needed
      if (!existsSync(destDir)) {
        mkdirSync(destDir, { recursive: true });
      }

      // Handle duplicate names with numeric suffix
      let destFilename = filename;
      let destPath = join(destDir, destFilename);

      if (existsSync(destPath)) {
        const ext = extname(filename);
        const base = filename.slice(0, filename.length - ext.length);
        let counter = 1;
        while (true) {
          destFilename = `${base}_${counter}${ext}`;
          destPath = join(destDir, destFilename);
          if (!existsSync(destPath)) {
            break;
          }
          counter++;
        }
      }

      copyFileSync(srcPath, destPath);

      results.push({
        src: srcPath,
        dest: destPath,
        name: destFilename,
        bytes: stats.size,
      });
    } catch {
      // Robustness: skip files that error
    }
  }

  return results;
}
