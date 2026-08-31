import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  THINKING_MODES,
  normalizeMode,
  modeTimeoutMs,
  TRIGGER_LADDER,
  OPTION_LADDER,
  MODEL_LADDER,
  COMPOSER_READY_JS,
  QWEN_FINGERPRINT_MARKERS,
  WidgetError,
  pendingRestorePath,
  readPendingRestore,
  writePendingRestore,
  clearPendingRestore,
} from "../../src/web/widgets/qwen-composer.js";

describe("qwen-composer: mode parsing", () => {
  it("accepts the three real modes in any casing", () => {
    expect(normalizeMode("fast")).toBe("Fast");
    expect(normalizeMode("AUTO")).toBe("Auto");
    expect(normalizeMode("Thinking")).toBe("Thinking");
  });

  it("reads only the first line — the widget renders a subtitle under the mode", () => {
    expect(normalizeMode("Thinking\nQwen3.8-Max")).toBe("Thinking");
  });

  it("rejects anything it does not know instead of guessing", () => {
    expect(normalizeMode("Turbo")).toBeNull();
    expect(normalizeMode("")).toBeNull();
    expect(normalizeMode(null)).toBeNull();
    expect(normalizeMode("Qwen3.8-Max")).toBeNull();
  });
});

describe("qwen-composer: the wait budget follows the mode", () => {
  it("gives a thinking model room and keeps Fast tight", () => {
    expect(modeTimeoutMs("Thinking")).toBe(180000);
    expect(modeTimeoutMs("Auto")).toBe(120000);
    expect(modeTimeoutMs("Fast")).toBe(90000);
  });

  it("falls back to the tightest budget when the mode is unknown", () => {
    // An unknown mode must not silently buy a 3-minute wait.
    expect(modeTimeoutMs(null)).toBe(90000);
    expect(modeTimeoutMs("something else")).toBe(90000);
  });
});

describe("qwen-composer: selector ladder", () => {
  it("puts meaningful rungs before vendor class names", () => {
    // Meaningful = the site's own named class or an ARIA role. Both say what the
    // element IS; `.ant-select-*` only says which library rendered it.
    const isVendor = (s: string) => s.includes("ant-");
    expect(isVendor(TRIGGER_LADDER[0]!)).toBe(false);
    expect(isVendor(OPTION_LADDER[0]!)).toBe(false);

    // Vendor rungs are kept — they are the ones that work on the live site today
    // — but strictly after every meaningful one.
    const firstVendor = TRIGGER_LADDER.findIndex(isVendor);
    const lastMeaningful = TRIGGER_LADDER.map(isVendor).lastIndexOf(false);
    expect(firstVendor).toBeGreaterThan(lastMeaningful);
  });

  it("leads with the widget ROOT, not an inner node", () => {
    // The first ladder led with [role=combobox], which this site does not use,
    // so it fell through to `.ant-select-selector` — a node that reads the mode
    // correctly but does not open the dropdown when clicked. Reading a widget
    // and operating it are not the same capability.
    expect(TRIGGER_LADDER[0]).toBe(".qwen-select-thinking");
  });

  it("gives the model selector its own ladder", () => {
    // The model is a different widget with different markup; sharing the mode's
    // ladder is how the tool reported the model as "unknown".
    expect(MODEL_LADDER[0]).toContain("model-selector");
    expect(MODEL_LADDER).not.toEqual(TRIGGER_LADDER);
  });

  it("readiness does not hang on a single vendor class", () => {
    // The old gate was `!!document.querySelector('.ant-select-selection-item')`,
    // which is both a single point of failure and an assumption about ordering.
    expect(COMPOSER_READY_JS).toContain("role=combobox");
    expect(COMPOSER_READY_JS).toContain("textarea");
  });

  it("exposes every load-bearing selector to the fingerprint system", () => {
    for (const sel of [...TRIGGER_LADDER, ...OPTION_LADDER]) {
      expect(QWEN_FINGERPRINT_MARKERS).toContain(sel);
    }
    // The send button and the answer container matter just as much.
    expect(QWEN_FINGERPRINT_MARKERS).toContain(".send-button");
  });
});

describe("qwen-composer: a widget failure names what broke", () => {
  it("carries the rungs it tried so a stale selector is identifiable", () => {
    const err = new WidgetError("nothing matched", TRIGGER_LADDER);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("WidgetError");
    expect(err.rungsTried).toEqual(TRIGGER_LADDER);
  });
});

describe("qwen-composer: the user's mode survives a crash", () => {
  let home = "";
  let prevHome: string | undefined;
  let prevProfile: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "acp-widget-"));
    prevHome = process.env.HOME;
    prevProfile = process.env.USERPROFILE;
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    mkdirSync(join(home, ".acp"), { recursive: true });
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevProfile;
    rmSync(home, { recursive: true, force: true });
  });

  it("writes the user's own mode and reads it back", () => {
    expect(readPendingRestore()).toBeNull();
    writePendingRestore("Fast");
    const pending = readPendingRestore();
    expect(pending?.mode).toBe("Fast");
    expect(pending?.pid).toBe(process.pid);
    expect(existsSync(pendingRestorePath())).toBe(true);
  });

  it("forgets the marker only when told to", () => {
    writePendingRestore("Auto");
    clearPendingRestore();
    expect(readPendingRestore()).toBeNull();
    // Clearing an absent marker is not an error — a repaired state is the goal,
    // not a bookkeeping ceremony.
    expect(() => clearPendingRestore()).not.toThrow();
  });

  it("treats a corrupt or unknown marker as no marker", () => {
    writeFileSync(pendingRestorePath(), "{not json", "utf8");
    expect(readPendingRestore()).toBeNull();
    writeFileSync(pendingRestorePath(), JSON.stringify({ mode: "Turbo" }), "utf8");
    expect(readPendingRestore()).toBeNull();
  });

  it("covers every mode it might have to restore", () => {
    for (const mode of THINKING_MODES) {
      writePendingRestore(mode);
      expect(readPendingRestore()?.mode).toBe(mode);
    }
  });
});
