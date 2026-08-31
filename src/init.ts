#!/usr/bin/env node
/**
 * acp-init — prepare a project to use the Antigravity sub-agent.
 *
 * Run once per project. It does NOT copy the adapter (that's a shared tool);
 * it just sets up the project's isolated state and a short `acp` launcher:
 *   - creates `<project>/.acp-sessions/` (per-project session store lives here)
 *   - adds `.acp-sessions/` + the launchers to `.gitignore`
 *   - writes `acp.cmd` (Windows) and `acp` (bash) that call this adapter with
 *     ACP_AGY_CWD pinned to the project — so you type `acp "task"` from anywhere
 *     in the project. Subcommands: `acp fanout …`, `acp capacity …`, `acp sessions`.
 *
 * Usage:  node dist/init.js [projectDir]   (defaults to the current directory)
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(import.meta.url);
const ACP_HOME = dirname(dirname(here)); // <ACP_HOME>/dist/init.js -> <ACP_HOME>
const ACP_HOME_WIN = ACP_HOME.replace(/\//g, "\\");
const ACP_HOME_POSIX = ACP_HOME.replace(/\\/g, "/");

const GITIGNORE_ENTRIES = [".acp-sessions/", ".acp-images/", ".acp-lessons.md", ".acp-fingerprint.json", ".acp-map.md", "acp.cmd", "acp"];

const CMD_LAUNCHER = `@echo off
setlocal EnableDelayedExpansion
set "ACP_HOME=${ACP_HOME_WIN}"
if defined ANTIGRAVITY_ACP_HOME set "ACP_HOME=!ANTIGRAVITY_ACP_HOME!"
set "ACP_AGY_CWD=%~dp0."
set "SUB=delegate"
if /I "%~1"=="fanout"   ( set "SUB=fanout"   & shift )
if /I "%~1"=="capacity" ( set "SUB=capacity" & shift )
if /I "%~1"=="sessions" ( node "%ACP_HOME%\\dist\\delegate.js" --list-sessions & exit /b )
set "ARGS="
:loop
if "%~1"=="" goto run
set "ARGS=!ARGS! "%~1""
shift
goto loop
:run
node "%ACP_HOME%\\dist\\!SUB!.js"!ARGS!
`;

const SH_LAUNCHER = `#!/usr/bin/env bash
ACP_HOME="\${ANTIGRAVITY_ACP_HOME:-${ACP_HOME_POSIX}}"
here="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
export ACP_AGY_CWD="$here"
sub=delegate
case "$1" in
  fanout) sub=fanout; shift;;
  capacity) sub=capacity; shift;;
  sessions) exec node "$ACP_HOME/dist/delegate.js" --list-sessions;;
esac
exec node "$ACP_HOME/dist/$sub.js" "$@"
`;

function ensureGitignore(projectDir: string): string {
  const path = join(projectDir, ".gitignore");
  const isGit = existsSync(join(projectDir, ".git"));
  if (!existsSync(path) && !isGit) return "skipped (not a git project)";

  let content = "";
  try {
    content = readFileSync(path, "utf8");
  } catch {
    content = "";
  }
  const have = new Set(content.split(/\r?\n/).map((l) => l.trim()));
  const missing = GITIGNORE_ENTRIES.filter((e) => !have.has(e));
  if (missing.length === 0) return "already up to date";

  const block =
    (content && !content.endsWith("\n") ? "\n" : "") +
    "\n# Antigravity ACP (per-project state + launchers)\n" +
    missing.join("\n") +
    "\n";
  writeFileSync(path, content + block, "utf8");
  return `added ${missing.join(", ")}`;
}

function main(): void {
  const projectDir = resolve(process.argv[2] ?? process.cwd());
  if (!existsSync(projectDir)) {
    process.stderr.write(`project directory not found: ${projectDir}\n`);
    process.exit(2);
  }

  mkdirSync(join(projectDir, ".acp-sessions"), { recursive: true });

  const cmdPath = join(projectDir, "acp.cmd");
  const shPath = join(projectDir, "acp");
  writeFileSync(cmdPath, CMD_LAUNCHER, "utf8");
  writeFileSync(shPath, SH_LAUNCHER, "utf8");
  try {
    chmodSync(shPath, 0o755);
  } catch {
    /* chmod is a no-op / unsupported on some filesystems */
  }

  const gi = ensureGitignore(projectDir);

  const out = [
    "✓ project ready for Antigravity sub-agents",
    `  project:   ${projectDir}`,
    `  adapter:   ${ACP_HOME}`,
    `  created:   .acp-sessions/ (isolated session store)  ·  acp.cmd  ·  acp`,
    "  .acp-verify (اختياري): ملف نصي بجذر المشروع، سطر واحد = أمر التحقق (مثال: php -l src/*.php) — مفيد للمشاريع غير Node/TypeScript.",
    `  gitignore: ${gi}`,
    "",
    "use it from this project:",
    '  acp "add a /health route to server.js"        (delegate · opens live viewer)',
    '  acp fanout --worktree --concurrency 3 --task "A" --task "B"',
    "  acp capacity --stress 8",
    "  acp sessions                                  (list saved sessions)",
    "",
    "isolation: every session here maps to its own agy conversation id, kept in",
    "this project's .acp-sessions/sessions.json — projects never mix.",
    "",
    "Claude consultant mode: paste CONSULTANT-MODE.md and work in this directory.",
  ].join("\n");
  process.stdout.write(out + "\n");
}

main();
