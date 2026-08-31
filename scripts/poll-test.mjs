// Scratch experiment: can we read agy's conversation store DURING a live run?
// Usage: node poll-test.mjs <conversationId> [readOnly|rw|copy]
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const conv = process.argv[2];
const mode = process.argv[3] ?? "readOnly";
const dir = path.join(os.homedir(), ".gemini", "antigravity-cli", "conversations");
const dbPath = path.join(dir, conv + ".db");

try {
  if (!fs.existsSync(dbPath)) {
    console.log(`${mode}: db-not-yet`);
    process.exit(0);
  }
  let target = dbPath;
  if (mode === "copy") {
    const snap = path.join(os.tmpdir(), `snap-${conv}.db`);
    fs.copyFileSync(dbPath, snap);
    for (const ext of ["-wal", "-shm"]) {
      try { fs.copyFileSync(dbPath + ext, snap + ext); } catch {}
    }
    target = snap;
  }
  const db = new DatabaseSync(target, mode === "readOnly" ? { readOnly: true } : {});
  const r = db.prepare("SELECT COUNT(*) c, MAX(idx) m FROM steps").get();
  console.log(`${mode}: steps=${r.c} maxIdx=${r.m}`);
  db.close();
} catch (e) {
  console.log(`${mode}: ERR ${String(e.message).slice(0, 80)}`);
}
