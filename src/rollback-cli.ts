#!/usr/bin/env node

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";

const nodeRequire = createRequire(import.meta.url);

// Silence the SQLite experimental warning
const originalEmitWarning = process.emitWarning.bind(process);
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const text = typeof warning === "string" ? warning : warning?.message ?? "";
  if (text.includes("SQLite is an experimental feature")) return;
  return (originalEmitWarning as (...a: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;

function main(): void {
  const args = process.argv.slice(2);
  const arg1 = args[0]; // could be "last", integer string, or undefined
  const cwd = resolve(process.cwd());

  const dbPath = join(homedir(), ".acp", "ledger.db");
  if (!existsSync(dbPath)) {
    process.stdout.write("لا توجد بيانات ledger بعد.\n");
    process.exit(1);
  }

  let DatabaseSync: typeof import("node:sqlite").DatabaseSync;
  try {
    ({ DatabaseSync } = nodeRequire("node:sqlite") as typeof import("node:sqlite"));
  } catch {
    process.stderr.write("تعذر تحميل وحدة SQLite.\n");
    process.exit(1);
  }

  let db: import("node:sqlite").DatabaseSync;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch (err) {
    process.stderr.write(`تعذر فتح قاعدة البيانات: ${(err as Error).message}\n`);
    process.exit(1);
  }

  let row: { id: number; ts: string; project: string; task: string; commit_hash: string | null } | undefined;
  try {
    const isId = arg1 && /^\d+$/.test(arg1);
    if (isId) {
      const idVal = parseInt(arg1, 10);
      const stmt = db.prepare("SELECT id, ts, project, task, commit_hash FROM runs WHERE id = ? AND project = ?");
      row = stmt.get(idVal, cwd) as any;
    } else {
      const stmt = db.prepare(
        "SELECT id, ts, project, task, commit_hash FROM runs WHERE project = ? AND commit_hash IS NOT NULL ORDER BY id DESC LIMIT 1"
      );
      row = stmt.get(cwd) as any;
    }
  } catch (err) {
    process.stderr.write(`خطأ أثناء الاستعلام: ${(err as Error).message}\n`);
    try {
      db.close();
    } catch {}
    process.exit(1);
  }

  if (!row || !row.commit_hash) {
    process.stdout.write("لا يوجد checkpoint صالح للتراجع عنه لهذا المشروع.\n");
    try {
      db.close();
    } catch {}
    process.exit(1);
  }

  // Close db before calling git revert
  try {
    db.close();
  } catch {}

  const taskTruncated = row.task.slice(0, 80);
  process.stdout.write(`Reverting checkpoint:\n  Task:   ${taskTruncated}\n  Date:   ${row.ts}\n  Commit: ${row.commit_hash}\n\n`);

  const gitRes = spawnSync("git", ["revert", "--no-edit", row.commit_hash], {
    cwd,
    encoding: "utf8",
    windowsHide: true,
  });

  if (gitRes.stdout) {
    process.stdout.write(gitRes.stdout);
  }
  if (gitRes.stderr) {
    process.stderr.write(gitRes.stderr);
  }

  process.exit(gitRes.status ?? 1);
}

main();
