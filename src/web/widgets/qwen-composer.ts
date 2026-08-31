/**
 * The chat.qwen.ai composer widgets: the thinking-mode selector
 * (Fast / Auto / Thinking) and the model selector.
 *
 * This exists because the mode is not a cosmetic preference — it is the single
 * most consequential knob in the whole tool. It decides answer latency (median
 * 3.7s in Fast against 12s and a 90s tail in Auto), it decides the wait budget
 * derived from it, and it decides how the page renders a reply: in Thinking mode
 * the page falls silent between the reasoning phase and the answer stream, which
 * is what let a 52-character fragment be archived as a complete answer.
 *
 * It used to be handled by three divergent inline snippets (initial read, re-read
 * on settle, restore in a finally) that shared no logic and no guarantees:
 *
 *   - They found the widget with `querySelector('.ant-select-selection-item')`,
 *     i.e. "the first Ant select on the page is the mode one". The model selector
 *     is another Ant select, so one UI reshuffle would have silently pointed
 *     every read and every click at the wrong widget.
 *   - They switched with a synthetic `element.click()` from inside page JS —
 *     `isTrusted === false`, unlike every other input this project sends, and Ant
 *     listens to `mousedown` rather than `click` in some versions, so the switch
 *     could do nothing at all.
 *   - They slept a fixed 250ms for the dropdown, which is a race.
 *   - They never verified the mode actually changed: finding and clicking an
 *     option was treated as success.
 *   - On failure they printed a note and continued in the WRONG mode.
 *
 * Two rules shape this module, both from the design council:
 *
 *   1. `ensure` is the only verb worth exposing. Read, and if it differs, switch
 *      and then PROVE the displayed value changed. A click is not evidence.
 *   2. The mode belongs to the user's account, not to this tool. We may change it
 *      only when asked, and we must put it back — "if you cannot guarantee the
 *      restore, do not make the change at all". A `finally` block cannot make
 *      that guarantee (`process.exit` jumps straight over it, and a signal or a
 *      power cut ignores it entirely), so the user's own mode is written to disk
 *      the moment we touch it and repaired by whoever runs next.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import type { BrowserTab } from "../actions.js";
import { actAndVerify } from "../verify-action.js";

export type ThinkingMode = "Fast" | "Auto" | "Thinking";

/** Declared order matters: it is the order the dropdown lists them in. */
export const THINKING_MODES: ThinkingMode[] = ["Fast", "Auto", "Thinking"];

/** Wait budget per mode — the one place that knows what each mode costs. */
export function modeTimeoutMs(mode: string | null | undefined): number {
  if (/thinking/i.test(mode ?? "")) return 180000;
  if (/auto/i.test(mode ?? "")) return 120000;
  return 90000;
}

/** Accept "fast", "FAST", "Thinking\nQwen3.8" — reject anything unknown. */
export function normalizeMode(raw: string | null | undefined): ThinkingMode | null {
  if (!raw) return null;
  const head = String(raw).trim().split(/\r?\n/)[0]?.trim() ?? "";
  return THINKING_MODES.find((m) => m.toLowerCase() === head.toLowerCase()) ?? null;
}

/**
 * Selector ladder, semantic rungs first.
 *
 * ARIA roles survive component-library upgrades; `.ant-select-*` class names are
 * the vendor's private business and will change without notice. The Ant rungs
 * stay at the bottom because they are what demonstrably works on the live site
 * today — a ladder that only knows the ideal selector is just a broken tool with
 * better intentions.
 */
/**
 * The real composer, and only the real composer.
 *
 * Measured live: the page carries TWO <textarea> elements — `.ime-text-area`, a
 * staging field rich-text editors use to capture CJK input-method composition,
 * and `.message-input-textarea`, the actual composer. `.ime-text-area` sits
 * first in DOM order, so a bare `document.querySelector('textarea')` hits it
 * instead. Text typed there appears to succeed and then reads back empty on the
 * very next check — that field clears itself once a composition commits, which
 * is its entire job. The result looked like a random, intermittent failure: two
 * consultations on a session worked, then eight in a row failed identically,
 * because which textarea sorts first is not guaranteed stable.
 *
 * Excluding the known decoy is preferred over requiring the known-good class
 * outright: if the site ever renames `.message-input-textarea`, an exclusion
 * still finds SOME real textarea, where a positive match finds none at all.
 */
export const COMPOSER_SELECTOR = "textarea:not(.ime-text-area)";

export const TRIGGER_LADDER: string[] = [
  // The site's OWN semantic class, read off the live page. It names the widget
  // ("thinking"), it carries aria-label, and — the part that actually matters —
  // it is the ROOT that opens the dropdown when clicked. The first version of
  // this ladder led with [role=combobox], which chat.qwen.ai does not use at
  // all, so it fell through to `.ant-select-selector`: an inner node that reads
  // correctly but does NOT open the list. The switch failed, loudly, and that
  // loud failure is how this was found within a minute instead of showing up
  // later as an answer produced in the wrong mode.
  ".qwen-select-thinking",
  ".qwen-thinking-selector",
  "[role=combobox]",
  ".ant-select-selector",
  ".ant-select-selection-item",
];

export const OPTION_LADDER: string[] = [
  "[role=option]",
  ".ant-select-item-option",
  ".ant-select-item-option-content",
];

/**
 * The model selector is a different widget with different markup — a CSS-module
 * class, hashed per build, so only the stable substring is matched.
 */
export const MODEL_LADDER: string[] = [
  "[class*=model-selector-text]",
  "[class*=model-selector]",
  ".ant-dropdown-trigger",
];

/**
 * Which widget is which is decided by WHAT IT SAYS, never by its position.
 *
 * This is the fix for the wrong-widget class of bug: the mode selector is the
 * one displaying a mode name, the model selector is the one displaying a model
 * name. No amount of UI reordering can confuse that, and it needs no index.
 */
const MODE_RE = /^(fast|auto|thinking)$/i;
const MODEL_RE = /^qwen[\w.\-]*/i;

function ladderJs(ladder: string[]): string {
  return JSON.stringify(ladder);
}

/**
 * The selectors this site actually rests on, handed to the existing fingerprint
 * system so a UI change is DETECTED at capture time instead of being discovered
 * later through a wrong answer or an unreadable widget.
 */
export const QWEN_FINGERPRINT_MARKERS: string[] = [
  ...TRIGGER_LADDER,
  ...OPTION_LADDER,
  ...MODEL_LADDER,
  ".send-button",
  "[class*=markdown]",
];

/**
 * Readiness: the app has mounted only once the mode widget is painted. The shell
 * ships a bare textarea long before hydration finishes, and text typed into that
 * shell is wiped when the real composer replaces it.
 */
export const COMPOSER_READY_JS = `(() => {
  if (document.readyState !== 'complete') return false;
  if (!document.querySelector(${JSON.stringify(COMPOSER_SELECTOR)})) return false;
  const ladder = ${ladderJs(TRIGGER_LADDER)};
  for (const sel of ladder) {
    for (const el of document.querySelectorAll(sel)) {
      const t = ((el.innerText || '').trim().split('\\n')[0] || '').trim();
      if (/^(fast|auto|thinking)$/i.test(t)) return true;
    }
  }
  return false;
})()`;

/** Build the JS that locates a widget by its displayed text and reports it. */
function buildReadJs(kind: "mode" | "model"): string {
  const test = kind === "mode" ? MODE_RE.source : MODEL_RE.source;
  const ladder = kind === "mode" ? TRIGGER_LADDER : MODEL_LADDER;
  return `(() => {
    const ladder = ${ladderJs(ladder)};
    const re = new RegExp(${JSON.stringify(test)}, 'i');
    for (let i = 0; i < ladder.length; i++) {
      const els = [...document.querySelectorAll(ladder[i])];
      for (const el of els) {
        const t = ((el.innerText || '').trim().split('\\n')[0] || '').trim();
        if (t && re.test(t)) {
          return JSON.stringify({ value: t, rung: ladder[i] });
        }
      }
    }
    return JSON.stringify({ value: null, rung: null });
  })()`;
}

export interface WidgetRead {
  value: string | null;
  /** Which ladder rung matched — recorded so selector drift is visible. */
  rung: string | null;
}

/** A widget failure is never a warning. */
export class WidgetError extends Error {
  readonly rungsTried: string[];
  constructor(message: string, rungsTried: string[] = []) {
    super(message);
    this.name = "WidgetError";
    this.rungsTried = rungsTried;
  }
}

async function readWidget(tab: BrowserTab, kind: "mode" | "model"): Promise<WidgetRead> {
  const res = await tab.evaluate(buildReadJs(kind));
  if (!res.ok || typeof res.value !== "string") return { value: null, rung: null };
  try {
    const parsed = JSON.parse(res.value);
    return { value: parsed.value ?? null, rung: parsed.rung ?? null };
  } catch {
    return { value: null, rung: null };
  }
}

export async function readMode(tab: BrowserTab): Promise<WidgetRead> {
  return readWidget(tab, "mode");
}

export async function readModel(tab: BrowserTab): Promise<WidgetRead> {
  return readWidget(tab, "model");
}

// ---------------------------------------------------------------------------
// Pending restore: the user's own mode, kept on disk
// ---------------------------------------------------------------------------

export interface PendingRestore {
  /** The mode that belongs to the USER, to be put back. */
  mode: ThinkingMode;
  at: string;
  pid: number;
}

export function pendingRestorePath(): string {
  return join(homedir(), ".acp", "web-widget-restore.json");
}

export function readPendingRestore(): PendingRestore | null {
  try {
    const raw = JSON.parse(readFileSync(pendingRestorePath(), "utf8"));
    const mode = normalizeMode(raw?.mode);
    if (!mode) return null;
    return { mode, at: String(raw.at ?? ""), pid: Number(raw.pid ?? 0) };
  } catch {
    return null;
  }
}

export function writePendingRestore(mode: ThinkingMode): void {
  try {
    mkdirSync(join(homedir(), ".acp"), { recursive: true });
    writeFileSync(
      pendingRestorePath(),
      JSON.stringify({ mode, at: new Date().toISOString(), pid: process.pid }, null, 2),
      "utf8",
    );
  } catch {
    // Losing the marker must not fail the consultation; the in-process finally
    // is still there as the first line of defence.
  }
}

export function clearPendingRestore(): void {
  try {
    unlinkSync(pendingRestorePath());
  } catch {
    /* already gone */
  }
}

// ---------------------------------------------------------------------------
// ensureMode
// ---------------------------------------------------------------------------

export interface EnsureResult {
  changed: boolean;
  previous: ThinkingMode | null;
  current: ThinkingMode;
  /** How the option was chosen: a trusted click, or the keyboard fallback. */
  via: "already" | "click" | "keyboard";
}

/**
 * Point a precise CSS selector at the element we mean.
 *
 * `BrowserTab.click` takes a selector and dispatches a TRUSTED mouse event at
 * the element's coordinates — which is what we want, and the reason the old
 * synthetic in-page click is gone. But CSS cannot say "the option whose text is
 * Thinking", so the element is stamped with a data attribute first and the click
 * targets the stamp. The stamp is also the proof that we resolved the right
 * widget rather than the first Ant select on the page.
 */
function buildStampJs(ladder: string[], textRe: string, stamp: string): string {
  return `(() => {
    for (const el of document.querySelectorAll('[data-acp-w=${JSON.stringify(stamp).slice(1, -1)}]')) {
      el.removeAttribute('data-acp-w');
    }
    const ladder = ${ladderJs(ladder)};
    const re = new RegExp(${JSON.stringify(textRe)}, 'i');
    for (let i = 0; i < ladder.length; i++) {
      for (const el of document.querySelectorAll(ladder[i])) {
        const t = ((el.innerText || '').trim().split('\\n')[0] || '').trim();
        if (!t || !re.test(t)) continue;
        // Ant puts the text in an inner span but hangs the click handler on the
        // row; clicking the span works, clicking the row is what a human does.
        const target = el.closest('[role=option], .ant-select-item-option') || el;
        // An element you cannot click is not the element you mean.
        //
        // This site's [role=option] nodes are zero-WIDTH accessibility mirrors,
        // and they are not even aligned with the rows they describe: the mirror
        // for "Fast" sat 36px above the real "Fast" row, i.e. on top of
        // "Thinking". Clicking the most semantic selector therefore re-selected
        // the mode we were trying to leave, the widget reported no change, and
        // the whole switch failed for a reason no amount of reading the markup
        // would have revealed. Geometry decides what is clickable; semantics
        // only decide what it means.
        const box = target.getBoundingClientRect();
        if (box.width < 2 || box.height < 2) continue;
        target.setAttribute('data-acp-w', ${JSON.stringify(stamp)});
        return JSON.stringify({ ok: true, rung: ladder[i] });
      }
    }
    return JSON.stringify({ ok: false, rung: null });
  })()`;
}

async function stamp(
  tab: BrowserTab,
  ladder: string[],
  textRe: string,
  name: string,
): Promise<string | null> {
  const res = await tab.evaluate(buildStampJs(ladder, textRe, name));
  if (!res.ok || typeof res.value !== "string") return null;
  try {
    const parsed = JSON.parse(res.value);
    return parsed.ok ? String(parsed.rung) : null;
  } catch {
    return null;
  }
}

/**
 * Make the widget read `target`, or throw.
 *
 * Failure is deliberately fatal to the caller. Continuing in the wrong mode
 * corrupts three things at once — the answer's depth, the wait budget, and the
 * archived record of what produced it — and the old behaviour ("note: failed to
 * switch thinking mode, proceeding in current mode") taught anyone reading the
 * output to ignore it.
 */
export async function ensureMode(tab: BrowserTab, target: ThinkingMode): Promise<EnsureResult> {
  const before = await readMode(tab);
  const previous = normalizeMode(before.value);

  if (!previous) {
    throw new WidgetError(
      `cannot read the thinking-mode widget — no element matched a known mode name (${THINKING_MODES.join("/")}). ` +
        `The selector ladder is stale or the page did not finish loading.`,
      TRIGGER_LADDER,
    );
  }
  if (previous === target) {
    return { changed: false, previous, current: previous, via: "already" };
  }

  // 1 & 2. Open the dropdown with a trusted click on the widget we identified BY
  //        ITS TEXT, then wait for the options to EXIST.
  //
  // The open is RETRIED, because the page paints before it is interactive: the
  // mode label is on screen (which is what readiness checks) a moment before
  // React has attached the handler that opens the list. A click in that window is
  // received by the browser and ignored by the app — no error, nothing to detect
  // afterwards. It failed roughly one run in five until this loop existed.
  //
  // Retrying the ACTION is the honest fix; lengthening the wait is not. A longer
  // timeout would make every successful run slower and still lose the race
  // whenever hydration is slow, because the problem is a dropped click, not a
  // slow one.
  const OPEN_ATTEMPTS = 3;
  const optionsListedJs = `(() => {
      const ladder = ${ladderJs(OPTION_LADDER)};
      for (const sel of ladder) {
        for (const el of document.querySelectorAll(sel)) {
          const t = ((el.innerText || '').trim().split('\\n')[0] || '').trim();
          if (/^(fast|auto|thinking)$/i.test(t)) return true;
        }
      }
      return false;
    })()`;

  let triggerRung: string | null = null;
  let listed = false;
  let lastOpenError = "";
  for (let attempt = 1; attempt <= OPEN_ATTEMPTS && !listed; attempt++) {
    triggerRung = await stamp(tab, TRIGGER_LADDER, MODE_RE.source, "trigger");
    if (!triggerRung) {
      throw new WidgetError(
        "the thinking-mode trigger vanished between read and click",
        TRIGGER_LADDER,
      );
    }
    // Act, then prove — and give the page the standing beat before judging it
    // failed. The options ARE the proof that the dropdown opened; the click
    // returning ok only means a mouse event was delivered somewhere.
    const opened = await actAndVerify(
      tab,
      () => tab.click('[data-acp-w="trigger"]'),
      { appearedAny: OPTION_LADDER },
      { what: "فتح قائمة الوضع", graceMs: 2500 },
    );
    if (!opened.ok) {
      lastOpenError = String(opened.reason ?? "");
      // A click the transport itself refused (tab hidden, element off-screen)
      // will not fix itself by clicking again immediately.
      await new Promise((r) => setTimeout(r, 500 * attempt));
      continue;
    }
    // The generic probe proved the option rows exist; this confirms one of them
    // is actually a MODE row rather than some other list the click revealed.
    const res = await tab.waitFor({
      untilJs: optionsListedJs,
      timeoutMs: 1500,
      intervalMs: 100,
    });
    listed = res.ok;
    if (!listed) {
      // Close whatever half-state the click produced before trying again, so the
      // next click opens rather than toggles shut.
      await tab.press("Escape");
      await new Promise((r) => setTimeout(r, 400 * attempt));
    }
  }

  if (!listed) {
    await tab.press("Escape");
    throw new WidgetError(
      `the thinking-mode dropdown never listed its options after ${OPEN_ATTEMPTS} attempts` +
        (lastOpenError ? ` (last click error: ${lastOpenError})` : ""),
      OPTION_LADDER,
    );
  }

  // 3. Trusted click on the option, keyboard as the fallback.
  //
  // The keyboard path matters more than it looks: the options are rendered in a
  // portal that the accessibility snapshot does not expose, so the site playbook
  // had resorted to hunting coordinates. Arrow keys need no coordinates at all,
  // and they are delivered to the focused element rather than hit-tested against
  // a painted frame.
  let via: EnsureResult["via"] = "click";
  const optionRung = await stamp(tab, OPTION_LADDER, `^${target}$`, "option");
  let picked = false;
  if (optionRung) {
    // Picking an option should CLOSE the list. That is the observable difference
    // between a click that landed on the row and one that landed on a zero-width
    // mirror beside it — which is the failure this project has already paid for
    // once, and which a bare ok=true reported as success.
    const picked_ = await actAndVerify(
      tab,
      () => tab.click('[data-acp-w="option"]'),
      { gone: ["[role=listbox]", ".ant-select-dropdown:not(.ant-select-dropdown-hidden)"] },
      { what: "اختيار الوضع", graceMs: 2000 },
    );
    picked = picked_.ok;
  }
  if (!picked) {
    via = "keyboard";
    const from = THINKING_MODES.indexOf(previous);
    const to = THINKING_MODES.indexOf(target);
    const key = to > from ? "ArrowDown" : "ArrowUp";
    for (let i = 0; i < Math.abs(to - from); i++) {
      const k = await tab.press(key);
      if (!k.ok) {
        throw new WidgetError(`keyboard fallback failed on ${key}: ${String(k.error)}`, OPTION_LADDER);
      }
    }
    const enter = await tab.press("Enter");
    if (!enter.ok) {
      throw new WidgetError(`keyboard fallback failed on Enter: ${String(enter.error)}`, OPTION_LADDER);
    }
  }

  // 4. The proof. Not the click — the displayed value.
  const settled = await tab.waitFor({
    untilJs: `(() => {
      const ladder = ${ladderJs(TRIGGER_LADDER)};
      for (const sel of ladder) {
        for (const el of document.querySelectorAll(sel)) {
          const t = ((el.innerText || '').trim().split('\\n')[0] || '').trim();
          if (t.toLowerCase() === ${JSON.stringify(target.toLowerCase())}) return true;
        }
      }
      return false;
    })()`,
    timeoutMs: 6000,
    intervalMs: 200,
  });
  if (!settled.ok) {
    await tab.press("Escape");
    const after = await readMode(tab);
    throw new WidgetError(
      `the thinking mode did not change to ${target} — it still reads ${after.value ?? "unknown"} ` +
        `(tried via ${via})`,
      [triggerRung ?? "(no trigger rung)", optionRung ?? "(no option rung)"],
    );
  }

  // The displayed value is not the saved value.
  //
  // This mode is an account-wide preference: set it in one tab and a tab opened
  // afterwards inherits it. But the SAVE is asynchronous — a fresh tab opened
  // immediately after a verified switch still read the old mode, then read the
  // new one seconds later. Verifying the widget and exiting at once therefore
  // reports a success the account has not yet received. Waiting is the whole fix.
  await new Promise((r) => setTimeout(r, 1500));

  return { changed: true, previous, current: target, via };
}

/**
 * Put the user's mode back, and forget the marker only once it is actually back.
 *
 * Returns what it did so the caller can say so out loud: a silent repair of
 * someone's account setting is still an unexplained change to their account.
 */
export async function restoreMode(
  tab: BrowserTab,
  userMode: ThinkingMode,
): Promise<{ restored: boolean; error?: string }> {
  try {
    const res = await ensureMode(tab, userMode);
    clearPendingRestore();
    return { restored: res.changed };
  } catch (err) {
    // The marker deliberately SURVIVES a failed restore: the next run repairs it.
    return { restored: false, error: err instanceof Error ? err.message : String(err) };
  }
}
