import { describe, it, expect } from "vitest";
import { findDualUrlSessions, findSharedUrls } from "../../src/web/cv-retire.js";
import type { ConsultRecord } from "../../src/web/qwen-db.js";

const rec = (o: Partial<ConsultRecord>): ConsultRecord =>
  ({
    id: o.id ?? Math.random().toString(36).slice(2),
    created_at: o.created_at ?? "2026-08-05T10:00:00Z",
    session: o.session ?? "cv-a",
    question: o.question ?? "q",
    answer: o.answer ?? "a",
    model: null,
    thinking: null,
    conversation_url: o.conversation_url ?? null,
    duration_ms: 1,
    status: (o.status ?? "ok") as ConsultRecord["status"],
    error: null,
    metadata: o.metadata ?? null,
  }) as ConsultRecord;

const RETIRED = JSON.stringify({ retired: true });

describe("cv-retire: keys whose isolation is no longer provable", () => {
  it("flags a key that accumulated two conversation URLs", () => {
    const found = findDualUrlSessions([
      rec({ session: "cv-a", conversation_url: "u1" }),
      rec({ session: "cv-a", conversation_url: "u2" }),
      rec({ session: "cv-b", conversation_url: "u3" }),
    ]);
    expect(found.map((f) => f.session)).toEqual(["cv-a"]);
  });

  it("stops flagging a key once retired — the archive keeps history, the audit judges health", () => {
    // Without the time line the audit could never go green again, and an alarm
    // that never clears is an alarm people learn to ignore.
    const found = findDualUrlSessions([
      rec({ session: "cv-a", conversation_url: "u1", created_at: "2026-08-01T00:00:00Z" }),
      rec({ session: "cv-a", conversation_url: "u2", created_at: "2026-08-02T00:00:00Z" }),
      rec({ session: "cv-a", created_at: "2026-08-03T00:00:00Z", metadata: RETIRED }),
      rec({ session: "cv-a", conversation_url: "u3", created_at: "2026-08-04T00:00:00Z" }),
    ]);
    expect(found).toEqual([]);
  });

  it("flags again if the key drifts a second time after retirement", () => {
    const found = findDualUrlSessions([
      rec({ session: "cv-a", conversation_url: "u1", created_at: "2026-08-01T00:00:00Z" }),
      rec({ session: "cv-a", created_at: "2026-08-02T00:00:00Z", metadata: RETIRED }),
      rec({ session: "cv-a", conversation_url: "u3", created_at: "2026-08-03T00:00:00Z" }),
      rec({ session: "cv-a", conversation_url: "u4", created_at: "2026-08-04T00:00:00Z" }),
    ]);
    expect(found.map((f) => f.session)).toEqual(["cv-a"]);
  });

  it("detects the unforgivable case: one conversation used by two different people", () => {
    const shared = findSharedUrls([
      rec({ session: "cv-a", conversation_url: "same" }),
      rec({ session: "cv-b", conversation_url: "same" }),
    ]);
    expect(shared).toHaveLength(1);
    expect(shared[0]!.sessions.sort()).toEqual(["cv-a", "cv-b"]);
  });

  it("is quiet when every key sits on exactly one conversation", () => {
    expect(
      findDualUrlSessions([
        rec({ session: "cv-a", conversation_url: "u1" }),
        rec({ session: "cv-a", conversation_url: "u1" }),
        rec({ session: "cv-b", conversation_url: "u2" }),
      ]),
    ).toEqual([]);
    expect(findSharedUrls([rec({ session: "cv-a", conversation_url: "u1" })])).toEqual([]);
  });
});
