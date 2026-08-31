import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { recordRun } from "../../src/ledger.js";

const nodeRequire = createRequire(import.meta.url);

describe("recordRun sqlite ledger", () => {
  it("records run stats in temporary db successfully", () => {
    const dir = mkdtempSync(join(tmpdir(), "acp-ledger-test-"));
    const tmpDbPath = join(dir, "ledger.db");
    try {
      const info1 = {
        project: "test-project",
        task: "do something",
        status: "ok",
        verifyCmd: "npm run test",
        verifyOk: true,
        verifyAttempts: 1,
        exitCode: 0,
        filesChanged: 3,
        elapsedSec: 12.5,
        model: "gemini-3.6-flash-high",
        account: "main-account",
        lessonsInjected: 5,
        mapInjected: 3,
      };

      recordRun(info1, tmpDbPath);

      // Verify row exists and matches
      let DatabaseSync: typeof import("node:sqlite").DatabaseSync;
      ({ DatabaseSync } = nodeRequire("node:sqlite") as typeof import("node:sqlite"));
      const db = new DatabaseSync(tmpDbPath, { readOnly: true });
      try {
        const rows = db.prepare("SELECT * FROM runs").all() as any[];
        expect(rows.length).toBe(1);
        expect(rows[0].project).toBe("test-project");
        expect(rows[0].task).toBe("do something");
        expect(rows[0].status).toBe("ok");
        expect(rows[0].verify_cmd).toBe("npm run test");
        expect(rows[0].verify_ok).toBe(1);
        expect(rows[0].verify_attempts).toBe(1);
        expect(rows[0].exit_code).toBe(0);
        expect(rows[0].files_changed).toBe(3);
        expect(rows[0].elapsed_sec).toBe(12.5);
        expect(rows[0].model).toBe("gemini-3.6-flash-high");
        expect(rows[0].account).toBe("main-account");
        expect(rows[0].lessons_injected).toBe(5);
        expect(rows[0].map_injected).toBe(3);
        expect(rows[0].ts).toBeTypeOf("string");
      } finally {
        db.close();
      }

      // Record second run
      const info2 = {
        project: "test-project",
        task: "do another thing",
        status: "failed",
        verifyCmd: "npm run test",
        verifyOk: false,
        verifyAttempts: 2,
        exitCode: 1,
        filesChanged: 5,
        elapsedSec: 25.0,
        model: "gemini-3.6-flash-high",
        account: "main-account",
      };

      recordRun(info2, tmpDbPath);

      const db2 = new DatabaseSync(tmpDbPath, { readOnly: true });
      try {
        const rows = db2.prepare("SELECT * FROM runs ORDER BY id").all() as any[];
        expect(rows.length).toBe(2);
        expect(rows[1].task).toBe("do another thing");
        expect(rows[1].status).toBe("failed");
        expect(rows[1].verify_ok).toBe(0);
        expect(rows[1].verify_attempts).toBe(2);
        expect(rows[1].exit_code).toBe(1);
        expect(rows[1].files_changed).toBe(5);
        expect(rows[1].elapsed_sec).toBe(25.0);
      } finally {
        db2.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
