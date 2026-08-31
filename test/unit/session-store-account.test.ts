import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSession, recordTurn, resolveSessionForAccount } from "../../src/session-store.js";

describe("account-pinned sessions", () => {
  it("persists the account that owns the conversation", () => {
    const dir = mkdtempSync(join(tmpdir(), "acp-session-account-"));
    try {
      recordTurn(dir, "main", {
        conversationId: "conv-1",
        lastStepIdx: 3,
        model: "test",
        accountName: "second",
      }, new Date(0).toISOString());
      expect(getSession(dir, "main")?.accountName).toBe("second");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("never resumes a conversation owned by another account", () => {
    const dir = mkdtempSync(join(tmpdir(), "acp-session-mismatch-"));
    try {
      recordTurn(dir, "main", {
        conversationId: "main-conv",
        lastStepIdx: 1,
        model: "test",
        accountName: "main",
      }, new Date(0).toISOString());
      const binding = resolveSessionForAccount(dir, "main", "second");
      expect(binding.mismatch).toBe(true);
      expect(binding.name).toBe("main@second");
      expect(binding.session).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
