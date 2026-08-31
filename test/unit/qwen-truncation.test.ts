import { describe, it, expect } from "vitest";
import {
  initialState,
  observe,
  isSettled,
  tailLooksUnfinished,
  STABILITY_MAX_CEILING_MS,
  type StabilityState,
} from "../../src/web/stability.js";
import { qwenSettleOptions } from "../../src/qwen-cli.js";

/**
 * The truncation that reached a real member, replayed.
 *
 * Archived in ~/.acp/qwen.db as 2026-08-16T15:22:44.767Z: status ok, Thinking
 * mode, 201 characters, ending "…مهاراتك الحالية بالض" — mid-word. A model does
 * not stop mid-word, so the answer was still being generated when the poll loop
 * filed it as complete. Two more rows show the same shape: a count to 150 filed
 * at "…137\n138\n13", and a 77-character reply cut mid-sentence.
 *
 * These tests drive the SAME pure functions the poll loop now uses, at the same
 * 250ms poll interval, so the rule can be exercised without a browser.
 */

const POLL_MS = 250;

interface Sample {
  t: number;
  text: string;
  busy: boolean;
}

/** Replay a timeline through the current rule; returns what would be filed. */
function replay(samples: Sample[], opts: Parameters<typeof isSettled>[3]) {
  let s: StabilityState = initialState();
  for (const smp of samples) {
    s = observe(s, smp.text, smp.t, smp.busy);
    const check = isSettled(s, smp.t, smp.busy, opts);
    if (check.settled) return { acceptedAt: smp.t, text: smp.text, check };
  }
  return { acceptedAt: null as number | null, text: null as string | null, check: null };
}

/**
 * The rule as it stood at 9cb3c82, so the timeline is shown to reproduce the
 * real bug rather than merely to pass with the new numbers. Two defects: the
 * quiet clock was never reset by a busy reading, and the window was capped at
 * 4000ms in Thinking mode.
 */
function replayLegacy(samples: Sample[], ceilingMs: number) {
  let settledText = "";
  let settledSince = 0;
  let lastGrowthAt = 0;
  let maxGrowthGap = 0;
  let lastLen = 0;
  for (const smp of samples) {
    if (smp.text.length > lastLen) {
      if (lastGrowthAt) maxGrowthGap = Math.max(maxGrowthGap, smp.t - lastGrowthAt);
      lastGrowthAt = smp.t;
      lastLen = smp.text.length;
    }
    if (!smp.busy && smp.text) {
      if (smp.text !== settledText) {
        settledText = smp.text;
        settledSince = smp.t;
        continue;
      }
      const needed = Math.min(ceilingMs, Math.max(500, maxGrowthGap * 2));
      if (smp.t - settledSince < needed) continue;
      return { acceptedAt: smp.t, text: smp.text };
    }
  }
  return { acceptedAt: null as number | null, text: null as string | null };
}

function stream(from: number, to: number, opts: {
  start: number;
  perTick: number;
  busy: boolean;
  build: (n: number) => string;
  charsAt: (t: number) => number;
}): Sample[] {
  const out: Sample[] = [];
  for (let t = from; t <= to; t += POLL_MS) {
    out.push({ t, text: opts.build(opts.charsAt(t)), busy: opts.busy });
  }
  return out;
}

const body = (n: number) => "ا".repeat(Math.max(0, n - 1)) + (n > 0 ? "ض" : "");

const FINAL_TEXT = "تم.";

/**
 * The incident timeline.
 *
 * Reasoning is silent until 60s; the answer streams to 201 characters; then the
 * page goes quiet AND drops its Stop button for `pauses[0]` milliseconds while
 * the answer is still coming; each further pause does the same later on. After
 * the last pause the answer finishes for real and the page stays idle.
 */
function incidentTimeline(pauses: number[]): {
  samples: Sample[];
  lastGrowthAt: number;
  /** What the page showed during the first false finish — the truncated prefix. */
  prefix: string;
} {
  const samples: Sample[] = [];
  for (let t = 0; t < 60000; t += POLL_MS) samples.push({ t, text: "", busy: true });

  let chars = 0;
  let t = 60000;
  // 0 -> 201 chars, smooth, Stop button up.
  for (; t <= 61200; t += POLL_MS) {
    chars = Math.round(((t - 60000) / 1200) * 201);
    samples.push({ t, text: body(chars), busy: true });
  }

  const prefix = body(chars);

  for (const pauseMs of pauses) {
    // The false finish: no growth, and the busy flag reads FALSE the whole time.
    const until = t + pauseMs;
    for (; t <= until; t += POLL_MS) samples.push({ t, text: body(chars), busy: false });
    // It was never finished: more of the answer arrives.
    const resume = t;
    for (; t <= resume + 2000; t += POLL_MS) {
      chars = Math.round(chars + POLL_MS / 4);
      samples.push({ t, text: body(chars), busy: true });
    }
  }

  // Genuinely done: quiet and idle from here on. The final text lands on this
  // first idle sample, so this is the moment the answer really stopped growing.
  const lastGrowthAt = t;
  for (; t <= lastGrowthAt + 60000; t += POLL_MS) {
    samples.push({ t, text: body(chars) + FINAL_TEXT, busy: false });
  }
  return { samples, lastGrowthAt, prefix };
}

describe("qwen truncation: the archived incident", () => {
  const opts = qwenSettleOptions("Thinking");

  it("REPRODUCES the bug under the old rule: files the mid-word prefix", () => {
    const { samples, prefix } = incidentTimeline([5600]);
    const got = replayLegacy(samples, 4000);
    expect(got.text).toBe(prefix);
    expect(got.text!.endsWith("ض")).toBe(true); // cut mid-word, exactly as archived
    expect(got.acceptedAt).toBeLessThan(66000);
  });

  it("no longer settles on the prefix — it waits and files the whole answer", () => {
    const { samples, prefix } = incidentTimeline([5600]);
    const got = replay(samples, opts);
    expect(got.text).not.toBe(prefix);
    expect(got.text).toContain(FINAL_TEXT);
  });

  it("survives a LONGER second pause, because the first one taught it the jitter", () => {
    // This is what the 4000ms cap was destroying: the window is twice the
    // largest pause the stream has already shown, so a stream that stalled 5.6s
    // once is given 11.2s the next time. The old ceiling threw that measurement
    // away and truncated on the second pause too.
    const timeline = incidentTimeline([5600, 9000]);
    expect(replayLegacy(timeline.samples, 4000).text).toBe(timeline.prefix);
    expect(replay(timeline.samples, opts).text).toContain(FINAL_TEXT);
  });

  it("still files a complete answer once the page is truly idle, bounded by the ceiling", () => {
    const { samples, lastGrowthAt } = incidentTimeline([5600]);
    const got = replay(samples, opts);
    expect(got.acceptedAt).not.toBeNull();
    // A stream that stalled 5.6s buys a ~11.2s proof window; the ceiling caps it.
    expect(got.acceptedAt! - lastGrowthAt).toBeLessThanOrEqual(opts.ceilingMs + POLL_MS);
  });
});

describe("qwen truncation: the two defects, isolated", () => {
  const opts = qwenSettleOptions("Thinking");

  it("a busy reading inside the quiet window voids the window", () => {
    let s = initialState();
    s = observe(s, "answer.", 1000, true);
    s = observe(s, "answer.", 1250, false); // quiet run starts here
    s = observe(s, "answer.", 5000, true); // the site says it is still working
    // Old code kept settledSince at 1250 and would accept on this one idle read.
    s = observe(s, "answer.", 5250, false);
    expect(isSettled(s, 5250, false, opts).settled).toBe(false);
    expect(s.settledSince).toBe(5250);
  });

  it("one lucky idle sample is not a verdict: three in a row are required", () => {
    let s = initialState();
    s = observe(s, "answer.", 1000, true);
    for (let t = 1250; t <= 20000; t += 250) s = observe(s, "answer.", t, false);
    expect(qwenSettleOptions("Thinking").minIdleSamples).toBe(3);

    let flick = initialState();
    flick = observe(flick, "answer.", 1000, true);
    flick = observe(flick, "answer.", 1250, false);
    flick = observe(flick, "answer.", 1500, true);
    flick = observe(flick, "answer.", 20000, false); // a single idle read, long after
    expect(isSettled(flick, 20000, false, opts).settled).toBe(false);
  });
});

describe("qwen truncation: the cost side — finished replies must not hang", () => {
  it("a finished reply ending in punctuation settles within ~2s of its last token", () => {
    const samples: Sample[] = [];
    for (let t = 0; t <= 3000; t += POLL_MS) {
      const n = Math.round((t / 3000) * 300);
      samples.push({ t, text: "ا".repeat(n) + (t === 3000 ? "." : ""), busy: t < 3000 });
    }
    for (let t = 3250; t <= 40000; t += POLL_MS) {
      samples.push({ t, text: "ا".repeat(300) + ".", busy: false });
    }
    const got = replay(samples, qwenSettleOptions("Thinking"));
    expect(got.acceptedAt).not.toBeNull();
    expect(got.acceptedAt! - 3000).toBeLessThanOrEqual(2500);
  });

  it("a short unpunctuated reply pays the grace once and then settles", () => {
    // "OK" and "DONE" are real, complete answers in the archive; they must cost
    // seconds, never a timeout.
    const samples: Sample[] = [{ t: 0, text: "", busy: true }, { t: 250, text: "OK", busy: true }];
    for (let t = 500; t <= 60000; t += POLL_MS) samples.push({ t, text: "OK", busy: false });
    const got = replay(samples, qwenSettleOptions("Thinking"));
    expect(got.acceptedAt).not.toBeNull();
    expect(got.acceptedAt!).toBeLessThanOrEqual(7000);
  });

  it("the grace can be switched off without touching the code", () => {
    const prev = process.env.ACP_QWEN_TAIL_GRACE_MS;
    process.env.ACP_QWEN_TAIL_GRACE_MS = "0";
    try {
      expect(qwenSettleOptions("Thinking").unfinishedGraceMs).toBe(0);
    } finally {
      if (prev === undefined) delete process.env.ACP_QWEN_TAIL_GRACE_MS;
      else process.env.ACP_QWEN_TAIL_GRACE_MS = prev;
    }
  });
});

describe("qwen settle options", () => {
  it("gives Thinking more rope than Fast, and both stay under the absolute cap", () => {
    expect(qwenSettleOptions("Thinking").ceilingMs).toBeGreaterThan(
      qwenSettleOptions("Fast").ceilingMs,
    );
    for (const mode of ["Thinking", "Fast", null, undefined]) {
      const o = qwenSettleOptions(mode as string | null);
      expect(o.ceilingMs).toBeLessThanOrEqual(STABILITY_MAX_CEILING_MS);
      expect(o.floorMs).toBeLessThan(o.ceilingMs);
    }
  });

  it("recognises the archived tails as mid-token", () => {
    expect(tailLooksUnfinished("…مهاراتك الحالية بالض")).toBe(true);
    expect(tailLooksUnfinished("136\n137\n138\n13")).toBe(true);
    expect(tailLooksUnfinished("جاهز للعمل.")).toBe(false);
    expect(tailLooksUnfinished("تمام! 🚀")).toBe(false);
    expect(tailLooksUnfinished("")).toBe(false);
  });
});
