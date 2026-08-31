import { describe, it, expect } from "vitest";
import { buildArgs, parseRecord } from "../../src/qwen/ask.js";

describe("ask: what the child is told", () => {
  it("sends the question and asks for JSON", () => {
    expect(buildArgs("س")).toEqual(["س", "--json"]);
  });

  it("prefers --vip over --session, because the two cannot both hold", () => {
    // --vip derives its own isolated key; passing both would name two different
    // conversations for one call.
    const args = buildArgs("س", { vip: "cand-88", session: "other" });
    expect(args).toContain("--vip");
    expect(args).not.toContain("--session");
  });

  it("passes the mode, retries, timeout and freshness through", () => {
    const args = buildArgs("س", { mode: "Thinking", retries: 3, timeoutMs: 60000, fresh: true });
    expect(args.join(" ")).toContain("--mode Thinking");
    expect(args.join(" ")).toContain("--retries 3");
    expect(args.join(" ")).toContain("--timeout 60000");
    expect(args).toContain("--new");
  });

  it("joins extra redaction literals with commas", () => {
    expect(buildArgs("س", { redact: ["سامي", "المطيري"] }).join(" ")).toContain(
      "--redact سامي,المطيري",
    );
  });

  it("omits every flag that was not asked for", () => {
    expect(buildArgs("س", {})).toEqual(["س", "--json"]);
  });
});

describe("ask: reading the child's answer", () => {
  const record = (o: Record<string, unknown>) =>
    JSON.stringify({
      id: "1",
      created_at: "2026-08-05T20:00:00Z",
      session: "s",
      question: "q",
      answer: "42",
      model: "Qwen3.8-Max",
      thinking: "Fast",
      conversation_url: "https://chat.qwen.ai/c/abc",
      duration_ms: 3100,
      status: "ok",
      error: null,
      metadata: JSON.stringify({ phases: { fill: 210, send: 650, answer: 2200 }, redactions: [] }),
      ...o,
    });

  it("returns the answer with its timings and conversation", () => {
    const r = parseRecord(record({}), "", 0);
    expect(r.ok).toBe(true);
    expect(r.answer).toBe("42");
    expect(r.phases.send).toBe(650);
    expect(r.conversationUrl).toContain("/c/abc");
  });

  it("refuses to call an empty answer a success, whatever the status says", () => {
    // A reply that did not arrive is not a success; the CLI has reported ok
    // alongside empty text before, and that is precisely what this guards.
    expect(parseRecord(record({ answer: "" }), "", 0).ok).toBe(false);
  });

  it("carries a failure status and its reason", () => {
    const r = parseRecord(record({ status: "site_error", answer: "", error: "rate_limit" }), "", 4);
    expect(r.ok).toBe(false);
    expect(r.status).toBe("site_error");
    expect(r.error).toBe("rate_limit");
  });

  it("reports the placeholders that were removed, never the values", () => {
    const r = parseRecord(
      record({
        metadata: JSON.stringify({
          redactions: [{ kind: "name", placeholder: "[NAME_1]", original: "SHOULD NOT LEAK" }],
        }),
      }),
      "",
      0,
    );
    expect(JSON.stringify(r.redactions)).toContain("[NAME_1]");
  });

  it("takes the LAST json line, since warnings can precede it", () => {
    const r = parseRecord("note: retrying\n" + record({}), "", 0);
    expect(r.answer).toBe("42");
  });

  it("falls back to the child's stderr when there is no record at all", () => {
    const r = parseRecord("", "extension not connected", 4);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("extension not connected");
  });

  it("survives malformed json without throwing", () => {
    expect(parseRecord("{not json", "", 0).ok).toBe(false);
  });

  it("treats missing metadata as missing detail, not as failure", () => {
    const r = parseRecord(record({ metadata: "{broken" }), "", 0);
    expect(r.ok).toBe(true);
    expect(r.phases).toEqual({});
  });
});
