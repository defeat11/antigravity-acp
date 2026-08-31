import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  insertConsult,
  getConsult,
  listConsults,
  consultStats,
  lastConsultForSession,
} from "../../src/web/qwen-db.js";

describe("qwen-db SQLite operations", () => {
  let tmpDir: string;
  let testDbPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "acp-qwen-db-test-"));
    testDbPath = join(tmpDir, "test-qwen.db");
  });

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it("insertConsult and getConsult round-trip including null answer for timeout row", () => {
    const insertedOk = insertConsult(
      {
        session: "test-sess",
        question: "What is 2 + 2?",
        answer: "2 + 2 = 4",
        model: "Qwen3.8-Max",
        thinking: "Fast",
        conversation_url: "https://chat.qwen.ai/c/12345",
        duration_ms: 3500,
        status: "ok",
        error: null,
      },
      testDbPath
    );

    const fetchedOk = getConsult(insertedOk.id, testDbPath);
    expect(fetchedOk).not.toBeNull();
    expect(fetchedOk?.id).toBe(insertedOk.id);
    expect(fetchedOk?.question).toBe("What is 2 + 2?");
    expect(fetchedOk?.answer).toBe("2 + 2 = 4");
    expect(fetchedOk?.status).toBe("ok");

    const insertedTimeout = insertConsult(
      {
        session: "test-sess",
        question: "Complex math question",
        answer: null,
        status: "timeout",
        error: "wait timeout after 15000ms",
      },
      testDbPath
    );

    const fetchedTimeout = getConsult(insertedTimeout.id, testDbPath);
    expect(fetchedTimeout).not.toBeNull();
    expect(fetchedTimeout?.answer).toBeNull();
    expect(fetchedTimeout?.status).toBe("timeout");
    expect(fetchedTimeout?.error).toBe("wait timeout after 15000ms");
  });

  it("listConsults filters by session, search (question & answer), since, limit and newest-first order", () => {
    const now = Date.now();
    insertConsult(
      {
        id: "c1",
        created_at: new Date(now - 10000).toISOString(),
        session: "alpha",
        question: "How to fix a bug in Python?",
        answer: "Use a debugger or print statements.",
        status: "ok",
      },
      testDbPath
    );

    insertConsult(
      {
        id: "c2",
        created_at: new Date(now - 5000).toISOString(),
        session: "alpha",
        question: "What is Rust?",
        answer: "Rust is a systems programming language.",
        status: "ok",
      },
      testDbPath
    );

    insertConsult(
      {
        id: "c3",
        created_at: new Date(now).toISOString(),
        session: "beta",
        question: "Explain quantum mechanics",
        answer: "Quantum mechanics deals with atomic scale physics.",
        status: "ok",
      },
      testDbPath
    );

    // Filter by session
    const alphaRows = listConsults({ session: "alpha" }, testDbPath);
    expect(alphaRows.length).toBe(2);
    expect(alphaRows[0].id).toBe("c2"); // Newest first
    expect(alphaRows[1].id).toBe("c1");

    // Search question
    const searchQ = listConsults({ search: "quantum" }, testDbPath);
    expect(searchQ.length).toBe(1);
    expect(searchQ[0].id).toBe("c3");

    // Search answer
    const searchAns = listConsults({ search: "debugger" }, testDbPath);
    expect(searchAns.length).toBe(1);
    expect(searchAns[0].id).toBe("c1");

    // Limit
    const limited = listConsults({ limit: 1 }, testDbPath);
    expect(limited.length).toBe(1);
    expect(limited[0].id).toBe("c3");
  });

  it("consultStats computes total, success rate, median, slowest and per-session counts correctly", () => {
    insertConsult({ session: "s1", question: "q1", answer: "a1", duration_ms: 1000, status: "ok" }, testDbPath);
    insertConsult({ session: "s1", question: "q2", answer: "a2", duration_ms: 3000, status: "ok" }, testDbPath);
    insertConsult({ session: "s2", question: "q3", answer: "a3", duration_ms: 5000, status: "ok" }, testDbPath);
    insertConsult({ session: "s2", question: "q4", answer: null, duration_ms: 8000, status: "timeout" }, testDbPath);

    const stats = consultStats(testDbPath);
    expect(stats.total).toBe(4);
    expect(stats.successCount).toBe(3);
    expect(stats.successRatePercent).toBe(75);
    expect(stats.slowestDurationMs).toBe(5000); // max among status === 'ok'
    expect(stats.medianDurationMs).toBe(3000); // median of [1000, 3000, 5000]
    expect(stats.sessionCounts).toEqual({ s1: 2, s2: 2 });
  });

  it("handles SQL parameterisation safely when search contains quotes or %", () => {
    insertConsult(
      {
        session: "sec",
        question: "What is 100% of 'foo'?",
        answer: "It is 'foo' 100%",
        status: "ok",
      },
      testDbPath
    );

    const resSingleQuote = listConsults({ search: "'foo'" }, testDbPath);
    expect(resSingleQuote.length).toBe(1);

    const resPercent = listConsults({ search: "100%" }, testDbPath);
    expect(resPercent.length).toBe(1);
  });

  it("lastConsultForSession returns the newest consult for that session", () => {
    const now = Date.now();
    insertConsult(
      {
        session: "s1",
        created_at: new Date(now - 2000).toISOString(),
        question: "first",
        conversation_url: "https://chat.qwen.ai/c/url1",
        status: "ok",
      },
      testDbPath
    );

    insertConsult(
      {
        session: "s1",
        created_at: new Date(now).toISOString(),
        question: "second",
        conversation_url: "https://chat.qwen.ai/c/url2",
        status: "ok",
      },
      testDbPath
    );

    const last = lastConsultForSession("s1", testDbPath);
    expect(last).not.toBeNull();
    expect(last?.question).toBe("second");
    expect(last?.conversation_url).toBe("https://chat.qwen.ai/c/url2");
  });
});
