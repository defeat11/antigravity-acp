// ACP WebBridge Service Worker (MV3)
import { createBridge } from "./bridge-core.js";

const DEFAULT_CONFIG = {
  enabled: false,
  token: "",
  port: 9334,
};

let ws = null;
let reconnectDelay = 1000;
let reconnectTimer = null;

const bridge = createBridge({
  debugger: {
    attach: (target, version) => chrome.debugger.attach(target, version),
    sendCommand: (target, method, params) => chrome.debugger.sendCommand(target, method, params),
    detach: (target) => chrome.debugger.detach(target),
  },
  tabs: {
    create: (createProperties) => chrome.tabs.create(createProperties),
    remove: (tabIds) => chrome.tabs.remove(tabIds),
    query: (queryInfo) => chrome.tabs.query(queryInfo),
    update: (tabId, updateProperties) => chrome.tabs.update(tabId, updateProperties),
    get: (tabId) => chrome.tabs.get(tabId),
  },
  windows: {
    update: (windowId, updateProperties) => chrome.windows.update(windowId, updateProperties),
  },
});

function updateBadge(status) {
  if (status === "ON") {
    chrome.action.setBadgeText({ text: "ON" });
    chrome.action.setBadgeBackgroundColor({ color: "#2e7d32" });
  } else if (status === "ERROR") {
    chrome.action.setBadgeText({ text: "!" });
    chrome.action.setBadgeBackgroundColor({ color: "#d32f2f" });
  } else {
    chrome.action.setBadgeText({ text: "" });
  }
}

async function getConfig() {
  return new Promise((resolve) => {
    chrome.storage.local.get(DEFAULT_CONFIG, (data) => resolve(data));
  });
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectWebSocket();
  }, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, 30000);
}

async function connectWebSocket() {
  const config = await getConfig();
  if (!config.enabled || !config.token) {
    if (ws) {
      try { ws.close(); } catch {}
      ws = null;
    }
    updateBadge("OFF");
    return;
  }

  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }

  const wsUrl = `ws://127.0.0.1:${config.port || 9334}/ext`;
  try {
    ws = new WebSocket(wsUrl);
  } catch (err) {
    updateBadge("ERROR");
    scheduleReconnect();
    return;
  }

  ws.onopen = async () => {
    reconnectDelay = 1000;
    updateBadge("ON");
    const handoverRes = await bridge.handleMessage({ id: 0, type: "handover.get" });
    const userHandoverTabId = handoverRes?.result?.tabId ?? null;
    ws.send(
      JSON.stringify({
        type: "hello",
        token: config.token,
        handoverTabId: userHandoverTabId,
      })
    );
  };

  ws.onmessage = async (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (typeof msg.id === "number") {
        const reply = await bridge.handleMessage(msg);
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(reply));
        }
      }
    } catch (err) {
      // ignore message parse errors
    }
  };

  ws.onerror = () => {
    updateBadge("ERROR");
  };

  ws.onclose = () => {
    ws = null;
    const isEnabled = config.enabled;
    updateBadge(isEnabled ? "ERROR" : "OFF");
    if (isEnabled) {
      scheduleReconnect();
    }
  };
}

// Wake-up paths. MV3 only starts this worker for events whose listeners are
// registered at the TOP LEVEL, so each of these must stay right here.
//
// onStartup is the one that matters after the browser has been closed and
// reopened: without it the bridge stayed disconnected until the user clicked the
// extension icon — observed live, Chrome running for minutes with the hub up and
// still no connection. The alarm alone is not enough; Chrome may delay or drop it
// across a cold browser start.
chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create("keepalive", { periodInMinutes: 1 });
  connectWebSocket();
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create("keepalive", { periodInMinutes: 1 });
  connectWebSocket();
});

// Alarm backup for service worker lifecycle
chrome.alarms.create("keepalive", { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "keepalive") {
    connectWebSocket();
  }
});

// Storage changes listener
chrome.storage.onChanged.addListener((changes) => {
  if (changes.enabled || changes.token || changes.port) {
    if (ws) {
      try { ws.close(); } catch {}
      ws = null;
    }
    connectWebSocket();
  }
});

// Tab & Debugger cleanup listeners
chrome.tabs.onRemoved.addListener((tabId) => {
  bridge.forgetTab(tabId);
});

chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId) {
    bridge.forgetTab(source.tabId);
  }
});

// Internal runtime message handler for popup interface
chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {
  if (req.type === "popup_get_state") {
    Promise.all([getConfig(), bridge.handleMessage({ id: 0, type: "handover.get" })]).then(
      ([config, handoverRes]) => {
        const userHandoverTabId = handoverRes?.result?.tabId ?? null;
        sendResponse({
          config,
          connected: Boolean(ws && ws.readyState === WebSocket.OPEN),
          controlledCount: bridge.controlledTabs().length,
          userHandoverTabId,
        });
      }
    );
    return true; // Async response
  }

  if (req.type === "popup_handover_current") {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      let handedTabId = null;
      if (tabs[0]?.id) {
        handedTabId = tabs[0].id;
        bridge.setHandover(handedTabId);
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "handover", tabId: handedTabId }));
        }
      }
      sendResponse({ ok: true, tabId: handedTabId });
    });
    return true;
  }

  if (req.type === "popup_revoke_handover") {
    bridge.setHandover(null);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "handover", tabId: null }));
    }
    sendResponse({ ok: true });
    return true;
  }
});

// Initialize on startup
connectWebSocket();
