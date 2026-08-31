import { describe, it, expect } from "vitest";
import { selectSessionsToClose, type WebSessionRecord } from "../../src/web/state.js";

describe("selectSessionsToClose unit tests", () => {
  const now = Date.parse("2026-08-05T12:00:00.000Z");

  it("respects keep parameter and preserves most recently used sessions", () => {
    const sessions: Record<string, WebSessionRecord> = {
      s1: { targetId: "t1", readOnly: false, createdAt: "2026-08-05T11:55:00.000Z", lastUsedAt: "2026-08-05T11:55:00.000Z" }, // 5 min ago
      s2: { targetId: "t2", readOnly: false, createdAt: "2026-08-05T10:00:00.000Z", lastUsedAt: "2026-08-05T10:00:00.000Z" }, // 120 min ago
      s3: { targetId: "t3", readOnly: false, createdAt: "2026-08-05T09:00:00.000Z", lastUsedAt: "2026-08-05T09:00:00.000Z" }, // 180 min ago
      s4: { targetId: "t4", readOnly: false, createdAt: "2026-08-05T08:00:00.000Z", lastUsedAt: "2026-08-05T08:00:00.000Z" }, // 240 min ago
    };

    // keep: 2, maxAgeMin: 60 -> top 2 (s1, s2) preserved. Remaining (s3, s4) > 60 min -> selected.
    const selected = selectSessionsToClose(sessions, { keep: 2, maxAgeMin: 60, now });
    expect(selected).toEqual(["s3", "s4"]);
  });

  it("respects maxAgeMin parameter", () => {
    const sessions: Record<string, WebSessionRecord> = {
      recent: { targetId: "t1", readOnly: false, createdAt: "2026-08-05T11:30:00.000Z", lastUsedAt: "2026-08-05T11:30:00.000Z" }, // 30 min ago
      old: { targetId: "t2", readOnly: false, createdAt: "2026-08-05T10:00:00.000Z", lastUsedAt: "2026-08-05T10:00:00.000Z" }, // 120 min ago
    };

    const selected = selectSessionsToClose(sessions, { keep: 0, maxAgeMin: 60, now });
    expect(selected).toEqual(["old"]);
  });

  it("never selects excluded/current session", () => {
    const sessions: Record<string, WebSessionRecord> = {
      active: { targetId: "t1", readOnly: false, createdAt: "2026-08-05T08:00:00.000Z", lastUsedAt: "2026-08-05T08:00:00.000Z" },
      old: { targetId: "t2", readOnly: false, createdAt: "2026-08-05T08:00:00.000Z", lastUsedAt: "2026-08-05T08:00:00.000Z" },
    };

    const selected = selectSessionsToClose(sessions, { keep: 0, maxAgeMin: 60, now, exclude: ["active"] });
    expect(selected).toEqual(["old"]);
  });

  it("never selects a handed-over session", () => {
    const sessions: Record<string, WebSessionRecord> = {
      userTab: { targetId: "t1", readOnly: false, createdAt: "2026-08-05T08:00:00.000Z", lastUsedAt: "2026-08-05T08:00:00.000Z", handedOver: true },
      agentTab: { targetId: "t2", readOnly: false, createdAt: "2026-08-05T08:00:00.000Z", lastUsedAt: "2026-08-05T08:00:00.000Z" },
    };

    const selected = selectSessionsToClose(sessions, { keep: 0, maxAgeMin: 60, now });
    expect(selected).toEqual(["agentTab"]);
  });
});
