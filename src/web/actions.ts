/*
HARD INVARIANT:
This module must NEVER call Runtime.enable, Console.enable, Log.enable, Debugger.enable, Profiler.enable, or
Page.addScriptToEvaluateOnNewDocument. Those are precisely the signals that anti-bot scripts sniff to detect
DevTools/automation. Runtime.evaluate, DOM.*, Input.* and Page.captureScreenshot all work WITHOUT enabling Runtime.
*/

import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { mkdirSync, writeFileSync } from "node:fs";
import { listTargets } from "./cdp.js";
import { DEFAULT_PORT } from "./chrome.js";
import {
  initialState,
  observe,
  isSettled,
  STABILITY_CEILING_MS,
  type StabilityState,
} from "./stability.js";
import { type CdpTransport, DirectTransport } from "./transport.js";
import type { MarkerObservation } from "./fingerprint.js";

export interface SnapshotNode {
  ref: string;
  role: string;
  name: string;
  tag: string;
  value?: string;
}

export interface ActionResult {
  ok: boolean;
  [k: string]: unknown;
}

export function validateWaitArgs(o: {
  untilJs?: string;
  selector?: string;
  text?: string;
  gone?: string;
  stable?: string;
  busy?: string;
  timeoutMs?: number;
  intervalMs?: number;
}): ActionResult | null {
  const count = [o.untilJs, o.selector, o.text, o.gone, o.stable].filter(
    (x) => x !== undefined && x !== ""
  ).length;
  if (count !== 1) {
    return {
      ok: false,
      error: "waitFor needs exactly one of --until/--selector/--text/--gone/--stable",
    };
  }
  // --busy is mandatory alongside --stable, and "none" is how a caller says the
  // site has no busy indicator.
  //
  // Stability on its own cannot tell a paused stream from a finished one — they
  // look identical — and that mistake once filed a 52-character fragment as a
  // complete answer. Requiring the second signal does not remove the option to
  // go without it; it makes going without it a stated choice that shows up in
  // the command rather than a silent default.
  if (o.stable && !o.busy) {
    return {
      ok: false,
      error:
        "--stable needs --busy <css> (the selector shown while the site is working), " +
        "or --busy none to declare that this site has no such indicator",
    };
  }
  if (o.busy && !o.stable) {
    return { ok: false, error: "--busy only means something together with --stable" };
  }
  return null;
}

export function isEditableElement(el: {
  tag: string;
  type?: string | null;
  isContentEditable?: boolean;
}): boolean {
  if (!el) return false;
  if (el.isContentEditable) return true;
  const tag = (el.tag || "").toLowerCase();
  if (tag === "textarea") return true;
  if (tag === "input") {
    const type = (el.type || "text").toLowerCase();
    const nonEditableTypes = new Set(["button", "submit", "reset", "checkbox", "radio", "file"]);
    return !nonEditableTypes.has(type);
  }
  return false;
}

export function resolveVirtualKeyCode(
  key: string
): { windowsVirtualKeyCode: number; code: string; text?: string } | null {
  const map: Record<string, { windowsVirtualKeyCode: number; code: string; text?: string }> = {
    Enter: { windowsVirtualKeyCode: 13, code: "Enter", text: "\r" },
    Escape: { windowsVirtualKeyCode: 27, code: "Escape" },
    Tab: { windowsVirtualKeyCode: 9, code: "Tab" },
    Backspace: { windowsVirtualKeyCode: 8, code: "Backspace" },
    ArrowDown: { windowsVirtualKeyCode: 40, code: "ArrowDown" },
    ArrowUp: { windowsVirtualKeyCode: 38, code: "ArrowUp" },
    ArrowLeft: { windowsVirtualKeyCode: 37, code: "ArrowLeft" },
    ArrowRight: { windowsVirtualKeyCode: 39, code: "ArrowRight" },
    Delete: { windowsVirtualKeyCode: 46, code: "Delete" },
    Home: { windowsVirtualKeyCode: 36, code: "Home" },
    End: { windowsVirtualKeyCode: 35, code: "End" },
    PageDown: { windowsVirtualKeyCode: 34, code: "PageDown" },
    PageUp: { windowsVirtualKeyCode: 33, code: "PageUp" },
    Space: { windowsVirtualKeyCode: 32, code: "Space", text: " " },
  };
  return map[key] ?? null;
}

export class BrowserTab {
  private constructor(private _t: CdpTransport) {}

  static async open(o?: { profile?: string; port?: number; startUrl?: string }): Promise<BrowserTab> {
    const transport = await DirectTransport.openNewTab(o);
    return new BrowserTab(transport);
  }

  static async attach(o: { port?: number; targetId: string }): Promise<BrowserTab> {
    const transport = await DirectTransport.attachTab(o);
    return new BrowserTab(transport);
  }

  static fromTransport(t: CdpTransport): BrowserTab {
    return new BrowserTab(t);
  }

  get targetId(): string {
    return this._t.targetId;
  }

  get transportKind(): "direct" | "extension" {
    return this._t.kind;
  }

  detach(): void {
    try {
      this._t.detach();
    } catch {}
  }

  async navigate(url: string): Promise<{ ok: true; url: string }> {
    try {
      await this._t.send("Page.enable");
    } catch {}
    await this._t.send("Page.navigate", { url });
    const startTime = Date.now();
    let currentUrl = url;

    while (Date.now() - startTime < 15000) {
      try {
        const stateRes = await this._t.send<{ result?: { value?: string } }>(
          "Runtime.evaluate",
          { expression: "document.readyState", returnByValue: true }
        );
        const locRes = await this._t.send<{ result?: { value?: string } }>(
          "Runtime.evaluate",
          { expression: "document.location.href", returnByValue: true }
        );
        if (locRes?.result?.value) {
          currentUrl = locRes.result.value;
        }
        if (stateRes?.result?.value === "complete") {
          break;
        }
      } catch {
        // ignore intermediate evaluation errors during navigation
      }
      await new Promise((r) => setTimeout(r, 250));
    }

    return { ok: true, url: currentUrl };
  }

  async snapshot(): Promise<{ url: string; title: string; nodes: SnapshotNode[]; text: string }> {
    const script = `(() => {
      const candidates = Array.from(document.querySelectorAll(
        'a, button, input, select, textarea, [role], [contenteditable], [onclick], summary'
      ));
      const visible = candidates.filter(el => {
        if (el.disabled) return false;
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) return false;
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
        return el.offsetParent !== null || style.position === 'fixed';
      });

      Object.defineProperty(window, '__acpRefs', {
        value: visible,
        writable: true,
        configurable: true,
        enumerable: false
      });

      const nodes = visible.map((el, i) => {
        const rawText = el.innerText || el.textContent || '';
        const name = (
          rawText.trim().slice(0, 120) ||
          el.getAttribute('aria-label') ||
          el.getAttribute('placeholder') ||
          el.value ||
          el.getAttribute('title') ||
          el.getAttribute('alt') ||
          ''
        ).trim();

        const role = el.getAttribute('role') || el.tagName.toLowerCase();
        const tag = el.tagName.toLowerCase();
        const node = { ref: '@e' + i, role, name, tag };
        if (el.value !== undefined && el.value !== '' && tag !== 'button' && tag !== 'a') {
          node.value = String(el.value);
        }
        return node;
      });

      const text = document.body ? (document.body.innerText || '').trim().slice(0, 8000) : '';
      return JSON.stringify({
        url: window.location.href,
        title: document.title,
        nodes,
        text
      });
    })()`;

    const res = await this._t.send<{ result?: { value?: string } }>(
      "Runtime.evaluate",
      { expression: script, returnByValue: true }
    );

    if (!res?.result?.value) {
      return { url: "", title: "", nodes: [], text: "" };
    }

    try {
      return JSON.parse(res.result.value);
    } catch {
      return { url: "", title: "", nodes: [], text: "" };
    }
  }

  private async _ensureVisible(): Promise<{ visible: boolean; steps: string[] }> {
    const steps: string[] = [];
    const isVis = async (): Promise<boolean> => {
      try {
        const res = await this._t.send<{ result?: { value?: string } }>(
          "Runtime.evaluate",
          { expression: "document.visibilityState", returnByValue: true }
        );
        return res?.result?.value === "visible";
      } catch {
        return false;
      }
    };

    if (await isVis()) {
      return { visible: true, steps: [] };
    }

    // A tab that has JUST become visible is not yet ready for input: the renderer
    // needs a beat to produce the first frame that hit-testing works against.
    // Without this settle the FIRST consultation on a fresh tab stalled every
    // time and only the automatic retry succeeded — the retry worked purely
    // because by then the tab had been visible for a while.
    const settle = () => new Promise((r) => setTimeout(r, 600));

    try {
      await this._t.send("Page.bringToFront");
      steps.push("bringToFront");
      await new Promise((r) => setTimeout(r, 250));
    } catch {}

    if (await isVis()) {
      await settle();
      return { visible: true, steps };
    }

    try {
      steps.push("focusTab");
      await this._t.focusTab();
      await new Promise((r) => setTimeout(r, 400));
    } catch {}

    if (await isVis()) {
      await settle();
      return { visible: true, steps };
    }

    // Both in-browser routes failed. That usually means the extension is not
    // connected right now — which is precisely when a minimised window cannot
    // be restored from inside the browser. Fall back to the OS.
    try {
      const { restoreChromeWindowOS } = await import("./chrome.js");
      if (await restoreChromeWindowOS()) {
        steps.push("osRestore");
        await new Promise((r) => setTimeout(r, 600));
        if (await isVis()) {
          await settle();
          return { visible: true, steps };
        }
      }
    } catch {}

    return { visible: false, steps };
  }

  async click(selector: string): Promise<ActionResult> {
    const scrollScript = `(() => {
      const sel = ${JSON.stringify(selector)};
      let el = null;
      if (sel.startsWith('@e')) {
        const idx = parseInt(sel.slice(2), 10);
        if (window.__acpRefs && window.__acpRefs[idx]) {
          el = window.__acpRefs[idx];
        }
      } else {
        el = document.querySelector(sel);
      }
      if (!el) return false;
      el.scrollIntoView({ block: 'center' });
      return true;
    })()`;

    const scrollRes = await this._t.send<{ result?: { value?: boolean } }>(
      "Runtime.evaluate",
      { expression: scrollScript, returnByValue: true }
    );

    if (!scrollRes?.result?.value) {
      return { ok: false, error: `element not found: ${selector}` };
    }

    // Wait ~150 ms for smooth scroll / layout stabilization
    await new Promise((r) => setTimeout(r, 150));

    const rectScript = `(() => {
      const sel = ${JSON.stringify(selector)};
      let el = null;
      if (sel.startsWith('@e')) {
        const idx = parseInt(sel.slice(2), 10);
        if (window.__acpRefs && window.__acpRefs[idx]) {
          el = window.__acpRefs[idx];
        }
      } else {
        el = document.querySelector(sel);
      }
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      const name = (
        (el.innerText || el.textContent || '').trim().slice(0, 120) ||
        el.getAttribute('aria-label') ||
        el.getAttribute('placeholder') ||
        el.value ||
        el.getAttribute('title') ||
        ''
      ).trim();
      return JSON.stringify({
        tag: el.tagName.toLowerCase(),
        name,
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
        vw: window.innerWidth,
        vh: window.innerHeight,
        hidden: document.visibilityState !== 'visible'
      });
    })()`;

    const rectRes = await this._t.send<{ result?: { value?: string } }>(
      "Runtime.evaluate",
      { expression: rectScript, returnByValue: true }
    );

    if (!rectRes?.result?.value) {
      return { ok: false, error: `element not found: ${selector}` };
    }

    let info: {
      tag: string;
      name: string;
      x: number;
      y: number;
      vw: number;
      vh: number;
      hidden?: boolean;
    };
    try {
      info = JSON.parse(rectRes.result.value);
    } catch {
      return { ok: false, error: `element not found: ${selector}` };
    }

    const { x, y, tag, name, vw, vh } = info;

    if (x < 0 || y < 0 || x > vw || y > vh) {
      return { ok: false, error: "element is not in the viewport after scrolling" };
    }

    const vis = await this._ensureVisible();
    if (!vis.visible) {
      return {
        ok: false,
        error:
          "tab is not visible — injected input would be silently dropped; restore the Chrome window (it may be minimized)",
      };
    }

    const delay = () => new Promise((r) => setTimeout(r, 30 + Math.floor(Math.random() * 60)));

    await this._t.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await delay();
    await this._t.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await delay();
    await this._t.send(
      "Input.dispatchMouseEvent",
      { type: "mousePressed", button: "left", clickCount: 1, buttons: 1, x, y }
    );
    await delay();
    await this._t.send(
      "Input.dispatchMouseEvent",
      { type: "mouseReleased", button: "left", clickCount: 1, buttons: 0, x, y }
    );

    return { ok: true, tag, name, x, y };
  }

  async fill(selector: string, value: string): Promise<ActionResult> {
    const vis = await this._ensureVisible();
    if (!vis.visible) {
      return {
        ok: false,
        error:
          "tab is not visible — injected input would be silently dropped; restore the Chrome window (it may be minimized)",
      };
    }

    const checkScript = `(() => {
      const sel = ${JSON.stringify(selector)};
      let el = null;
      if (sel.startsWith('@e')) {
        const idx = parseInt(sel.slice(2), 10);
        if (window.__acpRefs && window.__acpRefs[idx]) {
          el = window.__acpRefs[idx];
        }
      } else {
        el = document.querySelector(sel);
      }
      if (!el) return null;
      const tag = el.tagName.toLowerCase();
      const type = el.getAttribute('type');
      const isContentEditable = Boolean(el.isContentEditable);
      return JSON.stringify({ tag, type, isContentEditable });
    })()`;

    const checkRes = await this._t.send<{ result?: { value?: string } }>(
      "Runtime.evaluate",
      { expression: checkScript, returnByValue: true }
    );

    if (!checkRes?.result?.value) {
      return { ok: false, error: `element not found: ${selector}` };
    }

    let elInfo: { tag: string; type?: string | null; isContentEditable?: boolean };
    try {
      elInfo = JSON.parse(checkRes.result.value);
    } catch {
      return { ok: false, error: `element not found: ${selector}` };
    }

    if (!isEditableElement(elInfo)) {
      return { ok: false, error: `element is not editable: ${selector} (${elInfo.tag})` };
    }

    // Focus with JS, type with trusted input.
    //
    // Focusing used to go through click(), which dispatches a real mouse event —
    // and a real mouse event is hit-tested against a rendered frame, so it lands
    // nowhere while the tab is still settling after being un-minimised. The
    // symptom was "fill did not take effect (expected 26 chars, found 0)".
    // Focus is not an input event and does not need to be trusted; only the
    // TYPING must be (Input.insertText / Input.dispatchKeyEvent), and that goes
    // to the focused element without any hit test. So this keeps isTrusted=true
    // exactly where it matters while removing a whole class of silent failures.
    const focusScript = `(() => {
      const sel = ${JSON.stringify(selector)};
      let el = null;
      if (sel.startsWith('@e')) {
        const idx = parseInt(sel.slice(2), 10);
        if (window.__acpRefs && window.__acpRefs[idx]) el = window.__acpRefs[idx];
      } else {
        el = document.querySelector(sel);
      }
      if (!el) return 'missing';
      el.scrollIntoView({ block: 'center' });
      el.focus();
      return document.activeElement === el ? 'ok' : 'not-focused';
    })()`;
    const focusRes = await this._t.send<{ result?: { value?: string } }>("Runtime.evaluate", {
      expression: focusScript,
      returnByValue: true,
    });
    const focusState = focusRes?.result?.value;
    if (focusState === "missing") {
      return { ok: false, error: `element not found: ${selector}` };
    }
    if (focusState !== "ok") {
      // Fall back to a real click for widgets that only focus on pointer input.
      const clickRes = await this.click(selector);
      if (!clickRes.ok) {
        return { ok: false, error: clickRes.error };
      }
    }

    const modeScript = `(() => {
      const sel = ${JSON.stringify(selector)};
      let el = null;
      if (sel.startsWith('@e')) {
        const idx = parseInt(sel.slice(2), 10);
        if (window.__acpRefs && window.__acpRefs[idx]) {
          el = window.__acpRefs[idx];
        }
      } else {
        el = document.querySelector(sel);
      }
      if (el && el.isContentEditable) return "contenteditable";
      return "value";
    })()`;

    const modeRes = await this._t.send<{ result?: { value?: string } }>(
      "Runtime.evaluate",
      { expression: modeScript, returnByValue: true }
    );
    const mode = modeRes?.result?.value === "contenteditable" ? "contenteditable" : "value";

    const modifiers = 2; // Ctrl
    await this._t.send(
      "Input.dispatchKeyEvent",
      { type: "rawKeyDown", modifiers, windowsVirtualKeyCode: 65, key: "a", code: "KeyA" }
    );
    await this._t.send(
      "Input.dispatchKeyEvent",
      { type: "keyUp", modifiers, windowsVirtualKeyCode: 65, key: "a", code: "KeyA" }
    );

    await this._t.send("Input.insertText", { text: value });

    const readScript = `(() => {
      const sel = ${JSON.stringify(selector)};
      let el = null;
      if (sel.startsWith('@e')) {
        const idx = parseInt(sel.slice(2), 10);
        if (window.__acpRefs && window.__acpRefs[idx]) {
          el = window.__acpRefs[idx];
        }
      } else {
        el = document.querySelector(sel);
      }
      if (!el) return null;
      if (el.isContentEditable) return el.innerText || '';
      return el.value !== undefined ? String(el.value) : '';
    })()`;

    const readRes = await this._t.send<{ result?: { value?: string } }>(
      "Runtime.evaluate",
      { expression: readScript, returnByValue: true }
    );
    const actual = typeof readRes?.result?.value === "string" ? readRes.result.value : "";

    // Compare on normalised line endings. A textarea stores "\n"; text coming
    // from a Windows shell or file carries "\r\n", so a byte-exact comparison
    // rejects every multi-line message — it failed on a 28-line brief with
    // "expected 2444 chars, found 2416", exactly one character per line.
    const norm = (s: string) => s.replace(/\r\n/g, "\n");
    if (norm(actual) !== norm(value)) {
      return {
        ok: false,
        error: `fill did not take effect (expected ${norm(value).length} chars, found ${norm(actual).length})`,
        actual: actual.slice(0, 80),
      };
    }

    return { ok: true, mode };
  }

  async press(key: string): Promise<ActionResult> {
    const resolved = resolveVirtualKeyCode(key);
    if (!resolved) {
      return { ok: false, error: `unsupported key: ${key}` };
    }

    const vis = await this._ensureVisible();
    if (!vis.visible) {
      return {
        ok: false,
        error:
          "tab is not visible — injected input would be silently dropped; restore the Chrome window (it may be minimized)",
      };
    }

    const { windowsVirtualKeyCode, code, text } = resolved;
    const keyDownParams: Record<string, any> = {
      type: "keyDown",
      windowsVirtualKeyCode,
      key,
      code,
    };
    if (text !== undefined) keyDownParams.text = text;

    await this._t.send("Input.dispatchKeyEvent", keyDownParams);
    await this._t.send(
      "Input.dispatchKeyEvent",
      { type: "keyUp", windowsVirtualKeyCode, key, code }
    );

    return { ok: true, key };
  }

  async evaluate(code: string): Promise<{ ok: boolean; value?: unknown; error?: string }> {
    const res = await this._t.send<{
      result?: { value?: unknown };
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    }>(
      "Runtime.evaluate",
      { expression: code, returnByValue: true, awaitPromise: true }
    );

    if (res.exceptionDetails) {
      const err =
        res.exceptionDetails.exception?.description ||
        res.exceptionDetails.text ||
        "script exception";
      return { ok: false, error: err };
    }
    return { ok: true, value: res.result?.value };
  }

  async screenshot(o?: {
    format?: "png" | "jpeg";
    quality?: number;
    path?: string;
  }): Promise<{ ok: boolean; path: string; sizeBytes: number; format: string }> {
    const format = o?.format ?? "png";
    const params: Record<string, any> = { format };
    if (format === "jpeg" && typeof o?.quality === "number") {
      params.quality = Math.max(0, Math.min(100, Math.round(o.quality)));
    }

    const res = await this._t.send<{ data: string }>(
      "Page.captureScreenshot",
      params
    );

    const buffer = Buffer.from(res.data, "base64");
    const outputPath = o?.path ?? join(tmpdir(), "acp-web", `shot-${Date.now()}.${format}`);

    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, buffer);

    return { ok: true, path: outputPath, sizeBytes: buffer.length, format };
  }

  /**
   * Wait until the content settles and the site is no longer busy.
   *
   * Reports what it was watching when it gives up: how long the text held still
   * versus how long this particular stream had earned. "Timed out" without those
   * numbers sends people to the wrong problem.
   */
  private async _waitStable(o: {
    stable: string;
    busy: string;
    windowMs?: number;
    timeoutMs?: number;
    intervalMs?: number;
  }): Promise<ActionResult> {
    const intervalMs = Math.max(80, o.intervalMs ?? 150);
    const timeoutMs = Math.min(600000, o.timeoutMs ?? 120000);
    const noBusy = o.busy.trim().toLowerCase() === "none";

    const probeJs = `(() => {
      const vis = (el) => { const r = el.getBoundingClientRect(); return r.width >= 2 && r.height >= 2; };
      const parts = [...document.querySelectorAll(${JSON.stringify(o.stable)})]
        .filter(vis)
        .map(e => (e.innerText || '').trim())
        .filter(Boolean);
      const busy = ${noBusy}
        ? false
        : [...document.querySelectorAll(${JSON.stringify(o.busy)})].some(vis);
      return JSON.stringify({ text: parts.join(String.fromCharCode(10, 10)), busy });
    })()`;

    const started = Date.now();
    let state: StabilityState = initialState();
    let polls = 0;
    let lastBusy = false;
    let lastCheck = { settled: false, requiredMs: 0, quietMs: 0 };

    // A probe that will not run is not an empty page.
    //
    // The first version of this loop treated an unusable read as "nothing there
    // yet" and kept polling. A syntax error in the probe — a `\n` inside a
    // template literal that became a real newline inside a page-side string —
    // therefore produced 715 identical failures over two minutes and reported
    // "0 chars", pointing at the site instead of at the bug. Two consecutive
    // failures now stop the wait and say what the page said.
    let probeFailures = 0;
    let probeError = "";

    while (Date.now() - started <= timeoutMs) {
      polls++;
      const res = await this.evaluate(probeJs);
      if (!res.ok) {
        probeError = String(res.error ?? "probe returned nothing");
        if (++probeFailures >= 2) {
          return {
            ok: false,
            error: `the stability probe could not run: ${probeError}`,
            waitedMs: Date.now() - started,
            polls,
          } as ActionResult;
        }
      } else {
        probeFailures = 0;
      }
      if (res.ok && typeof res.value === "string") {
        try {
          const parsed = JSON.parse(res.value) as { text: string; busy: boolean };
          const now = Date.now();
          lastBusy = Boolean(parsed.busy);
          // The busy reading goes INTO the state, not just into the final
          // verdict: a quiet run interrupted by "still working" is not a quiet
          // run, and treating it as one is what let a paused stream be filed as
          // a finished answer on the Qwen path.
          state = observe(state, parsed.text ?? "", now, lastBusy);
          lastCheck = isSettled(state, now, lastBusy, {
            ...(o.windowMs !== undefined ? { floorMs: o.windowMs } : {}),
            ceilingMs: STABILITY_CEILING_MS,
          });
          if (lastCheck.settled) {
            return {
              ok: true,
              waitedMs: Date.now() - started,
              polls,
              chars: state.text.length,
              settledForMs: lastCheck.quietMs,
              requiredMs: lastCheck.requiredMs,
              maxGrowthGapMs: state.maxGrowthGap,
            } as ActionResult;
          }
        } catch {
          /* keep polling: a malformed read is not an answer */
        }
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }

    return {
      ok: false,
      error:
        `content did not settle within ${timeoutMs}ms ` +
        `(${state.text.length} chars, quiet for ${lastCheck.quietMs}ms of the ` +
        `${lastCheck.requiredMs}ms this stream earned, busy=${lastBusy})`,
      waitedMs: Date.now() - started,
      polls,
      chars: state.text.length,
      busy: lastBusy,
    } as ActionResult;
  }

  async waitFor(o: {
    untilJs?: string;
    selector?: string;
    text?: string;
    gone?: string;
    stable?: string;
    busy?: string;
    windowMs?: number;
    timeoutMs?: number;
    intervalMs?: number;
  }): Promise<ActionResult> {
    const invalid = validateWaitArgs(o);
    if (invalid) return invalid;

    // The trained wait: content that stopped growing AND a site that stopped
    // saying it is busy. Lives here rather than in one caller so that anything
    // driving a browser can ask for it by name instead of inventing a sleep.
    if (o.stable) {
      return this._waitStable({
        stable: o.stable,
        busy: o.busy ?? "none",
        ...(o.windowMs !== undefined ? { windowMs: o.windowMs } : {}),
        ...(o.timeoutMs !== undefined ? { timeoutMs: o.timeoutMs } : {}),
        ...(o.intervalMs !== undefined ? { intervalMs: o.intervalMs } : {}),
      });
    }

    const intervalMs = Math.max(100, o.intervalMs ?? 250);
    const timeoutMs = Math.min(120000, o.timeoutMs ?? 15000);

    const startTime = Date.now();
    let polls = 0;
    let lastVal: unknown = false;
    let lastObserved: Record<string, unknown> = {};
    let lastError: string | undefined = undefined;

    let script = "";
    if (o.untilJs !== undefined) {
      const js = o.untilJs;
      script = `(() => {
        const val = Boolean(${js});
        return { val, title: (document.title || "").slice(0, 120) };
      })()`;
    } else if (o.selector !== undefined || o.gone !== undefined) {
      const sel = JSON.stringify(o.selector ?? o.gone);
      const isGone = o.gone !== undefined;
      script = `(() => {
        const els = Array.from(document.querySelectorAll(${sel}));
        const matched = els.length;
        const visible = els.filter(el => {
          const rect = el.getBoundingClientRect();
          if (rect.width === 0 && rect.height === 0) return false;
          const style = window.getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden') return false;
          return el.offsetParent !== null || style.position === 'fixed';
        }).length;
        const val = ${isGone} ? visible === 0 : visible > 0;
        return { val, matched, visible, title: (document.title || "").slice(0, 120) };
      })()`;
    } else if (o.text !== undefined) {
      const targetText = JSON.stringify(o.text);
      script = `(() => {
        const bodyText = document.body ? (document.body.innerText || "") : "";
        const val = bodyText.includes(${targetText});
        return {
          val,
          title: (document.title || "").slice(0, 120),
          innerTextLength: bodyText.length
        };
      })()`;
    }

    while (Date.now() - startTime <= timeoutMs) {
      polls++;
      try {
        const res = await this._t.send<{
          result?: { value?: any };
          exceptionDetails?: { text?: string; exception?: { description?: string } };
        }>("Runtime.evaluate", { expression: script, returnByValue: true, awaitPromise: true });

        if (res?.exceptionDetails) {
          lastError =
            res.exceptionDetails.exception?.description ||
            res.exceptionDetails.text ||
            "script exception";
          lastVal = false;
        } else if (res?.result?.value) {
          const data = res.result.value as any;
          lastVal = Boolean(data.val);
          lastObserved = { ...data };
          delete lastObserved.val;
        } else {
          lastVal = false;
        }
      } catch (err: any) {
        lastError = String(err?.message || err);
        lastVal = false;
      }

      if (lastVal === true) {
        const waitedMs = Date.now() - startTime;
        return { ok: true, waitedMs, polls };
      }

      const elapsed = Date.now() - startTime;
      if (elapsed >= timeoutMs) break;
      const sleepTime = Math.min(intervalMs, timeoutMs - elapsed);
      await new Promise((r) => setTimeout(r, sleepTime));
    }

    const ms = Date.now() - startTime;
    const observed: Record<string, unknown> = {
      lastValue: lastVal,
      ...lastObserved,
    };
    if (lastError) {
      observed.lastError = lastError;
    }

    // Say how hard it tried, not just that it failed.
    //
    // The failure branch reported neither the elapsed time nor the number of
    // polls, so the one fingerprint that identifies a blind wait — the condition
    // was evaluated dozens of times and was false every single one — existed in
    // the loop and never reached the caller. `neverTrue` states it outright so
    // nobody has to infer it.
    return {
      ok: false,
      error: `wait timeout after ${ms}ms`,
      observed,
      waitedMs: ms,
      polls,
      neverTrue: lastVal === false,
    } as ActionResult;
  }

  async observeMarkers(selectors: string[]): Promise<MarkerObservation[]> {
    const script = `(() => {
      const selectors = ${JSON.stringify(selectors)};
      return selectors.map(sel => {
        let els = [];
        try {
          els = Array.from(document.querySelectorAll(sel));
        } catch {}
        const present = els.length > 0;
        const first = els[0] || null;
        const tag = first ? first.tagName.toLowerCase() : null;
        const visible = els.filter(el => {
          const rect = el.getBoundingClientRect();
          if (rect.width === 0 && rect.height === 0) return false;
          const style = window.getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden') return false;
          return el.offsetParent !== null || style.position === 'fixed';
        }).length;
        return { selector: sel, present, visible, tag };
      });
    })()`;

    const res = await this._t.send<{ result?: { value?: MarkerObservation[] } }>(
      "Runtime.evaluate",
      { expression: script, returnByValue: true }
    );

    return Array.isArray(res?.result?.value) ? res.result.value : [];
  }

  async close(): Promise<void> {
    await this._t.closeTab();
  }
}

export async function listPages(
  port?: number
): Promise<{ targetId: string; url: string; title: string }[]> {
  const targets = await listTargets(port ?? DEFAULT_PORT);
  return targets
    .filter((t) => t.type === "page")
    .map((t) => ({ targetId: t.targetId, url: t.url, title: t.title }));
}
