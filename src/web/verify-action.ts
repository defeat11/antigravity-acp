/**
 * After every click, keypress or fill: settle, look, and say what changed.
 *
 * Every expensive mistake in this project came from the same shape — an action
 * that reported success and changed nothing:
 *
 *   - a click on `.send-button` when that element did not exist yet, which cost
 *     3.2 seconds per consultation and was blamed on the site;
 *   - a click on a zero-width accessibility mirror that re-selected the mode we
 *     were trying to leave;
 *   - a typed question wiped by a late hydration pass;
 *   - a mode switch that reported success while the widget never moved.
 *
 * In each case the page could have been asked. So this is the standing rule,
 * made cheap enough that there is no excuse to skip it: act, wait a beat, and
 * check three things — did what should vanish vanish, did what should appear
 * appear, and did the site put up a notice.
 *
 * The beat matters. A UI that reacts to a click needs a frame or two before the
 * result is in the DOM, so an immediate read reports the state BEFORE the action
 * and calls it a failure. 500ms is comfortably past that on this site and still
 * invisible next to a consultation.
 */
import type { BrowserTab } from "./actions.js";
import { detectSiteError, type SiteErrorMatch } from "./site-errors.js";

/** The settle before looking. Long enough for a re-render, short enough to pay. */
export const SETTLE_MS = 500;

export interface PageState {
  /** Selectors that were asked about, mapped to how many visible matches exist. */
  present: Record<string, number>;
  /** Characters currently in the composer, or null when there is no composer. */
  composer: number | null;
  /** Text of any alert/toast/notification container. */
  notice: string;
}

export interface ActionExpectation {
  /** These must be gone (0 visible matches). */
  gone?: string[];
  /** These must ALL exist (at least 1 visible match each). */
  appeared?: string[];
  /**
   * At least ONE of these must exist — the shape a selector ladder actually has.
   *
   * Passing a ladder to `appeared` demands every rung match at once, which is
   * never true: this site's `[role=option]` nodes are zero-width mirrors that the
   * probe deliberately ignores, so requiring them alongside the real rows failed
   * a mode switch that had worked seconds earlier. A ladder is an OR.
   */
  appearedAny?: string[];
  /** The composer must be empty / non-empty. */
  composerEmpty?: boolean;
  /**
   * Which element counts as "the composer". Defaults to a bare `textarea` —
   * fine for an arbitrary site this module knows nothing about. A caller that
   * DOES know its site (qwen-cli, for chat.qwen.ai) should pass its own
   * measured selector: that page carries a second, decoy `<textarea>` for IME
   * composition that sorts first in the DOM and clears itself, so the generic
   * default silently watches the wrong element there.
   */
  composerSelector?: string;
  /** Fail if the site put up an error notice. Default true. */
  failOnNotice?: boolean;
}

export interface ActionVerdict {
  ok: boolean;
  /** Why it failed, phrased for a human reading a terminal. */
  reason?: string;
  state: PageState;
  siteError?: SiteErrorMatch | null;
}

/**
 * One page read covering every selector at once.
 *
 * Visibility, not mere existence: this site keeps zero-width accessibility
 * mirrors in the DOM, and treating those as "the element is there" is how a
 * click landed on the wrong row.
 */
export function buildProbeJs(selectors: string[], composerSelector = "textarea"): string {
  return `(() => {
    const wanted = ${JSON.stringify(selectors)};
    const present = {};
    for (const sel of wanted) {
      let n = 0;
      for (const el of document.querySelectorAll(sel)) {
        const r = el.getBoundingClientRect();
        if (r.width >= 2 && r.height >= 2) n++;
      }
      present[sel] = n;
    }
    const ta = document.querySelector(${JSON.stringify(composerSelector)});
    const notice = [...document.querySelectorAll('[role=alert], [class*=toast], .ant-message, [class*=notification]')]
      .filter(e => !e.closest('[class*=markdown]'))
      .map(e => (e.innerText || '').trim())
      .filter(t => t && t.length < 300)
      .join(' | ');
    return JSON.stringify({ present, composer: ta ? (ta.value || '').length : null, notice });
  })()`;
}

export async function probeState(
  tab: BrowserTab,
  selectors: string[],
  composerSelector?: string,
): Promise<PageState> {
  const res = await tab.evaluate(buildProbeJs(selectors, composerSelector));
  if (!res.ok || typeof res.value !== "string") {
    return { present: {}, composer: null, notice: "" };
  }
  try {
    const parsed = JSON.parse(res.value);
    return {
      present: parsed.present ?? {},
      composer: parsed.composer ?? null,
      notice: String(parsed.notice ?? ""),
    };
  } catch {
    return { present: {}, composer: null, notice: "" };
  }
}

/**
 * Pure: does this state satisfy the expectation? Separated from the page so the
 * rule can be tested without a browser.
 */
export function judge(state: PageState, expect: ActionExpectation): ActionVerdict {
  const siteError = expect.failOnNotice === false ? null : detectSiteError(state.notice);
  if (siteError) {
    return {
      ok: false,
      reason: `الموقع أظهر إشعاراً (${siteError.kind}): ${state.notice}`,
      state,
      siteError,
    };
  }

  for (const sel of expect.gone ?? []) {
    if ((state.present[sel] ?? 0) > 0) {
      return { ok: false, reason: `ما زال ظاهراً: ${sel}`, state, siteError: null };
    }
  }
  for (const sel of expect.appeared ?? []) {
    if ((state.present[sel] ?? 0) < 1) {
      return { ok: false, reason: `لم يظهر: ${sel}`, state, siteError: null };
    }
  }
  const any = expect.appearedAny ?? [];
  if (any.length > 0 && !any.some((sel) => (state.present[sel] ?? 0) > 0)) {
    return { ok: false, reason: `لم يظهر أيٌّ من: ${any.join(" | ")}`, state, siteError: null };
  }
  if (expect.composerEmpty === true && (state.composer ?? 0) > 0) {
    return { ok: false, reason: `المحرّر لم يفرغ (${state.composer} حرفاً)`, state, siteError: null };
  }
  if (expect.composerEmpty === false && (state.composer ?? 0) === 0) {
    return { ok: false, reason: "المحرّر فارغ وكان يُفترض أن يحمل نصاً", state, siteError: null };
  }
  return { ok: true, state, siteError: null };
}

/** Every selector this expectation mentions, so one read covers them all. */
export function selectorsOf(expect: ActionExpectation): string[] {
  return [
    ...new Set([...(expect.gone ?? []), ...(expect.appeared ?? []), ...(expect.appearedAny ?? [])]),
  ];
}

/**
 * Settle, then check — and keep checking briefly, because a slow render should
 * not be reported as a failed action. The first satisfied read wins; the last
 * unsatisfied one is what gets reported.
 */
export async function verifyAfterAction(
  tab: BrowserTab,
  expect: ActionExpectation,
  o?: { settleMs?: number; graceMs?: number },
): Promise<ActionVerdict> {
  const settle = o?.settleMs ?? SETTLE_MS;
  const grace = o?.graceMs ?? 1500;
  const selectors = selectorsOf(expect);

  // The settle guards against a premature FAILURE, not a premature success.
  //
  // Reading the page the instant after a click describes the state before the
  // click and calls the action broken — that is what the 500ms is for. But if the
  // page has already done what was asked, waiting out the rest of the settle buys
  // nothing and would put half a second on every action in the system. So we poll
  // from the start, return the moment the expectation holds, and refuse to
  // declare failure until the settle has passed.
  const start = Date.now();
  const deadline = start + Math.max(settle, grace);
  let last = judge(await probeState(tab, selectors, expect.composerSelector), expect);
  while (Date.now() < deadline) {
    if (last.ok) return last;
    // A site notice is a real answer, not a slow render — stop looking.
    if (last.siteError) return last;
    await new Promise((r) => setTimeout(r, 100));
    last = judge(await probeState(tab, selectors, expect.composerSelector), expect);
  }
  return last;
}

/** Do it, then prove it. The standing pattern for every page interaction. */
export async function actAndVerify(
  tab: BrowserTab,
  action: () => Promise<{ ok: boolean; error?: string }>,
  expect: ActionExpectation,
  o?: { settleMs?: number; graceMs?: number; what?: string },
): Promise<ActionVerdict> {
  const res = await action();
  if (!res.ok) {
    // The transport itself refused — no point asking the page what changed.
    return {
      ok: false,
      reason: `${o?.what ?? "الفعل"} لم يُنفَّذ: ${String(res.error ?? "بلا سبب")}`,
      state: { present: {}, composer: null, notice: "" },
      siteError: null,
    };
  }
  return verifyAfterAction(tab, expect, o);
}

// ---------------------------------------------------------------------------
// Generic evidence, for actions whose expectations the caller cannot state
// ---------------------------------------------------------------------------

/**
 * A cheap, site-agnostic snapshot of "where we are and what is on screen".
 *
 * `acp web call` drives arbitrary sites on behalf of a sub-agent, so it cannot
 * know what SHOULD change after a click — only the caller knows that. What it
 * can do is answer the question that actually matters: did anything change at
 * all, and did the site say something?
 *
 * Without this the sub-agent gets `{"ok":true}` for a click that landed on
 * nothing, which is the single failure this project has paid for most.
 */
export interface PageSignature {
  url: string;
  title: string;
  /** Characters in the focused-ish text field, when there is one. */
  composer: number | null;
  buttons: number;
  inputs: number;
  /** Open dialogs, dropdowns and listboxes — the usual result of a click. */
  overlays: number;
  notice: string;
}

export const SIGNATURE_JS = `(() => {
  const count = (sel) => {
    let n = 0;
    for (const el of document.querySelectorAll(sel)) {
      const r = el.getBoundingClientRect();
      if (r.width >= 2 && r.height >= 2) n++;
    }
    return n;
  };
  const ta = document.querySelector('textarea, input[type=text], [contenteditable=true]');
  return JSON.stringify({
    url: location.href,
    title: (document.title || '').slice(0, 120),
    composer: ta ? String(ta.value ?? ta.innerText ?? '').length : null,
    buttons: count('button, [role=button]'),
    inputs: count('input, textarea, select'),
    overlays: count('[role=dialog], [role=listbox], [role=menu], [class*=dropdown]:not([class*=hidden])'),
    notice: [...document.querySelectorAll('[role=alert], [class*=toast], .ant-message, [class*=notification]')]
      .filter(e => !e.closest('[class*=markdown]'))
      .map(e => (e.innerText || '').trim())
      .filter(t => t && t.length < 300)
      .join(' | '),
  });
})()`;

export async function pageSignature(tab: BrowserTab): Promise<PageSignature | null> {
  const res = await tab.evaluate(SIGNATURE_JS);
  if (!res.ok || typeof res.value !== "string") return null;
  try {
    return JSON.parse(res.value) as PageSignature;
  } catch {
    return null;
  }
}

/** What changed, in words a human or an agent can act on. Pure. */
export function describeDelta(
  before: PageSignature | null,
  after: PageSignature | null,
): string[] {
  if (!before || !after) return [];
  const out: string[] = [];
  if (before.url !== after.url) out.push("تغيّر الرابط");
  if (before.title !== after.title) out.push("تغيّر عنوان الصفحة");
  if (before.composer !== after.composer) {
    out.push(
      after.composer === 0 && (before.composer ?? 0) > 0
        ? "فرغ حقل الإدخال"
        : `تغيّر حقل الإدخال (${before.composer} ← ${after.composer})`,
    );
  }
  if (after.overlays > before.overlays) out.push("ظهرت قائمة/نافذة");
  if (after.overlays < before.overlays) out.push("أُغلقت قائمة/نافذة");
  if (after.buttons !== before.buttons) out.push(`تغيّر عدد الأزرار (${before.buttons} ← ${after.buttons})`);
  if (after.inputs !== before.inputs) out.push(`تغيّر عدد الحقول (${before.inputs} ← ${after.inputs})`);
  if (after.notice && after.notice !== before.notice) out.push(`إشعار: ${after.notice}`);
  return out;
}

/**
 * Look after the action, and keep looking briefly until something moves.
 *
 * Returns as soon as there is a difference to report, so a responsive page costs
 * almost nothing; a page that truly did not react costs the settle and then says
 * so honestly — "nothing changed" is a finding, not a gap in the report.
 */
export async function evidenceAfterAction(
  tab: BrowserTab,
  before: PageSignature | null,
  o?: { settleMs?: number },
): Promise<{ after: PageSignature | null; changed: string[]; siteError: SiteErrorMatch | null }> {
  const settle = o?.settleMs ?? SETTLE_MS;
  const deadline = Date.now() + settle;
  let after = await pageSignature(tab);
  let changed = describeDelta(before, after);
  while (changed.length === 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
    after = await pageSignature(tab);
    changed = describeDelta(before, after);
  }
  return { after, changed, siteError: detectSiteError(after?.notice ?? "") };
}
