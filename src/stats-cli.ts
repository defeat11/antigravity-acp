#!/usr/bin/env node

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

// node:sqlite has no ESM named export in some Node builds; load it via require.
const nodeRequire = createRequire(import.meta.url);

// Silence the SQLite experimental warning
const originalEmitWarning = process.emitWarning.bind(process);
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const text = typeof warning === "string" ? warning : warning?.message ?? "";
  if (text.includes("SQLite is an experimental feature")) return;
  return (originalEmitWarning as (...a: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;

function main(): void {
  const dbPath = join(homedir(), ".acp", "ledger.db");
  if (!existsSync(dbPath)) {
    process.stdout.write("لا توجد بيانات مسجَّلة بعد — شغّل acp على بعض المهام أولاً.\n");
    process.exit(0);
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

  try {
    // 1. SELECT last 20 runs
    const recentRows = db
      .prepare("SELECT ts, status, verify_ok, verify_attempts, elapsed_sec, task FROM runs ORDER BY id DESC LIMIT 20")
      .all() as Array<{
        ts: string;
        status: string;
        verify_ok: number | null;
        verify_attempts: number;
        elapsed_sec: number;
        task: string;
      }>;

    const recentLines = recentRows.map((row) => {
      const vOk = row.verify_ok === null ? "-" : (row.verify_ok ? "ok" : "fail");
      return `${row.ts}  ${row.status}  verify:${vOk} attempts:${row.verify_attempts}  ${row.elapsed_sec}s  ${row.task.slice(0, 60)}`;
    });

    // 2. Success rate calculations
    const totalRow = db.prepare("SELECT COUNT(*) as count FROM runs WHERE verify_cmd IS NOT NULL").get() as { count: number };
    const okRow = db.prepare("SELECT COUNT(*) as count FROM runs WHERE verify_ok = 1").get() as { count: number };
    const firstTryRow = db.prepare("SELECT COUNT(*) as count FROM runs WHERE verify_ok = 1 AND verify_attempts = 1").get() as { count: number };

    const total = totalRow?.count ?? 0;
    const okCount = okRow?.count ?? 0;
    const firstTryCount = firstTryRow?.count ?? 0;

    let firstTryStr = "0/0 (0%)";
    let overallStr = "0/0 (0%)";

    if (total > 0) {
      firstTryStr = `${firstTryCount}/${total} (${((firstTryCount / total) * 100).toFixed(1)}%)`;
      overallStr = `${okCount}/${total} (${((okCount / total) * 100).toFixed(1)}%)`;
    }

    // 3. Slowest 3 runs
    const slowestRows = db
      .prepare("SELECT elapsed_sec, ts, task FROM runs ORDER BY elapsed_sec DESC LIMIT 3")
      .all() as Array<{
        elapsed_sec: number;
        ts: string;
        task: string;
      }>;

    const slowestLines = slowestRows.map((row) => {
      return `${row.elapsed_sec}s  ${row.ts}  ${row.task}`;
    });

    // Output printing
    process.stdout.write("== ACP Ledger: last 20 runs ==\n");
    if (recentLines.length > 0) {
      process.stdout.write(recentLines.join("\n") + "\n");
    }
    process.stdout.write("\n== Success rate ==\n");
    process.stdout.write(`first-try verified: ${firstTryStr}\n`);
    process.stdout.write(`overall verified:   ${overallStr}\n`);
    process.stdout.write("\n== Slowest 3 ==\n");
    if (slowestLines.length > 0) {
      process.stdout.write(slowestLines.join("\n") + "\n");
    }
  } catch (err) {
    process.stderr.write(`خطأ أثناء قراءة البيانات: ${(err as Error).message}\n`);
  } finally {
    try {
      db.close();
    } catch {
      // ignore
    }
  }
}

main();
