// ACP WebBridge Core Business Logic (pure ES module, testable without browser)

export function createBridge(deps) {
  const agentOwnedTabs = new Set();
  const attachedTabs = new Set();
  let userHandoverTabId = null;

  function isControlled(tabId) {
    const numericId = Number(tabId);
    return agentOwnedTabs.has(numericId) || userHandoverTabId === numericId;
  }

  function noteTabCreated(tabId) {
    if (tabId !== undefined && tabId !== null) {
      agentOwnedTabs.add(Number(tabId));
    }
  }

  function setHandover(tabId) {
    if (tabId === null || tabId === undefined) {
      if (userHandoverTabId !== null && attachedTabs.has(userHandoverTabId)) {
        try {
          deps.debugger.detach({ tabId: userHandoverTabId });
        } catch {}
        attachedTabs.delete(userHandoverTabId);
      }
      userHandoverTabId = null;
    } else {
      userHandoverTabId = Number(tabId);
    }
  }

  function forgetTab(tabId) {
    const numericId = Number(tabId);
    agentOwnedTabs.delete(numericId);
    if (attachedTabs.has(numericId)) {
      try {
        deps.debugger.detach({ tabId: numericId });
      } catch {}
      attachedTabs.delete(numericId);
    }
    if (userHandoverTabId === numericId) {
      userHandoverTabId = null;
    }
  }

  function controlledTabs() {
    const list = Array.from(agentOwnedTabs);
    if (userHandoverTabId !== null && !agentOwnedTabs.has(userHandoverTabId)) {
      list.push(userHandoverTabId);
    }
    return list;
  }

  async function attachDebuggerIfNeeded(tabId) {
    const numericId = Number(tabId);
    if (attachedTabs.has(numericId)) return;
    try {
      await deps.debugger.attach({ tabId: numericId }, "1.3");
      attachedTabs.add(numericId);
    } catch (err) {
      const msg = String(err?.message || err);
      if (msg.includes("Already attached") || msg.includes("Another debugger")) {
        attachedTabs.add(numericId);
      } else {
        throw err;
      }
    }
  }

  async function handleMessage(msg) {
    if (!msg || typeof msg !== "object") {
      return { error: "invalid message format" };
    }

    const { id, type } = msg;

    try {
      if (type === "ping") {
        return { id, result: { pong: true } };
      }

      if (type === "handover.get") {
        return { id, result: { tabId: userHandoverTabId } };
      }

      if (type === "tabs.list" || type === "tabs_list") {
        const tabs = (await deps.tabs.query({})) || [];
        const mapped = tabs.map((t) => ({
          tabId: t.id,
          url: t.url || "",
          title: t.title || "",
          active: Boolean(t.active),
          agentOwned: isControlled(t.id),
        }));
        return { id, result: { tabs: mapped } };
      }

      if (type === "tabs.create" || type === "tabs_create") {
        const url = msg.url || "about:blank";
        const tab = await deps.tabs.create({ url, active: false });
        if (tab && tab.id !== undefined) {
          noteTabCreated(tab.id);
        }
        return { id, result: { tabId: tab.id, url: tab.url || url } };
      }

      if (type === "tabs.close" || type === "tabs_close") {
        const tabId = Number(msg.tabId);
        if (!isControlled(tabId)) {
          return { id, error: `tab not under agent control: ${tabId}` };
        }
        forgetTab(tabId);
        await deps.tabs.remove(tabId);
        return { id, result: { ok: true } };
      }

      if (type === "tabs.focus" || type === "tabs_focus") {
        const tabId = Number(msg.tabId);
        if (!isControlled(tabId)) {
          return { id, error: `tab not under agent control: ${tabId}` };
        }
        if (deps.tabs.update) {
          await deps.tabs.update(tabId, { active: true });
        }
        let windowId = null;
        if (deps.tabs.get) {
          const tabInfo = await deps.tabs.get(tabId);
          windowId = tabInfo?.windowId ?? null;
        }
        if (windowId !== null && windowId !== undefined && deps.windows?.update) {
          await deps.windows.update(windowId, { state: "normal", focused: true });
        }
        return { id, result: { ok: true, windowId } };
      }

      if (type === "cdp") {
        const tabId = Number(msg.tabId);
        if (!isControlled(tabId)) {
          return { id, error: `tab not under agent control: ${tabId}` };
        }

        await attachDebuggerIfNeeded(tabId);
        const res = await deps.debugger.sendCommand({ tabId }, msg.method, msg.params);
        return { id, result: res };
      }

      return { id, error: `unknown extension request type: ${type}` };
    } catch (err) {
      return { id, error: String(err?.message || err) };
    }
  }

  return {
    handleMessage,
    noteTabCreated,
    setHandover,
    forgetTab,
    controlledTabs,
    isControlled,
  };
}
