import { describe, it, expect } from "vitest";
import {
  buildEvaluationPrompt,
  parseEvaluation,
  comparabilityKey,
  SENTINEL,
  DEFAULT_CRITERIA,
} from "../../src/web/cv-rubric.js";
import {
  decideRotation,
  buildRehydrationBrief,
  MAX_EXCHANGES_PER_CONVERSATION,
} from "../../src/web/cv-archive.js";
import type { ConsultRecord } from "../../src/web/qwen-db.js";

const rec = (o: Partial<ConsultRecord>): ConsultRecord =>
  ({
    id: o.id ?? "id",
    created_at: o.created_at ?? "2026-08-05T00:00:00Z",
    session: o.session ?? "cv-x",
    question: o.question ?? "س",
    answer: o.answer ?? "ج",
    model: null,
    thinking: null,
    conversation_url: null,
    duration_ms: 1,
    status: (o.status ?? "ok") as ConsultRecord["status"],
    error: null,
    metadata: null,
    ...o,
  }) as ConsultRecord;

describe("cv-rubric: prompt", () => {
  it("states that redaction placeholders are intentional", () => {
    const p = buildEvaluationPrompt({ cvText: "خبرة 5 سنوات" });
    // Without this line the model deducts marks for "missing contact details" —
    // a bias applied to every candidate and therefore invisible in the results.
    expect(p).toContain("حُجبت عمداً");
    expect(p).toContain("لا تخصم أي درجة بسببها");
  });

  it("demands a verbatim quote per judgement and ends with the sentinel", () => {
    const p = buildEvaluationPrompt({ cvText: "نص", criteria: ["أ", "ب"] });
    expect(p).toContain("الدليل:");
    expect(p).toContain("اقتباس حرفي");
    expect(p.trim().includes(SENTINEL)).toBe(true);
    expect(p).toContain("### معيار 1: أ");
    expect(p).toContain("### معيار 2: ب");
  });
});

describe("cv-rubric: parsing", () => {
  const good = `### معيار 1: أ
الدرجة: 4
الدليل: «خبرة 5 سنوات في Node.js»
التعليل: مطابق للدور

### معيار 2: ب
الدرجة: 3
الدليل: «قاد فريقاً من 3»
التعليل: قيادة محدودة

### نقاط القوة
- خبرة عملية «5 سنوات»

### الفجوات
- لا خبرة سحابية

### الدرجة الكلية
3.5

### درجة الثقة
عالية — الأدلة واضحة

${SENTINEL}`;

  it("reads scores, evidence, overall and confidence from a complete answer", () => {
    const r = parseEvaluation(good, ["أ", "ب"]);
    expect(r.complete).toBe(true);
    expect(r.missing).toEqual([]);
    expect(r.scores.map((s) => s.score)).toEqual([4, 3]);
    expect(r.scores[0]!.evidence).toContain("Node.js");
    expect(r.overall).toBe(3.5);
    expect(r.confidence).toContain("عالية");
  });

  it("flags a truncated answer instead of accepting it", () => {
    const truncated = good.replace(SENTINEL, "").replace("### درجة الثقة\nعالية — الأدلة واضحة", "");
    const r = parseEvaluation(truncated, ["أ", "ب"]);
    expect(r.complete).toBe(false);
    expect(r.missing).toContain("سطر الخاتمة");
    expect(r.missing).toContain("درجة الثقة");
  });

  it("reports a judgement that arrived without its evidence quote", () => {
    const noQuote = good.replace("الدليل: «خبرة 5 سنوات في Node.js»", "الدليل: جيد جداً");
    const r = parseEvaluation(noQuote, ["أ", "ب"]);
    expect(r.missing).toContain("دليل معيار 1");
  });

  it("uses the default criteria when none are given", () => {
    const r = parseEvaluation("", undefined);
    expect(r.scores).toHaveLength(DEFAULT_CRITERIA.length);
  });
});

describe("cv-rubric: comparability", () => {
  it("treats different model or thinking mode as not comparable", () => {
    expect(comparabilityKey("Qwen3.8-Max", "Fast")).toBe(comparabilityKey("Qwen3.8-Max", "Fast"));
    expect(comparabilityKey("Qwen3.8-Max", "Fast")).not.toBe(
      comparabilityKey("Qwen3.7-Plus", "Fast"),
    );
    expect(comparabilityKey("Qwen3.8-Max", "Fast")).not.toBe(
      comparabilityKey("Qwen3.8-Max", "Thinking"),
    );
  });
});

describe("cv-archive: rotation", () => {
  it("keeps a healthy conversation — its accumulated context is the asset", () => {
    const d = decideRotation({ identityOk: true, keyChanged: false, exchanges: 3, currentGeneration: 1 });
    expect(d.rotate).toBe(false);
    expect(d.generation).toBe(1);
  });

  it("rotates on a failed identity check and bumps the generation", () => {
    const d = decideRotation({ identityOk: false, keyChanged: false, exchanges: 3, currentGeneration: 2 });
    expect(d).toEqual({ rotate: true, reason: "identity-failed", generation: 3 });
  });

  it("rotates at the exchange limit", () => {
    const d = decideRotation({
      identityOk: true,
      keyChanged: false,
      exchanges: MAX_EXCHANGES_PER_CONVERSATION,
      currentGeneration: 1,
    });
    expect(d.reason).toBe("exchange-limit");
  });

  it("a key change starts a fresh file at generation 1", () => {
    const d = decideRotation({ identityOk: true, keyChanged: true, exchanges: 40, currentGeneration: 5 });
    expect(d).toEqual({ rotate: true, reason: "key-change", generation: 1 });
  });
});

describe("cv-archive: rehydration", () => {
  it("carries only successful exchanges, oldest first", () => {
    const brief = buildRehydrationBrief([
      rec({ question: "س3", answer: "ج3" }),
      rec({ question: "س2", answer: null, status: "timeout" }),
      rec({ question: "س1", answer: "ج1" }),
    ]);
    expect(brief).toContain("س1");
    expect(brief).toContain("س3");
    expect(brief).not.toContain("س2");
    expect(brief.indexOf("س1")).toBeLessThan(brief.indexOf("س3"));
  });

  it("strips our protocol scaffolding out of the brief", () => {
    const brief = buildRehydrationBrief([
      rec({ question: "ACP-LOCK: abcdef1234567890 [Q-2-ab12] ابدأ جوابك بترديد الوسم\n\nما مهارتك؟", answer: "Go" }),
    ]);
    expect(brief).not.toContain("ACP-LOCK");
    expect(brief).not.toContain("[Q-2-ab12]");
    expect(brief).toContain("ما مهارتك؟");
  });

  it("returns nothing when there is no usable history", () => {
    expect(buildRehydrationBrief([])).toBe("");
    expect(buildRehydrationBrief([rec({ status: "site_error", answer: null })])).toBe("");
  });
});
