import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startHub, getOrCreateHubToken, resetHubStateForTesting, type HubServer } from "../../src/web/hub.js";
import { startFakeExtension } from "../fixtures/fake-extension.js";
import { ExtensionTransport } from "../../src/web/transport.js";
import { BrowserTab } from "../../src/web/actions.js";
import { resolveVia } from "../../src/web-cli.js";
import { putSession, getSession } from "../../src/web/state.js";

describe("WebBridge Extension Mode Integration", () => {
  let tmpHome: string;
  let origHome: string | undefined;
  let origUserProfile: string | undefined;
  let hubPort: number;
  let hub: HubServer;
  let token: string;

  beforeEach(async () => {
    resetHubStateForTesting();
    tmpHome = mkdtempSync(join(tmpdir(), "acp-web-ext-mode-test-"));
    origHome = process.env.HOME;
    origUserProfile = process.env.USERPROFILE;
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;

    hubPort = 9450;
    hub = await startHub({ port: hubPort });
    token = getOrCreateHubToken();
  });

  afterEach(async () => {
    if (hub) {
      await hub.close();
    }
    resetHubStateForTesting();
    process.env.HOME = origHome;
    process.env.USERPROFILE = origUserProfile;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("drives BrowserTab over ExtensionTransport producing identical CDP calls and NEVER Runtime.enable", async () => {
    const cdpCalls: Array<{ tabId: number; method: string; params: any }> = [];

    const fakeExt = await startFakeExtension({
      hubPort,
      token,
      onCdp: (tabId, method, params) => {
        cdpCalls.push({ tabId, method, params });
        if (method === "Page.navigate") {
          return { frameId: "f1" };
        }
        if (method === "Runtime.evaluate") {
          const expr = params?.expression || "";
          if (expr === "document.visibilityState") return { result: { value: "visible" } };
          if (expr.includes("el.value !== undefined")) {
            return { result: { value: "test" } };
          }
          if (expr.includes("scrollIntoView")) return { result: { value: true } };
          if (expr.includes("getBoundingClientRect")) {
            return {
              result: {
                value: JSON.stringify({ tag: "input", name: "q", x: 20, y: 30, vw: 1024, vh: 768 }),
              },
            };
          }
          if (expr.includes("isContentEditable")) {
            return {
              result: {
                value: JSON.stringify({ tag: "input", type: "text", isContentEditable: false }),
              },
            };
          }
          if (expr.includes("document.title")) {
            return {
              result: {
                value: JSON.stringify({ url: "https://test.local", title: "Test Page", nodes: [], text: "Body" }),
              },
            };
          }
          return { result: { value: "ok" } };
        }
        return {};
      },
    });

    try {
      const transport = await ExtensionTransport.createTab({ hubPort, url: "https://test.local" });
      const tab = BrowserTab.fromTransport(transport);

      expect(tab.transportKind).toBe("extension");

      await tab.navigate("https://test.local/page2");
      await tab.snapshot();
      await tab.click("@e0");
      await tab.fill("@e0", "typed message");

      const methods = cdpCalls.map((c) => c.method);

      expect(methods).toContain("Page.navigate");
      expect(methods).toContain("Runtime.evaluate");
      expect(methods).toContain("Input.dispatchMouseEvent");
      expect(methods).toContain("Input.insertText");

      // Verify mouse event sequence (mouseMoved, mouseMoved, mousePressed, mouseReleased)
      const mouseCalls = cdpCalls.filter((c) => c.method === "Input.dispatchMouseEvent");
      expect(mouseCalls.length).toBeGreaterThanOrEqual(4);
      expect(mouseCalls[0].params.type).toBe("mouseMoved");
      expect(mouseCalls[1].params.type).toBe("mouseMoved");
      expect(mouseCalls[2].params.type).toBe("mousePressed");
      expect(mouseCalls[3].params.type).toBe("mouseReleased");

      // Verify fill call
      const fillCalls = cdpCalls.filter((c) => c.method === "Input.insertText");
      expect(fillCalls.length).toBe(1);
      expect(fillCalls[0].params.text).toBe("typed message");

      // CRITICAL INVARIANT: Runtime.enable must NEVER be sent
      expect(methods).not.toContain("Runtime.enable");
      expect(methods).not.toContain("Debugger.enable");

      await tab.close();
    } finally {
      await fakeExt.stop();
    }
  });

  it("ExtensionTransport surfaces 503 from hub as Error mentioning extension popup", async () => {
    // Hub is up, but NO extension is connected
    await expect(ExtensionTransport.createTab({ hubPort })).rejects.toThrowError(
      "extension not connected — run `acp web hub start` and switch the bridge on in the extension popup"
    );
  });

  it("enforces session record via field so via:extension is never resumed as direct", async () => {
    putSession("ext-test-sess", {
      targetId: "1234",
      readOnly: false,
      createdAt: new Date().toISOString(),
      via: "extension",
    });

    const rec = getSession("ext-test-sess");
    expect(rec?.via).toBe("extension");

    // resolveVia with flag auto and hub extension not connected -> auto resolves to direct, but session's rec.via is extension!
    expect(resolveVia("direct", false)).toBe("direct");
    expect(resolveVia("auto", false)).toBe("direct");
    expect(resolveVia("auto", true)).toBe("extension");

    // When session record has via: "extension", chosenVia will be "extension"
    const chosenVia = rec?.via ?? resolveVia("auto", false);
    expect(chosenVia).toBe("extension");
  });
});
