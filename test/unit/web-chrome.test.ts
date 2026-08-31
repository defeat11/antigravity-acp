import { describe, it, expect } from "vitest";
import { findExtensionProfileDirectory } from "../../src/web/chrome.js";

describe("web/chrome.ts - extension profile detection", () => {
  it("honours the explicit override", () => {
    expect(findExtensionProfileDirectory({ ACP_CHROME_PROFILE_DIRECTORY: "Profile 7" } as any)).toBe(
      "Profile 7",
    );
  });

  it("returns null when there is no Chrome user data directory to scan", () => {
    expect(findExtensionProfileDirectory({ LOCALAPPDATA: "" } as any)).toBeNull();
  });
});
import { join, sep } from "node:path";
import {
  DEFAULT_PORT,
  profileDir,
  chromeCandidates,
  buildChromeArgs,
  FIRST_RUN_NOTICE,
} from "../../src/web/chrome.js";
import { listTargets, browserWsUrl, CdpConnection, attachToPage } from "../../src/web/cdp.js";

describe("web/chrome.ts", () => {
  it("buildChromeArgs includes port, profileDir and places startUrl last", () => {
    const args = buildChromeArgs({
      port: 9333,
      profileDir: "/tmp/profile",
      startUrl: "https://example.com",
    });
    expect(args).toContain("--remote-debugging-port=9333");
    expect(args).toContain("--user-data-dir=/tmp/profile");
    expect(args[args.length - 1]).toBe("https://example.com");
  });

  it("buildChromeArgs contains NONE of the forbidden flags", () => {
    const forbidden = [
      "--headless",
      "--enable-automation",
      "--disable-blink-features=AutomationControlled",
      "--disable-extensions",
      "--incognito",
      "--disable-gpu",
      "--remote-allow-origins",
      "--no-sandbox",
    ];

    const args = buildChromeArgs({
      port: DEFAULT_PORT,
      profileDir: "/tmp/profile",
      startUrl: "https://example.com",
    });

    for (const flag of forbidden) {
      expect(args).not.toContain(flag);
    }

    for (const arg of args) {
      expect(arg.startsWith("--headless")).toBe(false);
    }
  });

  it("chromeCandidates win32 returns ACP_CHROME_PATH first and includes LOCALAPPDATA path", () => {
    const candidates = chromeCandidates("win32", {
      ACP_CHROME_PATH: "X:\\c.exe",
      LOCALAPPDATA: "L",
    });
    expect(candidates[0]).toBe("X:\\c.exe");
    const hasLocalAppDataPath = candidates.some((c) => c.includes("L"));
    expect(hasLocalAppDataPath).toBe(true);
  });

  it("chromeCandidates darwin does not include any Windows path", () => {
    const candidates = chromeCandidates("darwin", {});
    for (const cand of candidates) {
      expect(cand).not.toContain("C:\\");
      expect(cand).not.toContain("chrome.exe");
    }
  });

  it("profileDir ends with .acp path (browser-profile or browser-profiles/default)", () => {
    const dir = profileDir();
    const isLegacy = dir.endsWith(`${sep}.acp${sep}browser-profile`);
    const isNamedDefault = dir.endsWith(`${sep}.acp${sep}browser-profiles${sep}default`);
    expect(isLegacy || isNamedDefault).toBe(true);
  });

  it("exports FIRST_RUN_NOTICE describing persistent session login", () => {
    expect(typeof FIRST_RUN_NOTICE).toBe("string");
    expect(FIRST_RUN_NOTICE).toContain("ACP WebBridge");
  });

  it("reservedPorts contains 9334 and 4771 and respects env overrides", async () => {
    const { reservedPorts } = await import("../../src/web/chrome.js");

    const def = reservedPorts({});
    expect(def).toContain(9334);
    expect(def).toContain(4771);

    const custom = reservedPorts({ ACP_WEB_HUB_PORT: "9999", ACP_API_PORT: "8888" });
    expect(custom).toContain(9999);
    expect(custom).toContain(8888);
    expect(custom).not.toContain(9334);
  });

  it("allocateProfilePort skips reserved ports and ports used by other profiles", async () => {
    const { allocateProfilePort } = await import("../../src/web/chrome.js");
    const existing = { default: { port: 9333 } };
    const env = { ACP_WEB_HUB_PORT: "9334", ACP_API_PORT: "4771" };

    const port = await allocateProfilePort("work", existing, {
      env,
      isPortFree: (p) => p !== 9335,
    });
    expect(port).toBe(9336);
  });

  it("allocateProfilePort maps default profile to 9333 when free and not reserved", async () => {
    const { allocateProfilePort } = await import("../../src/web/chrome.js");
    const port = await allocateProfilePort("default", {}, { isPortFree: () => true });
    expect(port).toBe(9333);
  });
});

describe("web/cdp.ts", () => {
  it("listTargets returns [] when endpoint is unreachable", async () => {
    const targets = await listTargets(59999);
    expect(targets).toEqual([]);
  });

  it("browserWsUrl throws expected error when endpoint is unreachable", async () => {
    await expect(browserWsUrl(59999)).rejects.toThrow("chrome devtools endpoint not reachable on port 59999");
  });
});
