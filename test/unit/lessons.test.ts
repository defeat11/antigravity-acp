import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readLessonsPreamble, recordLesson, LESSONS_FILE_NAME } from "../../src/lessons.js";

describe("lessons learned feature", () => {
  it("manages lessons learned file (.acp-lessons.md) correctly", () => {
    const dir = mkdtempSync(join(tmpdir(), "acp-lessons-test-"));
    try {
      // 1) readLessonsPreamble returns "" when no file is present.
      expect(readLessonsPreamble(dir)).toBe("");

      // 2) recordLesson with status="ok", verify.ok=true, verifyAttempts=1 does not write anything.
      recordLesson(dir, {
        task: "successful task",
        status: "ok",
        verifyCmd: "npm test",
        verify: { ok: true, exitCode: 0 },
        verifyAttempts: 1,
      });
      expect(existsSync(join(dir, LESSONS_FILE_NAME))).toBe(false);

      // 3) recordLesson with verify.ok === false writes a warning line
      recordLesson(dir, {
        task: "failed task",
        status: "ok",
        verifyCmd: "npm test",
        verify: { ok: false, exitCode: 1 },
        verifyAttempts: 1,
      });
      expect(existsSync(join(dir, LESSONS_FILE_NAME))).toBe(true);
      const preamble = readLessonsPreamble(dir);
      expect(preamble).toContain("## دروس مستفادة من مهام سابقة في هذا المشروع");
      expect(preamble).toContain("تحذير: تحقق فشل نهائياً بعد 1 محاولة(محاولات) — الأمر: npm test (exit 1) — المهمة: \"failed task\"");

      // 4) recordLesson with verifyAttempts === 2 and verify.ok === true writes "أُصلح بعد إعادة محاولة واحدة"
      recordLesson(dir, {
        task: "recovered task",
        status: "ok",
        verifyCmd: "npm test",
        verify: { ok: true, exitCode: 0 },
        verifyAttempts: 2,
      });
      const preamble2 = readLessonsPreamble(dir);
      expect(preamble2).toContain("أُصلح بعد إعادة محاولة واحدة: تحقق \"npm test\" فشل أولاً ثم نجح — المهمة: \"recovered task\"");

      // 5) recordLesson with status !== "ok"
      recordLesson(dir, {
        task: "crashed task",
        status: "failed",
        verifyCmd: "npm test",
        verify: null,
        verifyAttempts: 0,
      });
      const preamble3 = readLessonsPreamble(dir);
      expect(preamble3).toContain("تحذير: تفويض فشل قبل الاكتمال (status=failed) — المهمة: \"crashed task\"");

      // 6) Exceeding max limit (30 lessons):
      // Populate with 40 manually formatted bullets
      const manyLines: string[] = [];
      for (let i = 1; i <= 40; i++) {
        manyLines.push(`- [2026-07-05T12:00:00.000Z] lesson number ${i}`);
      }
      const populatedContent =
        "# دروس مستفادة (acp)\n\nهذا الملف يُقرأ تلقائياً قبل كل تفويض قادم في هذا المشروع.\n\n" +
        manyLines.join("\n") +
        "\n";
      writeFileSync(join(dir, LESSONS_FILE_NAME), populatedContent, "utf8");

      // Record one more lesson
      recordLesson(dir, {
        task: "one last failure",
        status: "failed",
        verifyCmd: "npm test",
        verify: null,
        verifyAttempts: 0,
      });

      const finalContent = readFileSync(join(dir, LESSONS_FILE_NAME), "utf8");
      const finalLines = finalContent.split(/\r?\n/).filter(line => line.trim().startsWith("- ["));
      expect(finalLines.length).toBe(30);
      // Verify it contains the newest recorded one
      expect(finalContent).toContain("one last failure");
      // Verify oldest ones were removed (lesson number 1 should be gone, lesson number 40 should be kept)
      expect(finalContent).not.toContain("lesson number 1\n");
      expect(finalContent).toContain("lesson number 40");
      // 7) recordLesson with unsafe command/URL in task or verifyCmd
      recordLesson(dir, {
        task: "check https://example.com/hook and then run rm -rf tmp",
        status: "ok",
        verifyCmd: "npm test",
        verify: { ok: false, exitCode: 1 },
        verifyAttempts: 1,
      });
      const preambleUnsafe = readLessonsPreamble(dir);
      expect(preambleUnsafe).toContain("[محتوى المهمة استُبعد من السجل لاحتوائه نمطاً غير موثوق]");
      expect(preambleUnsafe).not.toContain("https://example.com");
      expect(preambleUnsafe).not.toContain("rm -rf");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
