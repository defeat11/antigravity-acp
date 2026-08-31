/**
 * The evaluation contract for a CV consultation.
 *
 * Two properties matter more than elegance here:
 *  - every judgement carries a verbatim quote from the CV, so a human can check
 *    it instead of trusting it;
 *  - the answer ends with a sentinel line, so a truncated reply is detected
 *    rather than filed as a complete evaluation with half its reasoning missing.
 */

export const SENTINEL = "=== نهاية التقييم ===";

export const DEFAULT_CRITERIA = [
  "الخبرة التقنية ذات الصلة",
  "عمق المهارات الأساسية للدور",
  "أثر منجزات موثّقة",
  "التقدّم المهني والاستمرارية",
  "ملاءمة المستوى للدور",
];

export interface RubricOptions {
  criteria?: string[];
  jobTitle?: string;
  cvText: string;
}

/**
 * Note the explicit line about redaction placeholders. Without it the model reads
 * "[EMAIL_1]" as a gap in the CV and quietly deducts marks for missing contact
 * details — a bias applied to every candidate equally, and therefore invisible
 * in the results while still being wrong.
 */
export function buildEvaluationPrompt(o: RubricOptions): string {
  const criteria = o.criteria?.length ? o.criteria : DEFAULT_CRITERIA;
  const lines: string[] = [];

  lines.push("قيّم السيرة الذاتية التالية وفق القالب الملزم أدناه، ولا تخرج عنه.");
  if (o.jobTitle) lines.push(`الدور المستهدف: ${o.jobTitle}`);
  lines.push("");
  lines.push(
    "تنبيه: الرموز مثل [NAME_1] و[EMAIL_1] و[PHONE_1] حُجبت عمداً لحماية الخصوصية، وهي ليست نقصاً في السيرة. لا تخصم أي درجة بسببها ولا تعلّق عليها.",
  );
  lines.push("");
  lines.push("المعايير (درجة من 1 إلى 5 لكل معيار):");
  criteria.forEach((c, i) => lines.push(`${i + 1}. ${c}`));
  lines.push("");
  lines.push("القالب الملزم — التزم بالعناوين حرفياً:");
  lines.push("");
  criteria.forEach((c, i) => {
    lines.push(`### معيار ${i + 1}: ${c}`);
    lines.push("الدرجة: <1-5>");
    lines.push("الدليل: «اقتباس حرفي من السيرة»");
    lines.push("التعليل: <سطر واحد>");
    lines.push("");
  });
  lines.push("### نقاط القوة");
  lines.push("- <نقطة مع اقتباس>");
  lines.push("");
  lines.push("### الفجوات");
  lines.push("- <فجوة مع سبب>");
  lines.push("");
  lines.push("### الدرجة الكلية");
  lines.push("<متوسط الدرجات من 5>");
  lines.push("");
  lines.push("### درجة الثقة");
  lines.push("<عالية | متوسطة | منخفضة> — <سبب>");
  lines.push("");
  lines.push(`اختم ردّك بهذا السطر حرفياً وبلا أي نص بعده: ${SENTINEL}`);
  lines.push("");
  lines.push("قاعدة صارمة: كل حكم يجب أن يستند إلى اقتباس حرفي من نص السيرة. إن لم تجد دليلاً، اكتب «لا دليل» ولا تخمّن.");
  lines.push("");
  lines.push("--- نص السيرة ---");
  lines.push(o.cvText.trim());
  lines.push("--- نهاية نص السيرة ---");

  return lines.join("\n");
}

export interface ParsedEvaluation {
  complete: boolean;
  scores: { criterion: string; score: number | null; evidence: string | null }[];
  overall: number | null;
  confidence: string | null;
  missing: string[];
}

/** Parse the structured answer. Anything the template promised but is absent is reported. */
export function parseEvaluation(answer: string, criteria?: string[]): ParsedEvaluation {
  const text = answer ?? "";
  const complete = text.includes(SENTINEL);
  const wanted = criteria?.length ? criteria : DEFAULT_CRITERIA;
  const missing: string[] = [];

  const scores: ParsedEvaluation["scores"] = wanted.map((c, i) => {
    const block = sectionFor(text, `معيار ${i + 1}`);
    const score = block ? firstNumber(block.match(/الدرجة:\s*([1-5])/)) : null;
    const evidence = block ? firstQuote(block) : null;
    if (score === null) missing.push(`درجة معيار ${i + 1}`);
    if (!evidence) missing.push(`دليل معيار ${i + 1}`);
    return { criterion: c, score, evidence };
  });

  const overallBlock = sectionFor(text, "الدرجة الكلية");
  const overall = overallBlock ? firstNumber(overallBlock.match(/(\d+(?:[.,]\d+)?)/)) : null;
  if (overall === null) missing.push("الدرجة الكلية");

  // First NON-EMPTY line: a heading is followed by a newline, so line 0 is blank.
  const confBlock = sectionFor(text, "درجة الثقة");
  const confidence = confBlock
    ? (confBlock.split("\n").map((l) => l.trim()).find(Boolean) ?? null)
    : null;
  if (!confidence) missing.push("درجة الثقة");

  if (!complete) missing.push("سطر الخاتمة");

  return { complete, scores, overall, confidence, missing };
}

function sectionFor(text: string, heading: string): string | null {
  const idx = text.indexOf(heading);
  if (idx < 0) return null;
  const rest = text.slice(idx + heading.length);
  const next = rest.indexOf("###");
  return next < 0 ? rest : rest.slice(0, next);
}

function firstNumber(m: RegExpMatchArray | null): number | null {
  if (!m || !m[1]) return null;
  const n = Number(String(m[1]).replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

function firstQuote(block: string): string | null {
  const m = block.match(/[«"]([^»"]{3,})[»"]/);
  return m ? m[1]!.trim() : null;
}

/**
 * A comparison across candidates is only meaningful when the same judge answered
 * under the same settings. Different model or thinking mode = not comparable.
 */
export function comparabilityKey(model: string | null, thinking: string | null): string {
  return `${(model ?? "?").trim()}|${(thinking ?? "?").trim()}`;
}
