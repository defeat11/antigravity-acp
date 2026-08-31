import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createBridge } from "../../extension/bridge-core.js";

describe("extension/bridge-core.js pure logic & security invariants", () => {
  let attachCalls: Array<{ target: { tabId: number }; version: string }>;
  let sendCommandCalls: Array<{ target: { tabId: number }; method: string; params: any }>;
  let detachCalls: Array<{ target: { tabId: number } }>;
  let tabsCreateCalls: Array<{ url: string; active?: boolean }>;
  let tabsRemoveCalls: number[];
  let bridge: ReturnType<typeof createBridge>;

  beforeEach(() => {
    attachCalls = [];
    sendCommandCalls = [];
    detachCalls = [];
    tabsCreateCalls = [];
    tabsRemoveCalls = [];

    let nextTabId = 100;
    // The browser's tab list the fake keeps in sync with create/remove.
    const openTabs: { id: number; url: string; title: string; active: boolean }[] = [
      { id: 999, url: "https://uncontrolled.com", title: "Uncontrolled", active: false },
    ];

    bridge = createBridge({
      debugger: {
        attach: async (target: { tabId: number }, version: string) => {
          attachCalls.push({ target, version });
        },
        sendCommand: async (target: { tabId: number }, method: string, params: any) => {
          sendCommandCalls.push({ target, method, params });
          return { evalResult: 42 };
        },
        detach: async (target: { tabId: number }) => {
          detachCalls.push({ target });
        },
      },
      tabs: {
        // The fake mirrors Chrome: a created tab becomes queryable at the URL it
        // was created with. Without that, tabs.list reads a stale fixture and the
        // test compares the created URL against an unrelated one.
        create: async (opts: { url: string; active?: boolean }) => {
          tabsCreateCalls.push(opts);
          const tabId = ++nextTabId;
          const tab = { id: tabId, url: opts.url, title: "Test", active: true };
          const idx = openTabs.findIndex((t) => t.id === tabId);
          if (idx >= 0) openTabs[idx] = tab;
          else openTabs.unshift(tab);
          return { id: tabId, url: opts.url };
        },
        remove: async (tabId: number) => {
          tabsRemoveCalls.push(tabId);
          const idx = openTabs.findIndex((t) => t.id === tabId);
          if (idx >= 0) openTabs.splice(idx, 1);
        },
        query: async () => openTabs.map((t) => ({ ...t })),
      },
    });
  });

  it("refuses CDP for non-controlled tab without attaching or sending command", async () => {
    const res = await bridge.handleMessage({ id: 1, type: "cdp", tabId: 999, method: "Page.navigate" });
    expect(res).toEqual({ id: 1, error: "tab not under agent control: 999" });
    expect(attachCalls.length).toBe(0);
    expect(sendCommandCalls.length).toBe(0);
  });

  it("tabs.create records ownership, and subsequent CDP call reaches debugger.sendCommand", async () => {
    const createRes = await bridge.handleMessage({ id: 10, type: "tabs.create", url: "https://agent.test" });
    expect(createRes.error).toBeUndefined();
    const createdTabId = createRes.result.tabId;
    expect(createdTabId).toBe(101);

    const cdpRes = await bridge.handleMessage({
      id: 11,
      type: "cdp",
      tabId: createdTabId,
      method: "Page.navigate",
      params: { url: "https://agent.test" },
    });

    expect(cdpRes).toEqual({ id: 11, result: { evalResult: 42 } });
    expect(attachCalls.length).toBe(1);
    expect(attachCalls[0].target.tabId).toBe(createdTabId);
    expect(sendCommandCalls.length).toBe(1);
    expect(sendCommandCalls[0].method).toBe("Page.navigate");
    expect(sendCommandCalls[0].params).toEqual({ url: "https://agent.test" });
  });

  it("debugger attach happens only once per tab across several CDP calls", async () => {
    const createRes = await bridge.handleMessage({ id: 1, type: "tabs.create", url: "about:blank" });
    const tabId = createRes.result.tabId;

    await bridge.handleMessage({ id: 2, type: "cdp", tabId, method: "Page.enable" });
    await bridge.handleMessage({ id: 3, type: "cdp", tabId, method: "Runtime.evaluate", params: { expression: "1+1" } });

    expect(attachCalls.length).toBe(1);
    expect(sendCommandCalls.length).toBe(2);
  });

  it("setHandover controls only specified tab and revoking or replacing it drops control", async () => {
    bridge.setHandover(500);
    expect(bridge.isControlled(500)).toBe(true);

    const cdpRes1 = await bridge.handleMessage({ id: 20, type: "cdp", tabId: 500, method: "Page.reload" });
    expect(cdpRes1.error).toBeUndefined();

    // Handing over second tab replaces first
    bridge.setHandover(600);
    expect(bridge.isControlled(500)).toBe(false);
    expect(bridge.isControlled(600)).toBe(true);

    const cdpRes2 = await bridge.handleMessage({ id: 21, type: "cdp", tabId: 500, method: "Page.reload" });
    expect(cdpRes2).toEqual({ id: 21, error: "tab not under agent control: 500" });

    // Revoking handover
    bridge.setHandover(null);
    expect(bridge.isControlled(600)).toBe(false);

    const cdpRes3 = await bridge.handleMessage({ id: 22, type: "cdp", tabId: 600, method: "Page.reload" });
    expect(cdpRes3).toEqual({ id: 22, error: "tab not under agent control: 600" });
  });

  it("tabs.close on non-controlled tab is refused without calling tabs.remove", async () => {
    const res = await bridge.handleMessage({ id: 30, type: "tabs.close", tabId: 888 });
    expect(res).toEqual({ id: 30, error: "tab not under agent control: 888" });
    expect(tabsRemoveCalls.length).toBe(0);
  });

  it("tabs.focus refuses non-controlled tab with exact error", async () => {
    const res = await bridge.handleMessage({ id: 40, type: "tabs.focus", tabId: 999 });
    expect(res).toEqual({ id: 40, error: "tab not under agent control: 999" });
  });

  it("tabs.focus on controlled tab activates tab and restores window state", async () => {
    const createRes = await bridge.handleMessage({ id: 1, type: "tabs.create", url: "about:blank" });
    const tabId = createRes.result.tabId;

    const focusRes = await bridge.handleMessage({ id: 41, type: "tabs.focus", tabId });
    expect(focusRes.error).toBeUndefined();
    expect(focusRes.result).toEqual({ ok: true, windowId: null });
  });

  it("forgetTab drops ownership and detaches debugger if attached", async () => {
    const createRes = await bridge.handleMessage({ id: 1, type: "tabs.create", url: "about:blank" });
    const tabId = createRes.result.tabId;
    await bridge.handleMessage({ id: 2, type: "cdp", tabId, method: "Page.reload" });

    expect(bridge.isControlled(tabId)).toBe(true);
    bridge.forgetTab(tabId);
    expect(bridge.isControlled(tabId)).toBe(false);
    expect(detachCalls.length).toBe(1);

    const cdpRes = await bridge.handleMessage({ id: 3, type: "cdp", tabId, method: "Page.reload" });
    expect(cdpRes).toEqual({ id: 3, error: `tab not under agent control: ${tabId}` });
  });

  it("unknown message type answers with error and never throws", async () => {
    const res = await bridge.handleMessage({ id: 99, type: "invalid_action_type" });
    expect(res).toEqual({ id: 99, error: "unknown extension request type: invalid_action_type" });
  });

  it("every reply carries the same request ID", async () => {
    const ids = [42, 107, 9999];
    for (const reqId of ids) {
      const ping = await bridge.handleMessage({ id: reqId, type: "ping" });
      expect(ping.id).toBe(reqId);
    }
  });

  it("tabs.list and tabs_list return every queried tab with agentOwned set correctly", async () => {
    const createRes = await bridge.handleMessage({ id: 1, type: "tabs.create", url: "https://agent.test" });
    const agentTabId = createRes.result.tabId; // 101

    const resDot = await bridge.handleMessage({ id: 2, type: "tabs.list" });
    expect(resDot.error).toBeUndefined();
    expect(resDot.result.tabs).toHaveLength(2);
    const agentTabDot = resDot.result.tabs.find((t: any) => t.tabId === agentTabId);
    const otherTabDot = resDot.result.tabs.find((t: any) => t.tabId === 999);
    expect(agentTabDot).toEqual({
      tabId: 101,
      url: "https://agent.test",
      title: "Test",
      active: true,
      agentOwned: true,
    });
    expect(otherTabDot).toEqual({
      tabId: 999,
      url: "https://uncontrolled.com",
      title: "Uncontrolled",
      active: false,
      agentOwned: false,
    });

    const resUnderscore = await bridge.handleMessage({ id: 3, type: "tabs_list" });
    expect(resUnderscore.error).toBeUndefined();
    expect(resUnderscore.result.tabs).toEqual(resDot.result.tabs);
  });
});

describe("extension static metadata & safety invariants", () => {
  it("manifest.json has manifest_version 3 and permissions including debugger", () => {
    const content = readFileSync(join(process.cwd(), "extension", "manifest.json"), "utf8");
    const manifest = JSON.parse(content);
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.permissions).toContain("debugger");
  });

  it("bridge-core.js contains exact safety error string 'tab not under agent control'", () => {
    const coreContent = readFileSync(join(process.cwd(), "extension", "bridge-core.js"), "utf8");
    expect(coreContent).toContain("tab not under agent control");
  });
});
