import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  computeHash,
  bucketVisibleCount,
  compareFingerprints,
  DEFAULT_MARKERS,
  type Fingerprint,
  type MarkerObservation,
} from "../../src/web/fingerprint.js";
import {
  getFingerprint,
  putFingerprint,
  dropFingerprint,
  readFingerprints,
  getFingerprintsPath,
} from "../../src/web/state.js";

describe("web/fingerprint.ts - pure logic", () => {
  it("DEFAULT_MARKERS includes standard chat markers", () => {
    expect(DEFAULT_MARKERS).toContain("textarea");
    expect(DEFAULT_MARKERS).toContain("input");
    expect(DEFAULT_MARKERS).toContain("button");
    expect(DEFAULT_MARKERS).toContain("form");
    expect(DEFAULT_MARKERS).toContain("[contenteditable]");
  });

  it("bucketVisibleCount correctly buckets visible counts", () => {
    expect(bucketVisibleCount(0)).toBe("0");
    expect(bucketVisibleCount(-1)).toBe("0");
    expect(bucketVisibleCount(1)).toBe("1");
    expect(bucketVisibleCount(2)).toBe("2-5");
    expect(bucketVisibleCount(5)).toBe("2-5");
    expect(bucketVisibleCount(6)).toBe("6-20");
    expect(bucketVisibleCount(20)).toBe("6-20");
    expect(bucketVisibleCount(21)).toBe("21+");
    expect(bucketVisibleCount(100)).toBe("21+");
  });

  it("computeHash is order-independent and stable for equal inputs", () => {
    const m1: MarkerObservation = { selector: "button", present: true, visible: 2, tag: "button" };
    const m2: MarkerObservation = { selector: "input", present: true, visible: 1, tag: "input" };

    const hash1 = computeHash([m1, m2]);
    const hash2 = computeHash([m2, m1]);

    expect(hash1).toBe(hash2);
    expect(hash1).toMatch(/^[0-9a-f]{40}$/);
  });

  it("visible-count bucketing produces same hash for 3 vs 4 visible elements, but different for 1 vs 10", () => {
    const base: MarkerObservation[] = [
      { selector: "button", present: true, visible: 3, tag: "button" },
    ];
    const sameBucket: MarkerObservation[] = [
      { selector: "button", present: true, visible: 4, tag: "button" },
    ];
    const diffBucket: MarkerObservation[] = [
      { selector: "button", present: true, visible: 10, tag: "button" },
    ];

    expect(computeHash(base)).toBe(computeHash(sameBucket));
    expect(computeHash(base)).not.toBe(computeHash(diffBucket));
  });

  it("computeHash changes when a marker's presence flips", () => {
    const present: MarkerObservation[] = [
      { selector: "button", present: true, visible: 1, tag: "button" },
    ];
    const absent: MarkerObservation[] = [
      { selector: "button", present: false, visible: 0, tag: null },
    ];

    expect(computeHash(present)).not.toBe(computeHash(absent));
  });

  it("compareFingerprints reports changed markers with from/to, and match=false only when changed", () => {
    const baseline: Fingerprint = {
      host: "example.com",
      hash: "h1",
      capturedAt: "2026-08-05T00:00:00Z",
      markers: [
        { selector: "button", present: true, visible: 2, tag: "button" },
        { selector: "textarea", present: true, visible: 1, tag: "textarea" },
      ],
    };

    const identicalCurrent: Fingerprint = {
      host: "example.com",
      hash: "h1",
      capturedAt: "2026-08-05T01:00:00Z",
      markers: [
        { selector: "button", present: true, visible: 4, tag: "button" }, // 2 vs 4 -> same bucket "2-5"
        { selector: "textarea", present: true, visible: 1, tag: "textarea" },
      ],
    };

    const cmpMatch = compareFingerprints(baseline, identicalCurrent);
    expect(cmpMatch.match).toBe(true);
    expect(cmpMatch.changed).toHaveLength(0);

    const changedCurrent: Fingerprint = {
      host: "example.com",
      hash: "h2",
      capturedAt: "2026-08-05T01:00:00Z",
      markers: [
        { selector: "button", present: false, visible: 0, tag: null },
        { selector: "textarea", present: true, visible: 1, tag: "textarea" },
      ],
    };

    const cmpDiff = compareFingerprints(baseline, changedCurrent);
    expect(cmpDiff.match).toBe(false);
    expect(cmpDiff.changed).toHaveLength(1);
    expect(cmpDiff.changed[0].selector).toBe("button");
    expect(cmpDiff.changed[0].from.present).toBe(true);
    expect(cmpDiff.changed[0].to.present).toBe(false);
  });
});

describe("web/state.ts - fingerprint storage & resilience", () => {
  let tmpHome: string;
  let origHome: string | undefined;
  let origUserProfile: string | undefined;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "acp-fp-state-test-"));
    origHome = process.env.HOME;
    origUserProfile = process.env.USERPROFILE;
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;
  });

  afterEach(() => {
    process.env.HOME = origHome;
    process.env.USERPROFILE = origUserProfile;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("round-trips putFingerprint/getFingerprint/dropFingerprint and returns null for unknown host", () => {
    expect(readFingerprints()).toEqual({});
    expect(getFingerprint("example.com")).toBeNull();

    const fp: Fingerprint = {
      host: "example.com",
      hash: "abc123hash",
      capturedAt: "2026-08-05T00:00:00Z",
      markers: [{ selector: "textarea", present: true, visible: 1, tag: "textarea" }],
    };

    putFingerprint("example.com", fp);

    const retrieved = getFingerprint("example.com");
    expect(retrieved).not.toBeNull();
    expect(retrieved?.hash).toBe("abc123hash");
    expect(retrieved?.markers).toHaveLength(1);

    dropFingerprint("example.com");
    expect(getFingerprint("example.com")).toBeNull();
  });

  it("survives corrupt json file without throwing", () => {
    const path = getFingerprintsPath();
    putFingerprint("test.com", {
      host: "test.com",
      hash: "h",
      capturedAt: "now",
      markers: [],
    });

    writeFileSync(path, "{ corrupt json text...", "utf8");

    expect(readFingerprints()).toEqual({});
    expect(getFingerprint("test.com")).toBeNull();
  });
});
