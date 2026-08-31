export interface SiteErrorMatch {
  kind: "unavailable" | "rate_limit" | "network" | "generic";
  marker: string;
}

interface ErrorPattern {
  kind: SiteErrorMatch["kind"];
  pattern: RegExp;
  label: string;
}

const ERROR_PATTERNS: ErrorPattern[] = [
  // unavailable
  { kind: "unavailable", pattern: /service unavailable/i, label: "service unavailable" },
  { kind: "unavailable", pattern: /الخدمة غير متوفرة/i, label: "الخدمة غير متوفرة" },

  // rate_limit
  { kind: "rate_limit", pattern: /too many requests/i, label: "too many requests" },
  { kind: "rate_limit", pattern: /rate limit/i, label: "rate limit" },
  { kind: "rate_limit", pattern: /you have reached/i, label: "you have reached" },
  { kind: "rate_limit", pattern: /الحد الأقصى/i, label: "الحد الأقصى" },

  // network
  { kind: "network", pattern: /network error/i, label: "network error" },
  { kind: "network", pattern: /failed to fetch/i, label: "failed to fetch" },

  // generic
  { kind: "generic", pattern: /something went wrong/i, label: "something went wrong" },
  { kind: "generic", pattern: /server error/i, label: "server error" },
  { kind: "generic", pattern: /an error occurred/i, label: "an error occurred" },
  { kind: "generic", pattern: /please try again/i, label: "please try again" },
  { kind: "generic", pattern: /خطأ في الخادم/i, label: "خطأ في الخادم" },
  { kind: "generic", pattern: /حدث خطأ/i, label: "حدث خطأ" },
  { kind: "generic", pattern: /حاول مرة أخرى/i, label: "حاول مرة أخرى" },
  { kind: "generic", pattern: /تعذر/i, label: "تعذر" },
];

/**
 * Detect site-side error markers in the given page region text.
 * Returns the first match with its kind and matched marker, or null if no error marker is present.
 */
export function detectSiteError(pageText: string): SiteErrorMatch | null {
  if (!pageText || typeof pageText !== "string") return null;

  for (const item of ERROR_PATTERNS) {
    const match = item.pattern.exec(pageText);
    if (match) {
      return {
        kind: item.kind,
        marker: match[0],
      };
    }
  }

  return null;
}

/**
 * Is retrying this error worth anything?
 *
 * The retry loop treated every site error the same, so a DAILY quota — "You have
 * reached the daily usage limit. Please wait 8 hours before trying again." — was
 * answered by sending the question again, twice, within seconds. That is not a
 * recovery attempt; it is knocking harder on a door that said come back tomorrow,
 * and against a real service it is exactly the behaviour that earns a longer
 * block.
 *
 * A transient failure deserves another go. A stated limit deserves to be
 * believed.
 */
export function isRetryableSiteError(kind: SiteErrorMatch["kind"]): boolean {
  return kind !== "rate_limit";
}

/**
 * How long the notice says to wait, in minutes, when it says so at all.
 *
 * Reported to the caller so "try later" carries a number instead of leaving
 * someone to re-run every few minutes to find out.
 */
export function parseWaitHint(text: string): number | null {
  if (!text) return null;
  const hours = text.match(/(\d+(?:\.\d+)?)\s*(?:hours?|ساعة|ساعات)/i);
  if (hours?.[1]) return Math.round(Number(hours[1]) * 60);
  const mins = text.match(/(\d+)\s*(?:minutes?|mins?|دقيقة|دقائق)/i);
  if (mins?.[1]) return Number(mins[1]);
  const days = text.match(/(\d+)\s*(?:days?|يوم|أيام)/i);
  if (days?.[1]) return Number(days[1]) * 24 * 60;
  return null;
}
