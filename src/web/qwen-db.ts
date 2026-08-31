import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";

export interface ConsultRecord {
  id: string;
  created_at: string;
  session: string;
  question: string;
  answer: string | null;
  model: string | null;
  thinking: string | null;
  conversation_url: string | null;
  duration_ms: number | null;
  status: "ok" | "timeout" | "error" | "site_error" | "stalled" | "tag_missing";
  error: string | null;
  metadata: string | null;
}

export interface ListConsultsOptions {
  limit?: number;
  session?: string;
  search?: string;
  since?: string;
}

export interface ConsultStats {
  total: number;
  successCount: number;
  successRatePercent: number;
  medianDurationMs: number | null;
  slowestDurationMs: number | null;
  sessionCounts: Record<string, number>;
}

export function getQwenDbPath(): string {
  if (process.env.ACP_QWEN_DB_PATH) {
    return process.env.ACP_QWEN_DB_PATH;
  }
  return join(homedir(), ".acp", "qwen.db");
}

const require = createRequire(import.meta.url);
let DatabaseSyncClass: any = null;

try {
  const mod = require("node:sqlite");
  DatabaseSyncClass = mod.DatabaseSync;
} catch {
  DatabaseSyncClass = null;
}

export function openDb(dbPath?: string): any {
  if (!DatabaseSyncClass) {
    throw new Error("node:sqlite is required (Node >=22.5.0 required for Qwen DB archive)");
  }
  const pPath = dbPath ?? getQwenDbPath();
  const parentDir = dirname(pPath);
  if (parentDir && parentDir !== ".") {
    mkdirSync(parentDir, { recursive: true });
  }

  const db = new DatabaseSyncClass(pPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS consults (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      session TEXT NOT NULL,
      question TEXT NOT NULL,
      answer TEXT,
      model TEXT,
      thinking TEXT,
      conversation_url TEXT,
      duration_ms INTEGER,
      status TEXT NOT NULL,
      error TEXT,
      metadata TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_consults_session ON consults(session);
    CREATE INDEX IF NOT EXISTS idx_consults_created_at ON consults(created_at);
  `);
  return db;
}

export function closeDb(db: any): void {
  if (db && typeof db.close === "function") {
    try {
      db.close();
    } catch {}
  }
}

export function insertConsult(
  rec: Partial<ConsultRecord> & {
    session: string;
    question: string;
    status: ConsultRecord["status"];
  },
  dbPath?: string
): ConsultRecord {
  const db = openDb(dbPath);
  const fullRec: ConsultRecord = {
    id: rec.id || randomUUID(),
    created_at: rec.created_at || new Date().toISOString(),
    session: rec.session,
    question: rec.question,
    answer: rec.answer ?? null,
    model: rec.model ?? null,
    thinking: rec.thinking ?? null,
    conversation_url: rec.conversation_url ?? null,
    duration_ms: rec.duration_ms ?? null,
    status: rec.status,
    error: rec.error ?? null,
    metadata: rec.metadata ?? null,
  };

  const stmt = db.prepare(`
    INSERT INTO consults (
      id, created_at, session, question, answer, model, thinking,
      conversation_url, duration_ms, status, error, metadata
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    fullRec.id,
    fullRec.created_at,
    fullRec.session,
    fullRec.question,
    fullRec.answer,
    fullRec.model,
    fullRec.thinking,
    fullRec.conversation_url,
    fullRec.duration_ms,
    fullRec.status,
    fullRec.error,
    fullRec.metadata
  );

  return fullRec;
}

export function listConsults(opts?: ListConsultsOptions, dbPath?: string): ConsultRecord[] {
  const db = openDb(dbPath);
  const conditions: string[] = [];
  const params: any[] = [];

  if (opts?.session) {
    conditions.push("session = ?");
    params.push(opts.session);
  }

  if (opts?.search) {
    conditions.push("(question LIKE ? OR answer LIKE ?)");
    const pattern = `%${opts.search}%`;
    params.push(pattern, pattern);
  }

  if (opts?.since) {
    conditions.push("created_at >= ?");
    let sinceVal = opts.since;
    if (/^\d{4}-\d{2}-\d{2}$/.test(sinceVal)) {
      sinceVal = `${sinceVal}T00:00:00.000Z`;
    }
    params.push(sinceVal);
  }

  let whereClause = "";
  if (conditions.length > 0) {
    whereClause = "WHERE " + conditions.join(" AND ");
  }

  const limit = opts?.limit ?? 50;
  const sql = `SELECT * FROM consults ${whereClause} ORDER BY created_at DESC LIMIT ?`;
  params.push(limit);

  const stmt = db.prepare(sql);
  const rows = stmt.all(...params) as ConsultRecord[];
  return rows;
}

export function getConsult(id: string, dbPath?: string): ConsultRecord | null {
  const db = openDb(dbPath);
  const stmt = db.prepare("SELECT * FROM consults WHERE id = ? OR id LIKE ? LIMIT 1");
  const row = stmt.get(id, `${id}%`) as ConsultRecord | undefined;
  return row || null;
}

export function lastConsultForSession(session: string, dbPath?: string): ConsultRecord | null {
  const db = openDb(dbPath);
  const stmt = db.prepare("SELECT * FROM consults WHERE session = ? ORDER BY created_at DESC LIMIT 1");
  const row = stmt.get(session) as ConsultRecord | undefined;
  return row || null;
}

export function consultStats(dbPath?: string): ConsultStats {
  const db = openDb(dbPath);
  const rows = db.prepare("SELECT * FROM consults").all() as ConsultRecord[];

  const total = rows.length;
  if (total === 0) {
    return {
      total: 0,
      successCount: 0,
      successRatePercent: 0,
      medianDurationMs: null,
      slowestDurationMs: null,
      sessionCounts: {},
    };
  }

  let successCount = 0;
  const durations: number[] = [];
  const sessionCounts: Record<string, number> = {};

  for (const r of rows) {
    sessionCounts[r.session] = (sessionCounts[r.session] || 0) + 1;
    if (r.status === "ok") {
      successCount++;
      if (typeof r.duration_ms === "number" && r.duration_ms >= 0) {
        durations.push(r.duration_ms);
      }
    }
  }

  durations.sort((a, b) => a - b);
  let medianDurationMs: number | null = null;
  let slowestDurationMs: number | null = null;

  if (durations.length > 0) {
    slowestDurationMs = durations[durations.length - 1] ?? null;
    const mid = Math.floor(durations.length / 2);
    if (durations.length % 2 === 1) {
      medianDurationMs = durations[mid] ?? null;
    } else {
      const d1 = durations[mid - 1];
      const d2 = durations[mid];
      if (d1 !== undefined && d2 !== undefined) {
        medianDurationMs = Math.round((d1 + d2) / 2);
      }
    }
  }

  const successRatePercent = Math.round((successCount / total) * 1000) / 10;

  return {
    total,
    successCount,
    successRatePercent,
    medianDurationMs,
    slowestDurationMs,
    sessionCounts,
  };
}
