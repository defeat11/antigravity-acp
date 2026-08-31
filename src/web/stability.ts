/**
 * "The text stopped changing" — as a rule anyone can use, not a habit one file
 * happens to have.
 *
 * This logic was measured against a live streaming answer and lived inside the
 * Qwen consultation path. Everything else driving a browser had nothing: the
 * generic `wait` primitive offered a raw JavaScript predicate and a timeout, so
 * an agent that wanted "wait until the reply finishes" and could not express it
 * wrote `--until "false" --timeout 120000` — a blind sleep in the costume of a
 * condition, which burned two minutes on purpose.
 *
 * The council's verdict was that the missing signal was the cause, and that
 * banning the workaround would only move it: `1===1` and `Date.now()>0` defeat
 * any static check, so the fix is to make the honest path the easy one.
 *
 * TWO signals, never one. Stability alone declares completion whenever a stream
 * pauses, and a paused stream looks exactly like a finished one. So a busy
 * indicator — the Stop button, a spinner, whatever the site shows while it is
 * working — must also be absent. Trusting stability by itself is what once
 * archived a 52-character fragment as a complete answer.
 */

/** Never accept less than this much silence, however smooth the stream looked. */
export const STABILITY_FLOOR_MS = 500;

/** Never demand more than this, however jittery it looked. */
export const STABILITY_CEILING_MS = 4000;

/**
 * Absolute cap on any caller-supplied ceiling. A window is a safety net, not a
 * substitute for the inactivity deadline: past this the wait is no longer
 * "prove it finished", it is a blind sleep, and every caller here already has a
 * real deadline above it.
 */
export const STABILITY_MAX_CEILING_MS = 20000;

/**
 * Does the text stop in a place a finished answer would not stop in?
 *
 * A stream cut mid-flight ends inside a token — "…بالض", "…138\n13". A finished
 * one usually lands on punctuation, a bracket, an emoji. This is a WEAK signal:
 * plenty of complete answers end on a bare word ("DONE", "…قبل الإطلاق"), which
 * is why it may only ever BUY MORE PATIENCE, never reject an answer. Used as a
 * gate it would discard good work; used as a grace it costs a few seconds on
 * the answers where a truncation would otherwise be undetectable.
 */
export function tailLooksUnfinished(text: string): boolean {
  const t = text.replace(/\s+$/u, "");
  if (!t) return false;
  return /[\p{L}\p{N},،:;؛\-–—/\\]$/u.test(t);
}

/**
 * How long the text must hold still, derived from how this particular stream has
 * actually behaved.
 *
 * A fixed number is either too slow for a smooth stream or too short for a
 * stuttering one. Twice the largest gap observed so far adapts to both: a steady
 * stream is accepted quickly, and one that has already shown a 900ms pause buys
 * the patience it demonstrated it needs.
 */
export function stabilityWindowMs(
  maxGrowthGap: number,
  o?: { floorMs?: number; ceilingMs?: number },
): number {
  const floor = Math.max(0, o?.floorMs ?? STABILITY_FLOOR_MS);
  const ceiling = Math.min(
    STABILITY_MAX_CEILING_MS,
    Math.max(floor, o?.ceilingMs ?? STABILITY_CEILING_MS),
  );
  return Math.min(ceiling, Math.max(floor, maxGrowthGap * 2));
}

export interface StabilityState {
  /** The text as of the last observation. */
  text: string;
  /** When the text last GREW. Zero until the first character arrives. */
  lastGrowthAt: number;
  /** The largest gap between two growths seen so far. */
  maxGrowthGap: number;
  /** When the current unchanged run began. Zero while the site says it is busy. */
  settledSince: number;
  /** Consecutive observations in which the site did NOT look busy. */
  idleStreak: number;
  /** When the site was last seen busy. Zero if it never was. */
  lastBusyAt: number;
}

export function initialState(): StabilityState {
  return {
    text: "",
    lastGrowthAt: 0,
    maxGrowthGap: 0,
    settledSince: 0,
    idleStreak: 0,
    lastBusyAt: 0,
  };
}

/**
 * Fold one observation into the state. Pure, so the rule is testable without a
 * browser and behaves identically wherever it is used.
 *
 * `busy` belongs HERE, not only in the final check. The quiet run has to be
 * quiet on BOTH signals for its whole length: a window that started while the
 * page was idle, was interrupted by the page saying "still working", and was
 * then cashed in on one later idle read, proves nothing about the stretch in
 * between. That is not a hypothetical — it is how a reply reached a real user
 * cut off mid-word: the text had merely paused, the busy flag blinked, and the
 * unchanged-text clock had never been reset by the busy readings between.
 *
 * Callers with no busy indicator at all may omit it; they get the old
 * text-only behaviour, and the docs above say why that is weaker.
 */
export function observe(
  state: StabilityState,
  text: string,
  now: number,
  busy?: boolean,
): StabilityState {
  const isBusy = busy === true;
  const idleStreak = isBusy ? 0 : state.idleStreak + 1;
  const lastBusyAt = isBusy ? now : state.lastBusyAt;

  if (text === state.text) {
    return {
      ...state,
      idleStreak,
      lastBusyAt,
      settledSince: isBusy ? 0 : state.settledSince || now,
    };
  }

  const grew = text.length > state.text.length;
  // The wait BEFORE the first character is the model thinking, not the stream
  // stuttering. Counting it as a gap doubled the required window on every short
  // answer and made the adaptive rule slower than the fixed one it replaced.
  const maxGrowthGap =
    grew && state.lastGrowthAt ? Math.max(state.maxGrowthGap, now - state.lastGrowthAt) : state.maxGrowthGap;

  return {
    text,
    lastGrowthAt: grew ? now : state.lastGrowthAt,
    maxGrowthGap,
    settledSince: isBusy ? 0 : now,
    idleStreak,
    lastBusyAt,
  };
}

export interface SettleCheck {
  settled: boolean;
  /** The window this stream earned, for reporting when it does not settle. */
  requiredMs: number;
  /** How long it has actually held still. */
  quietMs: number;
  /** Consecutive not-busy reads behind this verdict. */
  idleSamples: number;
  /** True when the window was widened because the text ends mid-token. */
  graced: boolean;
}

/**
 * Is it finished? Requires content, an idle busy indicator, and enough silence.
 *
 * `busy` is the site saying "I am still working". When a site offers no such
 * indicator the caller must say so explicitly rather than have it assumed — an
 * unstated assumption here is exactly how a paused stream gets filed as a
 * finished one.
 */
export function isSettled(
  state: StabilityState,
  now: number,
  busy: boolean,
  o?: {
    floorMs?: number;
    ceilingMs?: number;
    /**
     * How many consecutive not-busy reads are required. One is a single sample
     * of a flaky DOM flag; a site that re-renders its Stop button drops it for
     * a frame, and one unlucky read then ends the wait mid-answer.
     */
    minIdleSamples?: number;
    /**
     * Minimum window to demand when the text ends mid-token. Bounded by the
     * ceiling, so this can slow an answer down but can never hang it.
     */
    unfinishedGraceMs?: number;
  },
): SettleCheck {
  const earned = stabilityWindowMs(state.maxGrowthGap, o);
  const ceiling = stabilityWindowMs(Number.MAX_SAFE_INTEGER, o);
  const graced = Boolean(o?.unfinishedGraceMs) && tailLooksUnfinished(state.text);
  const requiredMs = graced ? Math.min(ceiling, Math.max(earned, o!.unfinishedGraceMs!)) : earned;
  const quietMs = state.settledSince ? now - state.settledSince : 0;
  const idleSamples = state.idleStreak;
  const settled =
    !busy &&
    state.text.length > 0 &&
    quietMs >= requiredMs &&
    idleSamples >= Math.max(1, o?.minIdleSamples ?? 1);
  return { settled, requiredMs, quietMs, idleSamples, graced };
}
