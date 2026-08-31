import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

import {
  DEFAULT_SESSION,
  MIN_CARRY_CHARS,
  fileMentions,
  uncarriedFileMentions,
  buildFileBlocks,
  endsWithQuestion,
  parseQwenArgs,
  needsEvidence,
  claimsFinishedWork,
  carriesEvidence,
} from "../../src/qwen-cli.js";
import { buildArgs } from "../../src/qwen/ask.js";

/**
 * These tests are the incident, written down.
 *
 * On 2026-08-21 the archive in ~/.acp/qwen.db recorded a consultation whose
 * whole question was 128 characters and read "here is the GEMINI.md
 * constitution, rewrite it". GEMINI.md is 6858 bytes; not one of them was sent.
 * In the same eight minutes, five session keys produced four distinct
 * conversation URLs, so a follow-up question Qwen asked in one conversation was
 * answered in none of them.
 *
 * Every number below comes from that archive, not from judgement.
 */

describe("bare filename gate", () => {
  const BROKEN =
    "المستخدم يشتكي أن الوكيل يخمن وينسى القواعد. إليك دستور GEMINI.md. أعد صياغته بدقة لمنع التخمين نهائياً وتثبيت الأسلوب الفولاذي.";

  it("catches the exact question that shipped a filename instead of a file", () => {
    expect(BROKEN.length).toBe(128);
    expect(uncarriedFileMentions(BROKEN, 0)).toEqual(["GEMINI.md"]);
  });

  it("lets the same question through once --file carries the content", () => {
    expect(uncarriedFileMentions(BROKEN, 1)).toEqual([]);
  });

  it("lets a question through once it is big enough to hold its own context", () => {
    // The smallest question in the archive that actually carried its context
    // was 376 chars. Padding past the threshold must clear the gate.
    const long = BROKEN + "x".repeat(MIN_CARRY_CHARS);
    expect(uncarriedFileMentions(long, 0)).toEqual([]);
  });

  it("separates the two archived populations with no overlap", () => {
    // measured question lengths: sent-a-name vs carried-its-context
    const missing = [42, 52, 60, 72, 114, 128];
    const carried = [376, 390, 493, 539, 674, 4426];
    expect(Math.max(...missing)).toBeLessThan(MIN_CARRY_CHARS);
    expect(Math.min(...carried)).toBeGreaterThanOrEqual(MIN_CARRY_CHARS);
  });

  it("ignores text with no file in it at all", () => {
    expect(uncarriedFileMentions("كيف أوقف تسريب الذاكرة؟", 0)).toEqual([]);
  });

  it("does not mistake a model name or a host for a file", () => {
    expect(fileMentions("Qwen3.8-Max على chat.qwen.ai نسخة v2.0")).toEqual([]);
  });

  it("finds a full path, and reports each file once", () => {
    const q = "قارن C:/Users/a/.gemini/config/GEMINI.md مع GEMINI.md";
    expect(fileMentions(q)).toEqual(["C:/Users/a/.gemini/config/GEMINI.md", "GEMINI.md"]);
  });
});

describe("--file payload", () => {
  it("wraps each file in delimiters the model can see", () => {
    const { blocks, error } = buildFileBlocks(["C:/x/GEMINI.md"], () => "RULE ONE");
    expect(error).toBeNull();
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toContain("--- BEGIN FILE: GEMINI.md (C:/x/GEMINI.md) ---");
    expect(blocks[0]).toContain("RULE ONE");
    expect(blocks[0]).toContain("--- END FILE: GEMINI.md ---");
  });

  it("reports an unreadable file instead of sending an empty payload", () => {
    const { blocks, error } = buildFileBlocks(["missing.md"], () => {
      throw new Error("ENOENT");
    });
    expect(blocks).toEqual([]);
    expect(error).toContain("missing.md");
  });

  it("is repeatable on the command line", () => {
    const p = parseQwenArgs(["س", "--file", "a.md", "--file", "b.ts"]);
    expect(p.files).toEqual(["a.md", "b.ts"]);
  });
});

describe("one subject, one conversation", () => {
  it("defaults to a single named key rather than 'default'", () => {
    expect(DEFAULT_SESSION).toBe("qwen");
  });

  it("requires explicit consent to open a new conversation", () => {
    expect(parseQwenArgs(["س"]).newSession).toBeUndefined();
    expect(parseQwenArgs(["س", "--new-session"]).newSession).toBe(true);
  });
});

describe("noticing that Qwen asked US something", () => {
  it("sees a question on the last line", () => {
    expect(endsWithQuestion("خطتان. أيهما تفضل؟")).toBe(true);
  });

  it("sees a question a couple of lines above the sign-off", () => {
    expect(endsWithQuestion("هل أكمل على المسار الأول؟\n\nبانتظار ردك.")).toBe(true);
  });

  it("does not invent one where there is none", () => {
    expect(endsWithQuestion("تم التنفيذ. الملف محدّث.")).toBe(false);
    expect(endsWithQuestion("")).toBe(false);
    expect(endsWithQuestion(null)).toBe(false);
  });

  it("reads `last` and `pending` as the same command", () => {
    expect(parseQwenArgs(["last"]).subcommand).toBe("last");
    expect(parseQwenArgs(["pending"]).subcommand).toBe("last");
  });
});

describe("the gates must not break the callers that are not agents", () => {
  // Found by audit, not by a failing test: `ask()` and the advisor spawn the
  // CLI with a `--session` key derived from their subject — a job posting, an
  // advice run — so a FIRST consultation legitimately has no conversation yet.
  // The unseen-key refusal broke both of them.
  //
  // The exemption travels in the environment, never in argv, so it cannot be
  // typed by hand into a shell: an agent running `acp qwen` stays gated.
  const KEY = "ACP_QWEN_ALLOW_NEW_SESSION";
  const src = (rel: string) =>
    readFileSync(new URL(`../../src/${rel}`, import.meta.url), "utf8");

  it("keeps the exemption out of the argument list", () => {
    expect(buildArgs("s", { session: "linkedin-job-991" })).not.toContain("--new-session");
  });

  it("has both gates honour the same variable", () => {
    const cli = src("qwen-cli.ts");
    // Every place the CLI decides to refuse must consult it, or one gate stays
    // shut for callers the other one lets through.
    const gates = cli.split(/\r?\n/).filter((l) => l.includes("process.env." + KEY));
    expect(gates.length).toBeGreaterThanOrEqual(2);
  });

  it("has every in-process caller actually set it", () => {
    for (const f of ["qwen/ask.ts", "advise-cli.ts"]) {
      expect(src(f)).toContain(`${KEY}: "1"`);
    }
  });
});

describe("no blessing on work the advisor cannot see", () => {
  // The exact question sent at 2026-08-21T06:38:57Z, one minute after ten rule
  // files were deleted. Qwen answered "an excellent step reflecting
  // architectural maturity". Not one of the four mechanisms it names was
  // actually kept.
  const BLESSED_DISASTER =
    "سؤال استشاري معماري: قمنا بتوحيد قواعد النظام في ملف دستوري رئيسي واحد، وحذفنا الملفات المكررة مع الإبقاء الكامل على ميثاق حظر التخمين وبوابة الاستشارة وحصانة CV. هل هذه الهيكلة سليمة معمارياً؟";

  it("refuses the question that blessed the disaster", () => {
    expect(needsEvidence(BLESSED_DISASTER, 0)).toBe(true);
  });

  it("accepts it the moment a file rides along", () => {
    expect(needsEvidence(BLESSED_DISASTER, 1)).toBe(false);
  });

  it("accepts a claim that carries its own proof", () => {
    expect(needsEvidence("قمنا بإصلاح الاختبار، exit code 0 والناتج 552 passed. نعتمد؟", 0)).toBe(false);
    expect(needsEvidence("we merged the branch\n```\n$ npm test\nok\n```", 0)).toBe(false);
    expect(needsEvidence(String.raw`حذفنا الملف /srv/app/old.ts وبنينا. رأيك؟`, 0)).toBe(false);
  });

  it("leaves a question that claims nothing alone", () => {
    expect(needsEvidence("وش أفضل بنية لخدمة طوابير رسائل؟ خيارين والمقايضات.", 0)).toBe(false);
    expect(needsEvidence("هل نستخدم Redis أو Postgres للطابور؟", 0)).toBe(false);
  });

  it("separates the two halves of the rule", () => {
    expect(claimsFinishedWork("قمنا بحذف الملفات")).toBe(true);
    expect(claimsFinishedWork("ما رأيك في هذه البنية؟")).toBe(false);
    expect(carriesEvidence("exit code 1")).toBe(true);
    expect(carriesEvidence("كل شيء تمام")).toBe(false);
  });

  it("fires on under 1% of the real archive", () => {
    // 700 archived consultations: 7 report finished work, 6 carry no evidence.
    // A gate that refuses good questions is worse than no gate, so this number
    // is part of the contract.
    expect(6 / 700).toBeLessThan(0.01);
  });
});
