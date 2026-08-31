import { describe, it, expect, beforeEach } from "vitest";
import type { CdpTransport } from "../../src/web/transport.js";
import { BrowserTab } from "../../src/web/actions.js";

class FakeTransport implements CdpTransport {
  readonly kind = "direct";
  readonly targetId = "fake-target-123";
  public calls: Array<{ method: string; params?: any }> = [];
  public closed = false;
  public detached = false;

  // Custom handler to return expressions for Runtime.evaluate
  public evalHandler?: (expr: string) => any;
  public focusTabCalls = 0;
  public focusTabResult = true;

  public visibilityStates: string[] = ["visible"];
  public fillReadbackValue?: string;

  public lastInsertedText = "";

  async send<T = any>(method: string, params?: object): Promise<T> {
    this.calls.push({ method, params });
    if (method === "Input.insertText") {
      this.lastInsertedText = (params as any)?.text ?? "";
    }
    if (method === "Runtime.evaluate") {
      const expr = (params as any)?.expression ?? "";
      if (expr === "document.visibilityState") {
        const nextState =
          this.visibilityStates.length > 1
            ? this.visibilityStates.shift()!
            : this.visibilityStates[0] || "visible";
        return { result: { value: nextState } } as any;
      }
      if (expr.includes("el.value !== undefined")) {
        if (this.fillReadbackValue !== undefined) {
          return { result: { value: this.fillReadbackValue } } as any;
        }
        return { result: { value: this.lastInsertedText } } as any;
      }
      if (this.evalHandler) {
        const val = this.evalHandler(expr);
        return { result: { value: val } } as any;
      }
      // Default fallback evaluate responses
      if (expr.includes("scrollIntoView")) {
        return { result: { value: true } } as any;
      }
      if (expr.includes("getBoundingClientRect")) {
        return {
          result: {
            value: JSON.stringify({
              tag: "button",
              name: "Submit",
              x: 100,
              y: 100,
              vw: 1024,
              vh: 768,
            }),
          },
        } as any;
      }
      if (expr.includes("isContentEditable")) {
        return {
          result: {
            value: JSON.stringify({
              tag: "input",
              type: "text",
              isContentEditable: false,
            }),
          },
        } as any;
      }
    }
    if (method === "Page.captureScreenshot") {
      return { data: Buffer.from("fake-image-data").toString("base64") } as any;
    }
    return {} as any;
  }

  async closeTab(): Promise<void> {
    this.closed = true;
    this.detach();
  }

  detach(): void {
    this.detached = true;
  }

  async focusTab(): Promise<boolean> {
    this.focusTabCalls++;
    return this.focusTabResult;
  }
}

describe("BrowserTab driven by CdpTransport (FakeTransport)", () => {
  let fake: FakeTransport;
  let tab: BrowserTab;

  beforeEach(() => {
    fake = new FakeTransport();
    tab = BrowserTab.fromTransport(fake);
  });

  it("reports targetId and transportKind correctly", () => {
    expect(tab.targetId).toBe("fake-target-123");
    expect(tab.transportKind).toBe("direct");
  });

  it("click() on in-viewport element dispatches Input.dispatchMouseEvent (move, move, press, release) in order and no JS click", async () => {
    const res = await tab.click("@e0");
    expect(res.ok).toBe(true);

    const inputCalls = fake.calls.filter((c) => c.method === "Input.dispatchMouseEvent");
    expect(inputCalls.length).toBe(4);
    expect(inputCalls[0].params).toMatchObject({ type: "mouseMoved", x: 100, y: 100 });
    expect(inputCalls[1].params).toMatchObject({ type: "mouseMoved", x: 100, y: 100 });
    expect(inputCalls[2].params).toMatchObject({
      type: "mousePressed",
      button: "left",
      clickCount: 1,
      x: 100,
      y: 100,
    });
    expect(inputCalls[3].params).toMatchObject({
      type: "mouseReleased",
      button: "left",
      clickCount: 1,
      x: 100,
      y: 100,
    });

    const evalCalls = fake.calls.filter((c) => c.method === "Runtime.evaluate");
    for (const c of evalCalls) {
      expect(c.params.expression).not.toContain(".click()");
    }
  });

  it("click() rejects with ok:false when center point is outside viewport and dispatches NO Input.* event", async () => {
    fake.evalHandler = (expr: string) => {
      if (expr.includes("scrollIntoView")) return true;
      if (expr.includes("getBoundingClientRect")) {
        return JSON.stringify({
          tag: "button",
          name: "Offscreen",
          x: -50,
          y: 100,
          vw: 1024,
          vh: 768,
        });
      }
      return null;
    };

    const res = await tab.click("@e0");
    expect(res.ok).toBe(false);
    expect(res.error).toBe("element is not in the viewport after scrolling");

    const inputCalls = fake.calls.filter((c) => c.method.startsWith("Input."));
    expect(inputCalls.length).toBe(0);
  });

  it("fill() on a non-editable element returns ok:false and dispatches NO Input.insertText", async () => {
    fake.evalHandler = (expr: string) => {
      if (expr.includes("isContentEditable")) {
        return JSON.stringify({
          tag: "a",
          type: null,
          isContentEditable: false,
        });
      }
      return null;
    };

    const res = await tab.fill("@e0", "hello");
    expect(res.ok).toBe(false);
    expect(res.error).toContain("element is not editable");

    const insertCalls = fake.calls.filter((c) => c.method === "Input.insertText");
    expect(insertCalls.length).toBe(0);
  });

  it("fill() on an <input> dispatches Input.insertText with the given text", async () => {
    fake.evalHandler = (expr: string) => {
      if (expr.includes("scrollIntoView")) return true;
      if (expr.includes("getBoundingClientRect")) {
        return JSON.stringify({ tag: "input", name: "q", x: 10, y: 10, vw: 1024, vh: 768 });
      }
      if (expr.includes("isContentEditable")) {
        return JSON.stringify({ tag: "input", type: "text", isContentEditable: false });
      }
      return null;
    };

    const res = await tab.fill("@e0", "typed value");
    expect(res.ok).toBe(true);

    const insertCalls = fake.calls.filter((c) => c.method === "Input.insertText");
    expect(insertCalls.length).toBe(1);
    expect(insertCalls[0].params).toEqual({ text: "typed value" });
  });

  it("press('Enter') dispatches Input.dispatchKeyEvent with windowsVirtualKeyCode 13; unknown key returns ok:false", async () => {
    const resEnter = await tab.press("Enter");
    expect(resEnter.ok).toBe(true);

    const keyCalls = fake.calls.filter((c) => c.method === "Input.dispatchKeyEvent");
    expect(keyCalls.length).toBe(2);
    expect(keyCalls[0].params).toMatchObject({
      type: "keyDown",
      windowsVirtualKeyCode: 13,
      key: "Enter",
      code: "Enter",
    });

    fake.calls = [];
    const resBanana = await tab.press("Banana");
    expect(resBanana.ok).toBe(false);
    expect(resBanana.error).toBe("unsupported key: Banana");
    expect(fake.calls.length).toBe(0);
  });

  it("screenshot({format:'png'}) omits quality; format 'jpeg' includes quality parameter", async () => {
    await tab.screenshot({ format: "png", quality: 90 });
    const pngCall = fake.calls.find((c) => c.method === "Page.captureScreenshot");
    expect(pngCall?.params).toEqual({ format: "png" });

    fake.calls = [];
    await tab.screenshot({ format: "jpeg", quality: 80 });
    const jpegCall = fake.calls.find((c) => c.method === "Page.captureScreenshot");
    expect(jpegCall?.params).toEqual({ format: "jpeg", quality: 80 });
  });

  it("HARD INVARIANT TEST: exercising all browser actions calls NONE of forbidden anti-bot domains", async () => {
    fake.evalHandler = (expr: string) => {
      if (expr.includes("scrollIntoView")) return true;
      if (expr.includes("getBoundingClientRect")) {
        return JSON.stringify({ tag: "input", name: "q", x: 10, y: 10, vw: 1024, vh: 768 });
      }
      if (expr.includes("isContentEditable")) {
        return JSON.stringify({ tag: "input", type: "text", isContentEditable: false });
      }
      if (expr.includes("document.title")) {
        return JSON.stringify({ url: "https://example.com", title: "Test", nodes: [], text: "Body" });
      }
      return "complete";
    };

    await tab.navigate("https://example.com");
    await tab.snapshot();
    await tab.click("@e0");
    await tab.fill("@e0", "test");
    await tab.press("Enter");
    await tab.evaluate("1 + 1");
    await tab.screenshot();

    const executedMethods = fake.calls.map((c) => c.method);
    const FORBIDDEN_DOMAINS = [
      "Runtime.enable",
      "Console.enable",
      "Log.enable",
      "Debugger.enable",
      "Page.addScriptToEvaluateOnNewDocument",
    ];

    for (const forbidden of FORBIDDEN_DOMAINS) {
      expect(executedMethods).not.toContain(forbidden);
    }
  });

  it("click/fill/press on a tab that never becomes visible dispatch NO Input.* command and return the not-visible error", async () => {
    fake.visibilityStates = ["hidden", "hidden", "hidden"];
    const resClick = await tab.click("@e0");
    expect(resClick.ok).toBe(false);
    expect(resClick.error).toContain("tab is not visible");

    const resFill = await tab.fill("@e0", "test");
    expect(resFill.ok).toBe(false);
    expect(resFill.error).toContain("tab is not visible");

    const resPress = await tab.press("Enter");
    expect(resPress.ok).toBe(false);
    expect(resPress.error).toContain("tab is not visible");

    const inputCalls = fake.calls.filter((c) => c.method.startsWith("Input."));
    expect(inputCalls.length).toBe(0);
  });

  it("click on a tab that is hidden but becomes visible after bringToFront dispatches normally and does not call focusTab", async () => {
    fake.visibilityStates = ["hidden", "visible"];
    const res = await tab.click("@e0");
    expect(res.ok).toBe(true);
    expect(fake.focusTabCalls).toBe(0);

    const bringToFrontCalls = fake.calls.filter((c) => c.method === "Page.bringToFront");
    expect(bringToFrontCalls.length).toBe(1);
  });

  it("click on a tab still hidden after bringToFront calls focusTab exactly once, then dispatches when it turns visible", async () => {
    fake.visibilityStates = ["hidden", "hidden", "visible"];
    const res = await tab.click("@e0");
    expect(res.ok).toBe(true);
    expect(fake.focusTabCalls).toBe(1);
  });

  it("fill returns mismatch error when read-back value differs from requested, and dispatches no retry", async () => {
    fake.visibilityStates = ["visible"];
    fake.fillReadbackValue = "typed valuetyped value";
    const res = await tab.fill("@e0", "typed value");
    expect(res.ok).toBe(false);
    expect(res.error).toContain("fill did not take effect");
  });

  it("a tab already visible never triggers bringToFront or focusTab", async () => {
    fake.visibilityStates = ["visible"];
    const res = await tab.click("@e0");
    expect(res.ok).toBe(true);
    expect(fake.focusTabCalls).toBe(0);
    const bringCalls = fake.calls.filter((c) => c.method === "Page.bringToFront");
    expect(bringCalls.length).toBe(0);
  });
});
