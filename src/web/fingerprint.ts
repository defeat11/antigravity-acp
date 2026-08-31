import { createHash } from "node:crypto";

export interface MarkerObservation {
  selector: string;
  present: boolean;
  visible: number;
  tag: string | null;
}

export interface Fingerprint {
  host: string;
  hash: string;
  capturedAt: string;
  markers: MarkerObservation[];
}

export const DEFAULT_MARKERS: string[] = [
  "textarea",
  "input",
  "button",
  "form",
  "[contenteditable]",
];

export function bucketVisibleCount(visible: number): string {
  if (visible <= 0) return "0";
  if (visible === 1) return "1";
  if (visible <= 5) return "2-5";
  if (visible <= 20) return "6-20";
  return "21+";
}

export function computeHash(markers: MarkerObservation[]): string {
  const sorted = [...markers].sort((a, b) => a.selector.localeCompare(b.selector));
  const normalized = sorted
    .map(
      (m) =>
        `${m.selector}|${m.present}|${m.tag ?? ""}|${bucketVisibleCount(m.visible)}`
    )
    .join("\n");
  return createHash("sha1").update(normalized).digest("hex");
}

export function compareFingerprints(
  baseline: Fingerprint,
  current: Fingerprint
): {
  match: boolean;
  changed: { selector: string; from: MarkerObservation; to: MarkerObservation }[];
} {
  const currentMap = new Map<string, MarkerObservation>();
  for (const m of current.markers) {
    currentMap.set(m.selector, m);
  }

  const changed: {
    selector: string;
    from: MarkerObservation;
    to: MarkerObservation;
  }[] = [];

  for (const baseMarker of baseline.markers) {
    const currMarker = currentMap.get(baseMarker.selector) ?? {
      selector: baseMarker.selector,
      present: false,
      visible: 0,
      tag: null,
    };

    const presentDiff = baseMarker.present !== currMarker.present;
    const tagDiff = baseMarker.tag !== currMarker.tag;
    const bucketDiff =
      bucketVisibleCount(baseMarker.visible) !== bucketVisibleCount(currMarker.visible);

    if (presentDiff || tagDiff || bucketDiff) {
      changed.push({
        selector: baseMarker.selector,
        from: baseMarker,
        to: currMarker,
      });
    }
  }

  return {
    match: changed.length === 0,
    changed,
  };
}
