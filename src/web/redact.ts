import { createHash } from "node:crypto";

export interface RedactionHit {
  kind: "email" | "phone" | "iban" | "id" | "name" | "handle";
  original: string;
  placeholder: string;
}

export interface RedactionResult {
  text: string;
  hits: RedactionHit[];
  clean: boolean;
}

export function vipSlug(identifier: string): string {
  if (!identifier || !identifier.trim()) {
    throw new Error("VIP identifier cannot be empty");
  }
  const raw = identifier.trim();
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");

  let slug = cleaned;
  if (!slug) {
    slug = createHash("sha256").update(raw).digest("hex").slice(0, 12);
  }

  if (slug.length > 48) {
    slug = slug.slice(0, 48).replace(/-+$/g, "");
  }

  return slug;
}


/**
 * Pull the CV owner's own name out of the document.
 *
 * The redaction list covered structured identifiers (e-mail, phone, IBAN, profile
 * handles) but the NAME only disappeared when the caller happened to pass it. A
 * review flagged that as a certain leak, not a hypothetical one: the name sits in
 * the first line, in an e-mail signature, on certificates and in the references
 * block. Anything derived here is fed into the same literal-redaction path.
 */
export function extractLikelyNames(text: string): string[] {
  const found = new Set<string>();
  if (!text) return [];

  const lines = text.split(/\r?\n/).map((l) => l.trim());

  // 1. Explicit labels — the most reliable source.
  for (const line of lines.slice(0, 60)) {
    const m = line.match(/^(?:#+\s*)?(?:الاسم|الإسم|اسم المرشح|full name|name|candidate)\s*[:：-]\s*(.{3,60})$/i);
    if (m && m[1]) found.add(cleanName(m[1]));
  }

  // 1b. Self-introduction in running prose. The preview caught this on its very
  // first use: "اسمي سامي المطيري وجوالي ..." sailed through because it carries
  // no label and is not on the first line. Free text is how people actually
  // write, so it cannot be treated as an edge case.
  const INTRO = /(?:اسمي|إسمي|أنا\s+أدعى|اسمى|my\s+name\s+is|i\s*['’]?m|i\s+am|this\s+is)\s+([\p{L}][\p{L}\s'’-]{2,40})/giu;
  for (const m of text.matchAll(INTRO)) {
    const candidate = cleanName(m[1] ?? "")
      // Stop at the first connector so we take the name, not the sentence.
      .replace(/\s+(?:و|and|,|،).*$/u, "")
      .trim();
    const words = candidate.split(/\s+/);
    if (words.length >= 2 && words.length <= 4 && candidate.length >= 5) {
      found.add(candidate);
    }
  }

  // 2. A heading or first non-empty line that reads like a person's name.
  //
  // The line is CLEANED BEFORE it is judged, not after. It used to be judged raw
  // and cleaned afterwards, so "# LAYLA ABDULLATIF (NOURA)" was never recognised
  // as a name at all: the test requires every word to start with a letter, and
  // "(NOURA)" starts with a bracket. The phone, e-mail and profile handles on the
  // lines below it were redacted correctly, which made the output look safe —
  // the one identifier that matters most walked through the front door.
  //
  // A parenthetical alias is a name in its own right, so it is redacted too
  // rather than merely stripped from the test input; on a CV it is usually the
  // name the person is actually called by.
  for (const line of lines.slice(0, 8)) {
    const bare = line.replace(/^#+\s*/, "").replace(/\*\*/g, "").trim();
    const cleaned = cleanName(bare);
    if (looksLikePersonName(cleaned)) {
      found.add(cleaned);
      const alias = bare.match(/\(\s*([\p{L}][\p{L}\s'’-]{1,30})\s*\)/u);
      if (alias?.[1]) found.add(alias[1].trim());
      break;
    }
  }

  // 3. The local part of an e-mail: "sami.al-otaibi@x.com" -> "sami al otaibi".
  for (const m of text.matchAll(/\b([A-Za-z][A-Za-z0-9._-]{2,})@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)) {
    const local = (m[1] ?? "").replace(/\d+/g, " ").replace(/[._-]+/g, " ").trim();
    const words = local.split(/\s+/).filter((w) => w.length > 2);
    // Skip role addresses; they name a function, not a person.
    if (/^(info|admin|contact|hello|support|jobs|hr|careers|sales|team|user)$/i.test(words[0] ?? "")) continue;
    if (words.length >= 2) found.add(words.join(" "));
  }

  return [...found].filter((n) => n.length >= 3 && n.length <= 60);
}

function cleanName(raw: string): string {
  return raw
    .replace(/[|,،].*$/, "")
    .replace(/\((?:[^)]*)\)/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * CV section headings read exactly like two-word title-case names. Treating
 * "Professional Summary" as a person mangles the document's structure and makes
 * the evaluation harder — over-redaction costs real information.
 */
const SECTION_HEADINGS =
  /^(professional\s+(?:summary|experience|background)|work\s+experience|core\s+competenc|key\s+skills|technical\s+skills|education|certifications?|projects?|languages?|references?|contact\s+(?:info|details)|career\s+objective|personal\s+(?:info|details)|employment\s+history|achievements?|awards?|publications?|volunteer|interests?|الملخص\s+المهني|الخبرات?\s*(?:العملية|المهنية)?|التعليم|المؤهلات|المهارات|الشهادات|المشاريع|اللغات|المراجع|الاهتمامات|الدورات|ملف\s+المرشح|بيانات\s+المرشح|نبذة\s+مختصرة)/i;

function looksLikePersonName(line: string): boolean {
  if (!line || line.length < 5 || line.length > 60) return false;
  if (/[0-9@:/\\]/.test(line)) return false;
  if (SECTION_HEADINGS.test(line.trim())) return false;
  // A job title is not a name, and CVs love putting one on line two.
  if (/(engineer|developer|manager|specialist|architect|consultant|designer|analyst|مهندس|مطور|مدير|أخصائي|مستشار|محلل)/i.test(line)) {
    return false;
  }
  const words = line.split(/\s+/);
  if (words.length < 2 || words.length > 5) return false;
  const arabic = /^[؀-ۿ\s]+$/.test(line);
  const latinTitled = words.every((w) => /^[A-Z][a-zA-Z'’-]+$/.test(w));
  return arabic || latinTitled;
}

export function redactPII(text: string, extraLiterals?: string[]): RedactionResult {
  if (!text) {
    return { text: "", hits: [], clean: true };
  }

  let currentText = text;
  const hits: RedactionHit[] = [];
  const valueToPlaceholder = new Map<string, string>();
  const counters: Record<string, number> = {
    email: 0,
    phone: 0,
    iban: 0,
    handle: 0,
    id: 0,
    name: 0,
  };

  const getOrCreatePlaceholder = (kind: "email" | "phone" | "iban" | "id" | "name" | "handle", val: string): string => {
    const existing = valueToPlaceholder.get(val);
    if (existing) return existing;
    counters[kind] = (counters[kind] || 0) + 1;
    const tag = kind.toUpperCase();
    const ph = `[${tag}_${counters[kind]}]`;
    valueToPlaceholder.set(val, ph);
    hits.push({ kind, original: val, placeholder: ph });
    return ph;
  };

  // 1. Literals: what the caller passed PLUS the owner's own name found in the
  // document. Relying on the caller alone left the name in the text whenever the
  // caller did not know it — which is most of the time.
  const autoNames = extractLikelyNames(text);
  const allLiterals = [...(extraLiterals ?? []), ...autoNames];
  if (allLiterals.length > 0) {
    const validLiterals = Array.from(new Set(allLiterals.map((l) => l.trim()).filter(Boolean))).sort(
      (a, b) => b.length - a.length
    );

    for (const lit of validLiterals) {
      const escaped = lit.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
      const re = new RegExp(`\\b${escaped}\\b|${escaped}`, "gi");
      currentText = currentText.replace(re, (match) => {
        return getOrCreatePlaceholder("name", match);
      });
    }
  }

  // 2. Email addresses & mailto: links & URLs with @ user parts
  currentText = currentText.replace(/\bmailto:([^\s"'>]+)/gi, (match) => {
    return getOrCreatePlaceholder("email", match);
  });

  currentText = currentText.replace(/https?:\/\/[^\s/@:]+@[^\s/]+/gi, (match) => {
    return getOrCreatePlaceholder("email", match);
  });

  currentText = currentText.replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, (match) => {
    return getOrCreatePlaceholder("email", match);
  });

  // A profile URL is an identifier: "github.com/octocat" names a person as
  // surely as an e-mail does. Found on a real CV where the phone and e-mail had
  // been redacted correctly and the LinkedIn and GitHub links walked straight
  // through. Only the handle is removed — the platform name is kept, because
  // "has a GitHub profile" is a legitimate signal for an evaluation.
  currentText = currentText.replace(
    /\b((?:https?:\/\/)?(?:[a-z0-9-]+\.)?(?:linkedin\.com\/(?:in|pub)|github\.com|gitlab\.com|twitter\.com|x\.com|behance\.net|dribbble\.com|medium\.com|t\.me|telegram\.me)\/)([A-Za-z0-9._~-]{2,})/gi,
    (_m, prefix: string, handle: string) => `${prefix}${getOrCreatePlaceholder("handle", handle)}`,
  );

  // 3. IBAN: Saudi SA + 22 digits or generic IBANs
  currentText = currentText.replace(/\bSA\s?\d{2}(\s?\d{4}){5}\b|\bSA\d{22}\b/gi, (match) => {
    return getOrCreatePlaceholder("iban", match);
  });

  currentText = currentText.replace(/\b[A-Z]{2}\d{2}[A-Za-z0-9]{11,30}\b/g, (match) => {
    if (match.toUpperCase().startsWith("SA")) return match;
    return getOrCreatePlaceholder("iban", match);
  });

  // 4. Saudi National ID / Iqama: standalone 10-digit number starting with 1 or 2
  currentText = currentText.replace(/\b[12]\d{9}\b/g, (match) => {
    return getOrCreatePlaceholder("id", match);
  });

  // 5. Phone numbers — a number is only a phone when it LOOKS like one.
  //
  // The old rule redacted any 9-10 digit run starting with 5, which swallowed a
  // Telegram id (5352982656) and would swallow employee numbers, project codes
  // and large metrics on a CV. Over-redaction is not free: it destroys facts the
  // evaluation needs, silently and unrecoverably.
  //
  // A phone is now recognised by an actual phone SIGNAL:
  //   - an international prefix (+966 / 00966 / +44 …), or
  //   - a national trunk zero (05xxxxxxxx), or
  //   - separators that only appear in dialled numbers, or
  //   - a nearby word saying it is a phone.
  const PHONE_WORDS = "phone|mobile|tel|telephone|cell|whatsapp|هاتف|جوال|جوّال|موبايل|تلفون|واتساب|واتس";

  // Saudi with an explicit country code or trunk zero.
  currentText = currentText.replace(
    /(?:\+|00)966[-.\s]?5\d{8}\b|\b05\d{8}\b|\b\(?05\d\)?[-.\s]\d{3}[-.\s]?\d{4}\b/g,
    (match) => getOrCreatePlaceholder("phone", match),
  );

  // Any international number written with a leading +.
  currentText = currentText.replace(
    /\+\d{1,3}[-.\s]?\(?\d{1,4}\)?[-.\s]?\d{3,4}[-.\s]?\d{3,4}\b/g,
    (match) => {
      const digits = match.replace(/\D/g, "");
      if (digits.length < 9 || digits.length > 15) return match;
      return getOrCreatePlaceholder("phone", match);
    },
  );

  // Grouped digits with separators — "055 123 4567", "(011) 234-5678".
  currentText = currentText.replace(
    /\b\(?\d{2,4}\)?[-.\s]\d{3,4}[-.\s]\d{3,4}\b/g,
    (match) => {
      const digits = match.replace(/\D/g, "");
      if (digits.length < 9 || digits.length > 15) return match;
      if (/^\d{4}[-.]\d{2}[-.]\d{2}$/.test(match.trim())) return match; // a date
      return getOrCreatePlaceholder("phone", match);
    },
  );

  // A bare digit run counts only when the text says it is a phone.
  currentText = currentText.replace(
    new RegExp(`((?:${PHONE_WORDS})\\s*[:：-]?\\s*)(\\+?\\d[\\d-.\\s()]{7,17}\\d)`, "gi"),
    (_m, label: string, num: string) => {
      const digits = num.replace(/\D/g, "");
      if (digits.length < 9 || digits.length > 15) return `${label}${num}`;
      return `${label}${getOrCreatePlaceholder("phone", num.trim())}`;
    },
  );

  return {
    text: currentText,
    hits,
    clean: hits.length === 0,
  };
}
