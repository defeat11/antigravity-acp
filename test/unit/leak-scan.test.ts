import { describe, it, expect } from "vitest";
import { documentStarts, scanQuestion, scanRecords, summarize, redactionKinds } from "../../src/web/leak-scan.js";
import type { ConsultRecord } from "../../src/web/qwen-db.js";

const rec = (o: Partial<ConsultRecord>): ConsultRecord =>
  ({
    id: o.id ?? "id",
    created_at: o.created_at ?? "2026-08-01T10:00:00Z",
    session: o.session ?? "vip-x",
    question: o.question ?? "",
    answer: "a",
    model: null,
    thinking: null,
    conversation_url: null,
    duration_ms: 1,
    status: "ok",
    error: null,
    metadata: o.metadata ?? null,
  }) as ConsultRecord;

const meta = (kinds: string[]) =>
  JSON.stringify({ redactions: kinds.map((k, i) => ({ kind: k, placeholder: `[${k.toUpperCase()}_${i + 1}]` })) });

describe("leak-scan: where a wrapped document begins", () => {
  it("always considers the top of the text", () => {
    expect(documentStarts("سطر واحد")).toEqual([0]);
  });

  it("finds the separators the CV services actually used", () => {
    const text = ["تعليمات", "", "--- السيرة ---", "# LAYLA ABDULLATIF"].join("\n");
    // Two extra starts: the separator line and the markdown heading.
    expect(documentStarts(text).length).toBeGreaterThanOrEqual(3);
  });
});

describe("leak-scan: what actually went out", () => {
  it("catches a name that survived because the CV was wrapped", () => {
    // The exact shape from production: instructions first, CV below, phone and
    // e-mail masked, the name untouched.
    const sent = [
      "الدور المستهدف: مطور",
      "حلّل السيرة أدناه واذكر أهم ثلاث فجوات.",
      "",
      "--- السيرة ---",
      "# LAYLA ABDULLATIF",
      "Power Platform Developer",
      "Riyadh | [PHONE_1] | [EMAIL_1]",
      "## Work Experience",
      "--- نهاية السيرة ---",
    ].join("\n");
    const scan = scanQuestion(sent);
    expect(scan.names).toContain("LAYLA ABDULLATIF");
    expect(scan.carriesCv).toBe(true);
    expect(scan.hasNamePlaceholder).toBe(false);
  });

  it("reports nothing when the name was properly redacted", () => {
    const sent = [
      "الدور المستهدف: مطور",
      "--- السيرة ---",
      "# [NAME_1]",
      "Riyadh | [PHONE_1] | [EMAIL_1]",
      "## Work Experience",
    ].join("\n");
    const scan = scanQuestion(sent);
    expect(scan.names).toEqual([]);
    expect(scan.hasNamePlaceholder).toBe(true);
  });

  it("does not invent a name out of a section heading", () => {
    const sent = ["--- السيرة ---", "# Professional Summary", "## Work Experience"].join("\n");
    expect(scanQuestion(sent).names).toEqual([]);
  });

  it("ignores an ordinary question that carries no CV", () => {
    const scan = scanQuestion("ما أفضل طريقة لفهرسة جدول كبير؟");
    expect(scan.names).toEqual([]);
    expect(scan.carriesCv).toBe(false);
  });
});

describe("leak-scan: classifying records", () => {
  it("marks a recoverable name as confirmed", () => {
    const found = scanRecords([
      rec({
        id: "r1",
        session: "vip-cand-88",
        question: "--- السيرة ---\n# SAMI ALOTAIBI\n## Education\n[PHONE_1]",
        metadata: meta(["phone"]),
      }),
    ]);
    expect(found).toHaveLength(1);
    expect(found[0]!.level).toBe("confirmed");
    expect(found[0]!.names).toContain("SAMI ALOTAIBI");
  });

  it("marks a CV with every identifier masked EXCEPT a name as suspect", () => {
    // A CV that redacted a phone and a handle but never a name did not simply
    // lack one — CVs have names. The text no longer proves which, so it is
    // reported as suspect rather than quietly passed.
    const found = scanRecords([
      rec({
        id: "r2",
        session: "cv-abc",
        question: "--- السيرة ---\nProfessional Summary\n[PHONE_1] [HANDLE_1]\n## Skills",
        metadata: meta(["phone", "handle"]),
      }),
    ]);
    expect(found).toHaveLength(1);
    expect(found[0]!.level).toBe("suspect");
  });

  it("clears a CV whose name redaction fired", () => {
    expect(
      scanRecords([
        rec({
          question: "--- السيرة ---\n# [NAME_1]\n[PHONE_1]\n## Skills",
          metadata: meta(["name", "phone"]),
        }),
      ]),
    ).toEqual([]);
  });

  it("does not flag a question that never carried a CV", () => {
    expect(
      scanRecords([rec({ question: "سؤال عام بلا سيرة", metadata: meta(["phone"]) })]),
    ).toEqual([]);
  });
});

describe("leak-scan: the report", () => {
  it("counts both levels and names the sessions involved", () => {
    const s = summarize([
      // The contact line belongs in the fixture: a name is only reported when it
      // sits where a CV puts one, so a header without contacts is not the shape
      // being audited.
      rec({ id: "a", session: "vip-1", question: "--- السيرة ---\n# ALI HASSAN\nRiyadh | [PHONE_1]\n## Skills", metadata: meta(["phone"]) }),
      rec({ id: "b", session: "cv-2", question: "--- السيرة ---\nProfessional Summary\n[EMAIL_1]\n## Education", metadata: meta(["email"]) }),
      rec({ id: "c", session: "task-3", question: "سؤال عادي" }),
    ]);
    expect(s.scanned).toBe(3);
    expect(s.confirmed).toBe(1);
    expect(s.suspect).toBe(1);
    expect(s.sessions).toEqual(["cv-2", "vip-1"]);
  });

  it("reads redaction kinds and survives broken metadata", () => {
    expect(redactionKinds(rec({ metadata: meta(["name", "phone", "phone"]) }))).toEqual(["name", "phone"]);
    expect(redactionKinds(rec({ metadata: "{not json" }))).toEqual([]);
    expect(redactionKinds(rec({ metadata: null }))).toEqual([]);
  });
});

describe("leak-scan: corroboration keeps the report honest", () => {
  it("ignores section headings that merely look like names", () => {
    // The first inventory reported twenty findings, eighteen of them headings
    // and instruction lines. A report that noisy hides the two that matter.
    const sent = [
      "--- السيرة ---",
      "# [NAME_1]",
      "[PHONE_1] | [EMAIL_1]",
      "## KEY ACHIEVEMENTS",
      "- بنى نظاماً",
      "## Professional Experience",
      "- عمل في شركة",
    ].join("\n");
    expect(scanQuestion(sent).names).toEqual([]);
  });

  it("still catches the name sitting above the contact line", () => {
    const sent = [
      "حلّل السيرة أدناه.",
      "لا تخترع إنجازات غير موجودة",
      "",
      "--- السيرة ---",
      "# LAYLA ABDULLATIF",
      "Power Platform Developer",
      "Riyadh | [PHONE_1] | [EMAIL_1]",
      "## Work Experience",
    ].join("\n");
    const names = scanQuestion(sent).names;
    expect(names).toContain("LAYLA ABDULLATIF");
    // The instruction line is not a person, however Arabic and short it is.
    expect(names).not.toContain("لا تخترع إنجازات غير موجودة");
  });

  it("requires the contact to be NEAR the name, not anywhere in the document", () => {
    const far = ["--- السيرة ---", "# SAMI ALOTAIBI", ...Array(8).fill("- سطر"), "[PHONE_1]", "## Skills"].join("\n");
    expect(scanQuestion(far).names).toEqual([]);
  });
});

describe("leak-scan: a header the generator already anonymised", () => {
  it("clears a CV whose name was replaced by an id upstream", () => {
    // Six real consultations matched the leak's shape exactly — everything else
    // masked, no name placeholder — and the stored text settled it: the CV
    // generator writes "# USER_ID_..." where the name goes, so there was nothing
    // to redact. Flagging them forever would train everyone to ignore this audit.
    const found = scanRecords([
      rec({
        session: "cv-real",
        question: "--- السيرة ---\n# USER_ID_5352982656\nRiyadh | [PHONE_1] | [EMAIL_1]\n## Professional Summary",
        metadata: meta(["phone", "email"]),
      }),
    ]);
    expect(found).toEqual([]);
  });

  it("still flags a CV with a plain header and no name redaction", () => {
    const found = scanRecords([
      rec({
        session: "cv-other",
        question: "--- السيرة ---\nملف المرشح\n[PHONE_1]\n## المهارات",
        metadata: meta(["phone"]),
      }),
    ]);
    expect(found.map((f) => f.level)).toEqual(["suspect"]);
  });
});

describe("leak-scan: an anonymised id that was itself redacted", () => {
  it("clears a header like USER_ID_[PHONE_2]", () => {
    // A ten-digit user id has the shape of a phone number, so redaction replaced
    // it — and the anonymised-header rule, which looked for a literal digit,
    // stopped matching. Three clean consultations stayed flagged because of it.
    expect(
      scanRecords([
        rec({
          question: "--- السيرة ---\n# USER_ID_[PHONE_2]\nRiyadh | [PHONE_1] | [EMAIL_1]\n## Skills",
          metadata: meta(["phone", "email"]),
        }),
      ]),
    ).toEqual([]);
  });
});
