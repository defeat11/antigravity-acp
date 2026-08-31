/**
 * Which archived questions carried a name out of the machine.
 *
 * The archive stores the REDACTED text that actually went out, which makes this
 * answerable rather than a matter of memory: whatever is in `question` is what
 * the service received.
 *
 * The bug being audited: redaction finds the owner's name by reading the first
 * lines of a document, because that is where a CV puts it. Wrap the CV inside a
 * prompt and the heading is no longer at the top, so the name goes out while the
 * phone, e-mail and profile handles — matched by shape, anywhere — are redacted
 * correctly. The result looks safe.
 *
 * Detection reuses the PRODUCTION rules rather than a second opinion written for
 * this scan. For every point where a document plausibly begins, the text from
 * that point on is handed to `extractLikelyNames` — the same function the
 * redactor uses. If it finds a name there, then a properly framed document would
 * have had that name removed, and its presence in the sent text is the leak. A
 * scan with its own private idea of what a name looks like would drift from the
 * redactor and start lying in one direction or the other.
 */
import { extractLikelyNames } from "./redact.js";
import type { ConsultRecord } from "./qwen-db.js";

/**
 * Where a wrapped document starts. These are the wrappers this project actually
 * used — the CV services' own separators and markdown headings.
 */
export const DOC_START_PATTERNS: RegExp[] = [
  // No \b after the Arabic word: JavaScript word boundaries are ASCII-only, so
  // \b never matches after "السيرة" and the separator was never found at all —
  // the scan would have missed the exact wrapper the CV services used.
  /^-{2,}\s*(?:السيرة|CV|RESUME).*$/im,
  /^={2,}\s*(?:السيرة|CV|RESUME).*$/im,
  /^#{1,3}\s+\S.*$/m,
];

/** Indices in `text` where a document may begin — always including the top. */
export function documentStarts(text: string): number[] {
  const starts = new Set<number>([0]);
  if (!text) return [0];

  const lines = text.split(/\r?\n/);
  let offset = 0;
  for (const line of lines) {
    for (const re of DOC_START_PATTERNS) {
      // Test the line alone: a multiline regex against the whole text would only
      // ever report the first match.
      if (new RegExp(re.source, re.flags.replace(/[gm]/g, "")).test(line.trim())) {
        starts.add(offset);
        break;
      }
    }
    offset += line.length + 1;
  }
  return [...starts].sort((a, b) => a - b);
}

/**
 * A header the CV generator already anonymised, e.g. "# USER_ID_5352982656".
 *
 * Six consultations looked like the leak — a CV with phone, e-mail and handles
 * masked and no name placeholder at all — and reading the stored text settled it:
 * there was no name to redact, because the generator had put an id where the name
 * goes. Without this the audit would flag those six on every future run, and a
 * standing false alarm is how a real one gets ignored.
 */
// The id may itself have been redacted — a ten-digit user id looks like a phone
// number, so the header can read "# USER_ID_[PHONE_2]". Requiring a literal digit
// missed exactly those, and left three clean consultations flagged.
const ANONYMISED_HEADER = /^#{0,3}\s*(?:USER_ID|CANDIDATE|CV)[_-]?(?:\w*\d|\[[A-Z]+_\d+\])/im;

export interface QuestionScan {
  /** Names that reached the service in full. */
  names: string[];
  /** Did this question carry a CV-shaped document at all? */
  carriesCv: boolean;
  /** Was ANY name placeholder present — i.e. did name redaction fire? */
  hasNamePlaceholder: boolean;
}

const CV_SHAPE =
  /(الخبرات|الخبرة العملية|المؤهلات|التعليم|المهارات|work experience|professional summary|education|skills|certifications)/i;

/**
 * Contact details within a few lines below the candidate.
 *
 * Without this the first inventory reported twenty findings of which two were
 * names: "KEY ACHIEVEMENTS", "Professional Experience" and an Arabic instruction
 * line all have the shape of a name — two or three words, capitalised or Arabic —
 * once they are read outside the top-of-CV context the rules were written for.
 *
 * What separates the real thing is position, not spelling. A CV puts the owner's
 * name directly above their phone, e-mail and links; a section heading has bullet
 * points under it. So corroboration is required, and the placeholders count as
 * evidence: they are exactly where the contact line was before redaction ran.
 */
export function hasContactNearby(slice: string, name: string): boolean {
  const lines = slice.split(/\r?\n/);
  const at = lines.findIndex((l) => l.includes(name));
  if (at === -1) return false;

  // Contact DETAILS only — no city names. A CV lists a city under every job it
  // has ever held, so geography corroborates nothing: it made each heading in the
  // employment history look like it sat above a contact line, and six false
  // findings followed.
  const CONTACT = /\[(?:PHONE|EMAIL|HANDLE|ID)_\d+\]|@[\w.-]+\.\w{2,}|(?:\+|00)\d{6,}|linkedin|github|t\.me/i;

  // Three lines, not six. At six, an instruction line sitting just above the CV
  // header borrowed the header's own contact line and was reported as a person.
  // A CV header is name, then title, then contacts — the real distance is one to
  // three.
  for (let i = at + 1; i <= Math.min(at + 3, lines.length - 1); i++) {
    if (CONTACT.test(lines[i] ?? "")) return true;
  }
  return false;
}

export function scanQuestion(text: string): QuestionScan {
  const empty: QuestionScan = { names: [], carriesCv: false, hasNamePlaceholder: false };
  if (!text) return empty;

  const hasNamePlaceholder = /\[NAME_\d+\]/.test(text);
  const carriesCv = CV_SHAPE.test(text) || DOC_START_PATTERNS.some((re) => re.test(text));

  // Name extraction runs ONLY where a CV actually is.
  //
  // The heuristics that find a person's name are tuned for the top of a CV, and
  // out of that context they over-fire badly: any Arabic line of two to five
  // words has the shape of an Arabic name, so a plain question like "سؤال عادي"
  // was reported as a leaked name. An audit that cries leak on ordinary traffic
  // is worse than no audit — it buries the eight real cases in noise.
  if (!carriesCv) return { names: [], carriesCv, hasNamePlaceholder };

  const found = new Set<string>();
  for (const start of documentStarts(text)) {
    const slice = text.slice(start);
    for (const name of extractLikelyNames(slice)) {
      // A name is only evidence of a leak if it is still THERE. Anything the
      // redactor replaced is gone from this text by definition.
      if (!text.includes(name)) continue;
      // And it must sit where a CV puts a name: next to contact details.
      if (hasContactNearby(slice, name)) found.add(name);
    }
  }

  return { names: [...found], carriesCv, hasNamePlaceholder };
}

export interface LeakFinding {
  id: string;
  created_at: string;
  session: string;
  names: string[];
  /**
   * `confirmed` — a name was found in the text that went out.
   * `suspect`   — a CV went out with other identifiers redacted and no name
   *               placeholder at all, which is the shape of this bug even when
   *               the name itself cannot be re-derived from the stored text.
   */
  level: "confirmed" | "suspect";
}

/** Kinds of redaction recorded on a record, e.g. ["email","phone"]. */
export function redactionKinds(rec: ConsultRecord): string[] {
  try {
    const hits = JSON.parse(rec.metadata || "{}")?.redactions;
    if (!Array.isArray(hits)) return [];
    return [...new Set(hits.map((h: { kind?: string }) => String(h?.kind ?? "")))].filter(Boolean);
  } catch {
    return [];
  }
}

export function scanRecords(records: ConsultRecord[]): LeakFinding[] {
  const out: LeakFinding[] = [];
  for (const rec of records) {
    const scan = scanQuestion(rec.question || "");
    if (scan.names.length > 0) {
      out.push({
        id: rec.id,
        created_at: rec.created_at,
        session: rec.session,
        names: scan.names,
        level: "confirmed",
      });
      continue;
    }

    // No name recoverable from the text — but a CV that redacted a phone or an
    // e-mail and no name at all did not simply lack a name; CVs have names.
    const kinds = redactionKinds(rec);
    const otherIdentifiers = kinds.some((k) => k === "email" || k === "phone" || k === "handle");
    const anonymised = ANONYMISED_HEADER.test(rec.question || "");
    if (
      scan.carriesCv &&
      otherIdentifiers &&
      !kinds.includes("name") &&
      !scan.hasNamePlaceholder &&
      !anonymised
    ) {
      out.push({
        id: rec.id,
        created_at: rec.created_at,
        session: rec.session,
        names: [],
        level: "suspect",
      });
    }
  }
  return out.sort((a, b) => a.created_at.localeCompare(b.created_at));
}

export interface LeakSummary {
  scanned: number;
  confirmed: number;
  suspect: number;
  /** Sessions touched, so the report says WHOSE data this was. */
  sessions: string[];
  findings: LeakFinding[];
}

export function summarize(records: ConsultRecord[]): LeakSummary {
  const findings = scanRecords(records);
  return {
    scanned: records.length,
    confirmed: findings.filter((f) => f.level === "confirmed").length,
    suspect: findings.filter((f) => f.level === "suspect").length,
    sessions: [...new Set(findings.map((f) => f.session))].sort(),
    findings,
  };
}
