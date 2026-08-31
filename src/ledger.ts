import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { mkdirSync, existsSync } from "node:fs";
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

let DatabaseSync: typeof import("node:sqlite").DatabaseSync;

function getDatabaseSync() {
  if (!DatabaseSync) {
    ({ DatabaseSync } = nodeRequire("node:sqlite") as typeof import("node:sqlite"));
  }
  return DatabaseSync;
}

function ledgerPath(): string {
  return join(homedir(), ".acp", "ledger.db");
}

function ensureSchema(db: import("node:sqlite").DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      project TEXT NOT NULL,
      task TEXT NOT NULL,
      status TEXT NOT NULL,
      verify_cmd TEXT,
      verify_ok INTEGER,
      verify_attempts INTEGER NOT NULL DEFAULT 0,
      exit_code INTEGER,
      files_changed INTEGER NOT NULL DEFAULT 0,
      elapsed_sec REAL NOT NULL,
      model TEXT,
      account TEXT,
      scope_exceeded INTEGER
    );
  `);
  try {
    db.exec(`ALTER TABLE runs ADD COLUMN commit_hash TEXT`);
  } catch {
    // column already exists from a previous run — ignore
  }
  try {
    db.exec(`ALTER TABLE runs ADD COLUMN lessons_injected INTEGER`);
  } catch {
    // column already exists — ignore
  }
  try {
    db.exec(`ALTER TABLE runs ADD COLUMN map_injected INTEGER`);
  } catch {
    // column already exists — ignore
  }
}

export function recordRun(
  info: {
    project: string;
    task: string;
    status: string;
    verifyCmd: string | null;
    verifyOk: boolean | null;
    verifyAttempts: number;
    exitCode: number | null;
    filesChanged: number;
    elapsedSec: number;
    model: string | null;
    account: string | null;
    scopeExceeded?: boolean | null;
    commitHash?: string | null;
    lessonsInjected?: number | null;
    mapInjected?: number | null;
  },
  dbPathOverride?: string
): void {
  let db: import("node:sqlite").DatabaseSync | null = null;
  try {
    const dbPath = dbPathOverride ?? ledgerPath();
    mkdirSync(dirname(dbPath), { recursive: true });

    const dbClass = getDatabaseSync();
    db = new dbClass(dbPath);
    ensureSchema(db);

    const stmt = db.prepare(`
      INSERT INTO runs (
        ts, project, task, status, verify_cmd, verify_ok, verify_attempts,
        exit_code, files_changed, elapsed_sec, model, account, scope_exceeded, commit_hash,
        lessons_injected, map_injected
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      new Date().toISOString(),
      info.project,
      info.task.slice(0, 120),
      info.status,
      info.verifyCmd,
      info.verifyOk === null ? null : (info.verifyOk ? 1 : 0),
      info.verifyAttempts,
      info.exitCode,
      info.filesChanged,
      info.elapsedSec,
      info.model,
      info.account,
      info.scopeExceeded === undefined || info.scopeExceeded === null ? null : (info.scopeExceeded ? 1 : 0),
      info.commitHash ?? null,
      info.lessonsInjected ?? null,
      info.mapInjected ?? null
    );
  } catch {
    // never let ledger recording break the run
  } finally {
    if (db) {
      try {
        db.close();
      } catch {
        // ignore
      }
    }
  }
}

export function countRecentRunsByAccount(sinceMs: number, dbPathOverride?: string): Record<string, number> {
  try {
    const dbPath = dbPathOverride ?? ledgerPath();
    if (!existsSync(dbPath)) {
      return {};
    }

    const dbClass = getDatabaseSync();
    const db = new dbClass(dbPath, { readOnly: true });
    try {
      const rows = db
        .prepare("SELECT account, COUNT(*) as c FROM runs WHERE ts >= ? AND account IS NOT NULL GROUP BY account")
        .all(new Date(sinceMs).toISOString()) as Array<{ account: string; c: number }>;

      const counts: Record<string, number> = {};
      for (const row of rows) {
        if (row.account) {
          counts[row.account] = row.c;
        }
      }
      return counts;
    } finally {
      try {
        db.close();
      } catch {}
    }
  } catch {
    return {};
  }
}
