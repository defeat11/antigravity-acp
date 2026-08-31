/**
 * Which selector means "this site is still working", per site.
 *
 * The council's sharpest point was not about mechanics: an agent under
 * uncertainty picks the path with the LEAST fragility. A blind sleep needs no
 * understanding of the page, no correct selector and risks no race — so unless
 * the honest signal is easier to reach than the workaround, the workaround wins
 * even when the signal exists.
 *
 * This table is what makes it easier. The agent does not have to discover that
 * chat.qwen.ai marks generation with a Stop button, nor that the reply lives in
 * markdown containers: it reads the recipe, or better, copies the ready-made
 * command a failed wait prints for it.
 *
 * Entries are earned, not guessed. Each pair here was observed on the live page
 * — see the site playbook for the traces.
 */

export interface BusyRecipe {
  /** Where the growing content is. */
  stable: string;
  /** Present while the site is still working; absent when it has finished. */
  busy: string;
  /** Why these, in one line — so a future editor knows what to re-measure. */
  note: string;
}

const RECIPES: Record<string, BusyRecipe> = {
  "chat.qwen.ai": {
    stable: "[class*=markdown]",
    busy: "[aria-label='Stop']",
    // Measured at 100ms resolution: Stop is present for the whole stream and
    // disappears only after the text stops growing. The Send button is NOT the
    // signal — it does not exist while the composer is empty.
    note: "Stop button present throughout generation; Send is absent when idle",
  },
};

/** Strip a leading www. and lowercase, so one entry covers the obvious variants. */
export function normalizeHostKey(host: string): string {
  return (host || "").trim().toLowerCase().replace(/^www\./, "");
}

export function busyRecipeFor(host: string): BusyRecipe | null {
  return RECIPES[normalizeHostKey(host)] ?? null;
}

export function knownBusyHosts(): string[] {
  return Object.keys(RECIPES).sort();
}

/**
 * The exact command to run instead — printed when a wait fails or is malformed.
 *
 * A suggestion the caller can copy costs one line and removes the whole reason
 * to invent a sleep. A suggestion that says "use the right condition" costs the
 * same line and removes nothing.
 */
export function suggestWaitCommand(host: string, session: string): string | null {
  const recipe = busyRecipeFor(host);
  if (!recipe) return null;
  const s = session && session !== "default" ? ` --session ${session}` : "";
  return `acp web call wait${s} --stable "${recipe.stable}" --busy "${recipe.busy}"`;
}

/**
 * What to tell someone whose wait just burned its whole timeout without the
 * condition ever coming true.
 */
export function blindWaitAdvice(host: string, session: string): string {
  const cmd = suggestWaitCommand(host, session);
  const lines = [
    "هذا انتظار لم يصدُق شرطه ولا مرة — استهلك المهلة كاملة.",
    cmd
      ? `للانتظار حتى يكتمل الرد على ${normalizeHostKey(host)} استعمل:\n  ${cmd}`
      : "للانتظار حتى يكتمل محتوى متغيّر: wait --stable <css> --busy <css>",
    "وللانتظار الزمني المتعمّد استعمل مهلة قصيرة وشرطاً حقيقياً — لا شرطاً ثابتاً.",
  ];
  return lines.join("\n");
}
