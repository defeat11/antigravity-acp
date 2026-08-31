import { describe, it, expect } from "vitest";
import {
  judge,
  selectorsOf,
  buildProbeJs,
  SETTLE_MS,
  actAndVerify,
  describeDelta,
  SIGNATURE_JS,
} from "../../src/web/verify-action.js";
import type { PageState } from "../../src/web/verify-action.js";

const state = (o: Partial<PageState>): PageState => ({
  present: o.present ?? {},
  composer: o.composer ?? null,
  notice: o.notice ?? "",
});

describe("verify-action: act, then prove", () => {
  it("passes when what should vanish vanished and what should appear appeared", () => {
    const v = judge(
      state({ present: { "[aria-label='Stop']": 0, ".send-button": 1 }, composer: 0 }),
      { gone: ["[aria-label='Stop']"], appeared: [".send-button"], composerEmpty: true },
    );
    expect(v.ok).toBe(true);
  });

  it("names the element that refused to disappear", () => {
    const v = judge(state({ present: { ".ant-select-dropdown": 1 } }), {
      gone: [".ant-select-dropdown"],
    });
    expect(v.ok).toBe(false);
    expect(v.reason).toContain(".ant-select-dropdown");
  });

  it("catches the button that never appeared", () => {
    // Measured on this site: `.send-button` does not exist while the composer is
    // empty, so clicking it straight after typing hits nothing.
    const v = judge(state({ present: { ".send-button": 0 } }), { appeared: [".send-button"] });
    expect(v.ok).toBe(false);
    expect(v.reason).toContain(".send-button");
  });

  it("treats a zero-size element as absent", () => {
    // The probe counts only elements with a real box: this site keeps zero-width
    // accessibility mirrors in the DOM, and one of them swallowed a click.
    expect(buildProbeJs([".x"])).toContain("r.width >= 2");
  });

  it("fails on a site notice before anything else", () => {
    const v = judge(
      state({ present: { ".send-button": 1 }, notice: "You have reached the daily usage limit." }),
      { appeared: [".send-button"] },
    );
    expect(v.ok).toBe(false);
    expect(v.siteError?.kind).toBe("rate_limit");
  });

  it("can be told to ignore notices when one is expected", () => {
    const v = judge(state({ notice: "something went wrong" }), { failOnNotice: false });
    expect(v.ok).toBe(true);
  });

  it("checks the composer in both directions", () => {
    expect(judge(state({ composer: 12 }), { composerEmpty: true }).ok).toBe(false);
    expect(judge(state({ composer: 0 }), { composerEmpty: false }).ok).toBe(false);
    expect(judge(state({ composer: 0 }), { composerEmpty: true }).ok).toBe(true);
  });

  it("asks the page once for everything it needs", () => {
    expect(selectorsOf({ gone: ["a", "b"], appeared: ["b", "c"] })).toEqual(["a", "b", "c"]);
  });


});

describe("verify-action: the settle protects against a wrong FAILURE", () => {
  it("keeps the guard long enough to outlast a re-render", () => {
    // Reading the page the instant after a click describes the state before it.
    expect(SETTLE_MS).toBe(500);
  });

  it("reports a site notice as the answer, not as a slow render", () => {
    // A toast is a decision the site already made; polling past it only delays
    // telling the caller.
    const v = judge(state({ notice: "You have reached the daily usage limit." }), {
      appeared: [".send-button"],
    });
    expect(v.siteError?.kind).toBe("rate_limit");
  });
});

describe("verify-action: an action the transport refused", () => {
  it("is reported without asking the page what changed", async () => {
    // Nothing happened, so there is nothing to observe — and probing anyway
    // would blame the page for a failure that never reached it.
    const fakeTab = {
      evaluate: async () => {
        throw new Error("the page must not be probed here");
      },
    } as never;
    const v = await actAndVerify(
      fakeTab,
      async () => ({ ok: false, error: "element not found: .send-button" }),
      { composerEmpty: true },
      { what: "الإرسال" },
    );
    expect(v.ok).toBe(false);
    expect(v.reason).toContain("element not found");
    expect(v.reason).toContain("الإرسال");
  });

  it("proceeds to verification when the action itself succeeded", async () => {
    const fakeTab = {
      evaluate: async () => ({
        ok: true,
        value: JSON.stringify({ present: { ".x": 1 }, composer: 0, notice: "" }),
      }),
    } as never;
    const v = await actAndVerify(fakeTab, async () => ({ ok: true }), {
      appeared: [".x"],
      composerEmpty: true,
    });
    expect(v.ok).toBe(true);
  });
});

describe("verify-action: a selector ladder is an OR", () => {
  it("passes when any rung matched", () => {
    // The real rows matched; the zero-width [role=option] mirrors did not, and
    // demanding both failed a switch that had just worked.
    const v = judge(state({ present: { "[role=option]": 0, ".ant-select-item-option": 3 } }), {
      appearedAny: ["[role=option]", ".ant-select-item-option"],
    });
    expect(v.ok).toBe(true);
  });

  it("fails only when the whole ladder is empty, and says so", () => {
    const v = judge(state({ present: { "[role=option]": 0, ".ant-select-item-option": 0 } }), {
      appearedAny: ["[role=option]", ".ant-select-item-option"],
    });
    expect(v.ok).toBe(false);
    expect(v.reason).toContain("لم يظهر أيٌّ من");
  });

  it("still demands every selector listed under `appeared`", () => {
    expect(judge(state({ present: { a: 1, b: 0 } }), { appeared: ["a", "b"] }).ok).toBe(false);
  });

  it("asks the page about ladder selectors too", () => {
    expect(selectorsOf({ appearedAny: ["x", "y"], gone: ["z"] })).toEqual(["z", "x", "y"]);
  });
});

describe("verify-action: generic evidence for arbitrary sites", () => {
  const sig = (o: Partial<import("../../src/web/verify-action.js").PageSignature>) => ({
    url: o.url ?? "https://x.test/",
    title: o.title ?? "t",
    composer: o.composer ?? null,
    buttons: o.buttons ?? 3,
    inputs: o.inputs ?? 1,
    overlays: o.overlays ?? 0,
    notice: o.notice ?? "",
  });

  it("reports nothing changed when nothing changed", () => {
    // `{"ok":true}` with no change behind it is the failure this closes: the
    // caller must be able to tell a click that worked from one that hit nothing.
    expect(describeDelta(sig({}), sig({}))).toEqual([]);
  });

  it("names a navigation", () => {
    expect(describeDelta(sig({}), sig({ url: "https://x.test/c/1" }))).toContain("تغيّر الرابط");
  });

  it("recognises a send: the input emptied", () => {
    expect(describeDelta(sig({ composer: 40 }), sig({ composer: 0 }))).toContain("فرغ حقل الإدخال");
  });

  it("recognises a dropdown opening and closing", () => {
    expect(describeDelta(sig({ overlays: 0 }), sig({ overlays: 1 }))).toContain("ظهرت قائمة/نافذة");
    expect(describeDelta(sig({ overlays: 1 }), sig({ overlays: 0 }))).toContain("أُغلقت قائمة/نافذة");
  });

  it("surfaces a new notice and ignores one that was already there", () => {
    expect(describeDelta(sig({}), sig({ notice: "limit reached" }))[0]).toContain("إشعار:");
    expect(describeDelta(sig({ notice: "old" }), sig({ notice: "old" }))).toEqual([]);
  });

  it("says nothing at all when a signature could not be read", () => {
    // Silence beats invention: an unreadable page must not produce claims.
    expect(describeDelta(null, sig({}))).toEqual([]);
    expect(describeDelta(sig({}), null)).toEqual([]);
  });

  it("counts only elements with a real box", () => {
    expect(SIGNATURE_JS).toContain("r.width >= 2");
  });
});
