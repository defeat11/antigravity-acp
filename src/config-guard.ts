import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

export const WATCHED_CONFIG_BASENAMES = ["tsconfig.json", ".eslintrc.js", ".eslintrc.json", ".eslintrc.cjs", ".eslintrc", ".acp-verify"];

export function detectConfigTamper(
  cwd: string,
  changedFiles: string[],
  task: string
): { tampered: boolean; files: string[] } {
  try {
    const taskLower = task.toLowerCase();
    const flagged: string[] = [];

    for (const f of changedFiles) {
      const basename = f.replace(/^.*[\\/]/, "");
      if (WATCHED_CONFIG_BASENAMES.includes(basename)) {
        if (!taskLower.includes(basename.toLowerCase())) {
          flagged.push(f);
        }
      }
    }

    const pkgFile = changedFiles.find((f) => f.replace(/^.*[\\/]/, "") === "package.json");
    if (pkgFile) {
      if (
        !taskLower.includes("package.json") &&
        !taskLower.includes("eslintconfig") &&
        !taskLower.includes("ignorepattern")
      ) {
        const gitShow = spawnSync("git", ["show", "HEAD:package.json"], {
          cwd,
          encoding: "utf8",
          windowsHide: true,
        });
        if (gitShow.status === 0 && !gitShow.error) {
          const oldContent = gitShow.stdout;
          const oldPkg = JSON.parse(oldContent);
          const newPkgPath = join(cwd, "package.json");
          if (existsSync(newPkgPath)) {
            const newPkg = JSON.parse(readFileSync(newPkgPath, "utf8"));

            const oldHasEslint = oldPkg && typeof oldPkg === "object" && "eslintConfig" in oldPkg;
            const newHasEslint = newPkg && typeof newPkg === "object" && "eslintConfig" in newPkg;
            const oldEslintStr = oldHasEslint ? JSON.stringify(oldPkg.eslintConfig) : undefined;
            const newEslintStr = newHasEslint ? JSON.stringify(newPkg.eslintConfig) : undefined;

            if (newHasEslint && (!oldHasEslint || oldEslintStr !== newEslintStr)) {
              if (!flagged.includes(pkgFile)) {
                flagged.push(pkgFile);
              }
            }

            const oldScripts = oldPkg && typeof oldPkg === "object" && oldPkg.scripts && typeof oldPkg.scripts === "object" ? oldPkg.scripts : {};
            const newScripts = newPkg && typeof newPkg === "object" && newPkg.scripts && typeof newPkg.scripts === "object" ? newPkg.scripts : {};
            const oldLint = oldScripts.lint;
            const newLint = newScripts.lint;
            const oldTest = oldScripts.test;
            const newTest = newScripts.test;

            if (oldLint !== newLint || oldTest !== newTest) {
              if (!flagged.includes(pkgFile)) {
                flagged.push(pkgFile);
              }
            }
          }
        }
      }
    }

    return {
      tampered: flagged.length > 0,
      files: Array.from(new Set(flagged)),
    };
  } catch {
    return { tampered: false, files: [] };
  }
}
