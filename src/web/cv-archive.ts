/**
 * The archive is the source of truth; the Qwen conversation is a cache.
 *
 * A conversation lives on a third-party consumer product: it can be deleted by
 * the user, dropped by a sign-out, or lost to a product change — and it takes
 * every candidate's context with it. Inverting the relationship makes that a
 * recoverable event instead of a catastrophe: when a conversation is gone we open
 * a fresh one and rehydrate it from what we stored locally.
 */
import type { ConsultRecord } from "./qwen-db.js";

export const MAX_EXCHANGES_PER_CONVERSATION = 25;

export interface RotationDecision {
  rotate: boolean;
  reason: "key-change" | "identity-failed" | "exchange-limit" | null;
  generation: number;
}

/**
 * Rotation is deliberate and narrow: a long conversation is an ASSET (the model
 * keeps the candidate's context), so we only leave it for a reason we can name.
 */
export function decideRotation(o: {
  identityOk: boolean;
  keyChanged: boolean;
  exchanges: number;
  currentGeneration: number;
  maxExchanges?: number;
}): RotationDecision {
  const max = o.maxExchanges ?? MAX_EXCHANGES_PER_CONVERSATION;
  if (o.keyChanged) return { rotate: true, reason: "key-change", generation: 1 };
  if (!o.identityOk) {
    return { rotate: true, reason: "identity-failed", generation: o.currentGeneration + 1 };
  }
  if (o.exchanges >= max) {
    return { rotate: true, reason: "exchange-limit", generation: o.currentGeneration + 1 };
  }
  return { rotate: false, reason: null, generation: o.currentGeneration };
}

/**
 * Compact the archived exchanges into a briefing for a replacement conversation.
 * Only successful exchanges are carried over — a timeout or a site error taught
 * the model nothing, and repeating them would just waste the new context.
 */
export function buildRehydrationBrief(
  records: ConsultRecord[],
  o?: { maxItems?: number; maxCharsPerItem?: number },
): string {
  const maxItems = o?.maxItems ?? 8;
  const maxChars = o?.maxCharsPerItem ?? 400;

  const usable = records
    .filter((r) => r.status === "ok" && r.answer && r.question)
    .slice(0, maxItems)
    .reverse();

  if (usable.length === 0) return "";

  const lines: string[] = [];
  lines.push("سياق سابق لهذا الملف، منقول من الأرشيف المحلي بعد فقدان المحادثة الأصلية.");
  lines.push("اعتبره معطى مؤكداً ولا تعلّق عليه؛ أجب فقط عن السؤال الذي يليه.");
  lines.push("");
  usable.forEach((r, i) => {
    lines.push(`(${i + 1}) سؤال: ${clean(r.question, maxChars)}`);
    lines.push(`    جواب: ${clean(r.answer ?? "", maxChars)}`);
  });
  lines.push("");
  lines.push("--- نهاية السياق المنقول ---");
  return lines.join("\n");
}

function clean(s: string, max: number): string {
  const oneLine = s
    // Drop our own protocol scaffolding so the brief carries content, not plumbing.
    .replace(/ACP-LOCK:\s*[0-9a-f]{8,64}/gi, "")
    .replace(/\[Q-\d+-[0-9a-f]{2,8}\]/g, "")
    .replace(/ابدأ (?:جوابك|ردّك)[^\n]*/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}
