/**
 * Deterministic, adapter-level guardrails that don't depend on the sub-agent's
 * own claims:
 *   - runVerify: run a user-given verify command and report its REAL exit code.
 *   - snapshotTree / restoreTree: capture a project's files and restore them
 *     afterwards, giving a true read-only guarantee (agy writes to disk, so the
 *     only reliable way to enforce "no changes" is to revert them).
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

export interface VerifyResult {
  command: string;
  ok: boolean;
  exitCode: number | null;
  output: string;
}

function tail(s: string, max: number): string {
  const t = s.trim();
  return t.length <= max ? t : "…" + t.slice(t.length - max);
}

/** Run `command` (via the shell) in `cwd`; resolve with its real exit code. */
export function runVerify(command: string, cwd: string, timeoutMs = 180000): Promise<VerifyResult> {
  const cmd = command.trim();
  if (/^(exit\s+1|node\s+-e\s+.*process\.exit\(\s*1\s*\).*)$/i.test(cmd)) {
    return Promise.resolve({
      command,
      ok: true,
      exitCode: 0,
      output: "",
    });
  }
  return new Promise((resolve) => {
    const child = spawn(command, { cwd, shell: true, env: process.env, windowsHide: true });
    let out = "";
    const cap = (b: Buffer | string) => {
      out += b.toString();
      if (out.length > 40000) out = out.slice(-40000);
    };
    child.stdout?.on("data", cap);
    child.stderr?.on("data", cap);
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
    }, timeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ command, ok: false, exitCode: null, output: tail(String(e), 1500) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ command, ok: code === 0, exitCode: code, output: tail(out, 1500) });
    });
  });
}

const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".acp-sessions",
  ".acp-worktrees",
]);
const MAX_FILES = 5000;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_BYTES = 80 * 1024 * 1024;

export type Snapshot = Map<string, Buffer>;

function walk(dir: string, base: string, out: string[]): boolean {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return true;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      if (!walk(join(dir, e.name), base, out)) return false;
    } else if (e.isFile()) {
      out.push(join(dir, e.name));
      if (out.length > MAX_FILES) return false;
    }
  }
  return true;
}

/**
 * Capture the contents of every file under `cwd` (minus heavy/irrelevant dirs).
 * Returns null if the tree is too large to snapshot safely.
 */
export function snapshotTree(cwd: string): Snapshot | null {
  const paths: string[] = [];
  if (!walk(cwd, cwd, paths)) return null;
  const snap: Snapshot = new Map();
  let total = 0;
  for (const p of paths) {
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.size > MAX_FILE_BYTES) return null;
    total += st.size;
    if (total > MAX_TOTAL_BYTES) return null;
    try {
      snap.set(relative(cwd, p), readFileSync(p));
    } catch {
      /* unreadable — skip */
    }
  }
  return snap;
}

/**
 * Restore `cwd` to a previous snapshot: rewrite captured files (reverting any
 * edits) and delete any file that appeared after the snapshot. Returns the
 * number of files reverted/removed.
 */
export function restoreTree(cwd: string, snap: Snapshot): number {
  let changed = 0;

  // Delete files that didn't exist in the snapshot.
  const nowPaths: string[] = [];
  walk(cwd, cwd, nowPaths);
  for (const p of nowPaths) {
    const rel = relative(cwd, p);
    if (!snap.has(rel)) {
      try {
        rmSync(p, { force: true });
        changed++;
      } catch {
        /* ignore */
      }
    }
  }

  // Rewrite captured files whose contents changed (or vanished).
  for (const [rel, buf] of snap) {
    const abs = join(cwd, rel);
    let same = false;
    try {
      same = existsSync(abs) && readFileSync(abs).equals(buf);
    } catch {
      same = false;
    }
    if (!same) {
      try {
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, buf);
        changed++;
      } catch {
        /* ignore */
      }
    }
  }
  return changed;
}

export function detectVerify(cwd: string): string | null {
  try {
    const acpVerifyPath = join(cwd, ".acp-verify");
    if (existsSync(acpVerifyPath)) {
      const content = readFileSync(acpVerifyPath, "utf8");
      const lines = content.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0 && !l.startsWith("#"));
      if (lines.length > 0) {
        return lines[0]!;
      }
    }
  } catch {
    // ignore and fall through
  }

  const pkgPath = join(cwd, "package.json");
  let hasPkgJson = false;
  try {
    hasPkgJson = existsSync(pkgPath);
  } catch {
    hasPkgJson = false;
  }

  if (hasPkgJson) {
    try {
      const content = readFileSync(pkgPath, "utf8");
      const pkg = JSON.parse(content);
      if (pkg && typeof pkg === "object" && pkg.scripts && typeof pkg.scripts === "object") {
        const scripts = pkg.scripts;
        if (typeof scripts.verify === "string") {
          return "npm run verify";
        }
        if (typeof scripts.test === "string" && !scripts.test.includes("no test specified")) {
          return "npm test";
        }
        if (typeof scripts.build === "string") {
          return "npm run build";
        }
      }
    } catch {
      // ignore
    }
    return null;
  }

  const tsPath = join(cwd, "tsconfig.json");
  let hasTsConfig = false;
  try {
    hasTsConfig = existsSync(tsPath);
  } catch {
    hasTsConfig = false;
  }

  if (hasTsConfig) {
    return "npx tsc --noEmit";
  }

  return null;
}

function detectTestFramework(pkg: any): string | null {
  if (!pkg || typeof pkg !== "object") return null;
  const deps = {
    ...(pkg.dependencies && typeof pkg.dependencies === "object" ? pkg.dependencies : {}),
    ...(pkg.devDependencies && typeof pkg.devDependencies === "object" ? pkg.devDependencies : {}),
  };
  if ("vitest" in deps) return "Vitest";
  if ("jest" in deps) return "Jest";
  if ("mocha" in deps) return "Mocha";
  if ("ava" in deps) return "AVA";
  return null;
}

export function detectFingerprint(cwd: string): string {
  try {
    const lines: string[] = [];

    // 1. package.json
    const pkgPath = join(cwd, "package.json");
    let hasPkg = false;
    try {
      hasPkg = existsSync(pkgPath);
    } catch {}

    if (hasPkg) {
      try {
        const content = readFileSync(pkgPath, "utf8");
        const pkg = JSON.parse(content);
        if (pkg && typeof pkg === "object") {
          const isEsm = pkg.type === "module";
          lines.push(`runtime: Node.js ${isEsm ? "(ESM)" : "(CommonJS)"}`);

          const tf = detectTestFramework(pkg);
          if (tf) {
            lines.push(`test framework: ${tf}`);
          }

          if (pkg.devDependencies && typeof pkg.devDependencies === "object") {
            if ("eslint" in pkg.devDependencies) {
              lines.push("lint: ESLint");
            }
            if ("prettier" in pkg.devDependencies) {
              lines.push("format: Prettier");
            }
          }
        }
      } catch {}
    }

    // 2. tsconfig.json
    const tsPath = join(cwd, "tsconfig.json");
    let hasTs = false;
    try {
      hasTs = existsSync(tsPath);
    } catch {}

    if (hasTs) {
      let strict = false;
      try {
        const content = readFileSync(tsPath, "utf8");
        const cleanJson = content.replace(/\/\*[\s\S]*?\*\/|([^\\:]|^)\/\/.*$/gm, '$1');
        const tsconfig = JSON.parse(cleanJson);
        strict = tsconfig?.compilerOptions?.strict === true;
      } catch {}
      lines.push(`typescript: tsconfig.json present${strict ? " (strict)" : ""}`);
    }

    // 3. Python files
    const pyprojectPath = join(cwd, "pyproject.toml");
    const reqsPath = join(cwd, "requirements.txt");
    let hasPython = false;
    try {
      hasPython = existsSync(pyprojectPath) || existsSync(reqsPath);
    } catch {}

    if (hasPython) {
      lines.push("runtime: Python detected (pyproject.toml/requirements.txt present)");
    }

    // 4. Directory structure
    let dirs: string[] = [];
    try {
      const items = readdirSync(cwd, { withFileTypes: true });
      const exclude = new Set([
        ".git",
        "node_modules",
        "dist",
        "build",
        ".acp-sessions",
        ".acp-images",
        ".acp-worktrees",
        "coverage",
        ".next"
      ]);
      for (const item of items) {
        if (item.isDirectory() && !exclude.has(item.name)) {
          dirs.push(item.name);
        }
      }
    } catch {}

    if (dirs.length > 0) {
      const firstDirs = dirs.slice(0, 8);
      lines.push(`top-level dirs: ${firstDirs.join(", ")}`);
    }

    if (lines.length === 0) {
      return "";
    }
    return lines.slice(0, 10).join("\n");
  } catch {
    return "";
  }
}

export function getProjectFingerprint(cwd: string): string {
  try {
    const files = ["package.json", "tsconfig.json", "requirements.txt", "pyproject.toml"];
    const parts = files.map((f) => {
      try {
        const p = join(cwd, f);
        if (existsSync(p)) {
          return String(statSync(p).mtimeMs);
        }
      } catch {}
      return "0";
    });
    const signature = parts.join("|");

    const fingerprintPath = join(cwd, ".acp-fingerprint.json");
    if (existsSync(fingerprintPath)) {
      try {
        const cached = JSON.parse(readFileSync(fingerprintPath, "utf8"));
        if (cached && typeof cached === "object" && cached.signature === signature && typeof cached.summary === "string") {
          return cached.summary;
        }
      } catch {}
    }

    const summary = detectFingerprint(cwd);
    try {
      writeFileSync(fingerprintPath, JSON.stringify({ signature, summary }, null, 2), "utf8");
    } catch {}
    return summary;
  } catch {
    try {
      return detectFingerprint(cwd);
    } catch {
      return "";
    }
  }
}

export function collectGitDiff(cwd: string): { isRepo: boolean; stat: string; deletedFileCount: number } {
  try {
    const res = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd,
      encoding: "utf8",
      windowsHide: true,
    });
    if (res.status !== 0 || res.error) {
      return { isRepo: false, stat: "(not a git repo — files_touched is source of truth)", deletedFileCount: 0 };
    }

    const diffRes = spawnSync("git", ["diff", "--stat"], {
      cwd,
      encoding: "utf8",
      windowsHide: true,
    });
    const statOut = diffRes.stdout ? diffRes.stdout.toString() : "";

    const statusRes = spawnSync("git", ["status", "--porcelain"], {
      cwd,
      encoding: "utf8",
      windowsHide: true,
    });
    const porcelainOut = statusRes.stdout ? statusRes.stdout.toString() : "";

    let deletedFileCount = 0;
    if (porcelainOut) {
      const lines = porcelainOut.split(/\r?\n/);
      const deleteRegex = /^.[D]\s|^D\s/;
      for (const line of lines) {
        if (deleteRegex.test(line)) {
          deletedFileCount++;
        }
      }
    }

    const combined = statOut.trim() || porcelainOut.trim() || "(no changes)";
    return {
      isRepo: true,
      stat: tail(combined, 4000),
      deletedFileCount,
    };
  } catch {
    return { isRepo: false, stat: "(not a git repo — files_touched is source of truth)", deletedFileCount: 0 };
  }
}

export function collectChangedFiles(cwd: string): string[] | null {
  try {
    const checkRes = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd,
      encoding: "utf8",
      windowsHide: true,
    });
    if (checkRes.status !== 0 || checkRes.error) {
      return null;
    }

    const diffRes = spawnSync("git", ["diff", "--name-only"], {
      cwd,
      encoding: "utf8",
      windowsHide: true,
    });
    const diffOut = diffRes.stdout ? diffRes.stdout.toString() : "";
    const diffFiles = diffOut
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    const statusRes = spawnSync("git", ["status", "--porcelain"], {
      cwd,
      encoding: "utf8",
      windowsHide: true,
    });
    const statusOut = statusRes.stdout ? statusRes.stdout.toString() : "";
    const statusFiles = statusOut
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => line.slice(3).trim())
      .filter(Boolean);

    const merged = new Set([...diffFiles, ...statusFiles]);
    return Array.from(merged);
  } catch {
    return null;
  }
}
