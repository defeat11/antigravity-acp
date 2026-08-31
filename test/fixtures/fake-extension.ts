// Fake Extension Fixture for Integration Testing

export interface FakeExtensionOptions {
  hubPort: number;
  token: string;
  onCdp: (tabId: number, method: string, params: any) => any | Promise<any>;
  onTabsCreate?: (url: string) => { tabId: number; url: string } | Promise<{ tabId: number; url: string }>;
  handoverTabId?: number;
}

export async function startFakeExtension(opts: FakeExtensionOptions): Promise<{ stop(): Promise<void> }> {
  const wsUrl = `ws://127.0.0.1:${opts.hubPort}/ext`;
  const ws = new WebSocket(wsUrl);

  let controlledTabs = new Set<number>();
  let handoverTabId = opts.handoverTabId ?? null;
  if (handoverTabId !== null) {
    controlledTabs.add(handoverTabId);
  }

  let autoTabIdCounter = 1000;

  return new Promise((resolve, reject) => {
    const connectTimeout = setTimeout(() => {
      try { ws.close(); } catch {}
      reject(new Error("fake extension WS connection timeout"));
    }, 5000);

    ws.onopen = async () => {
      clearTimeout(connectTimeout);
      ws.send(
        JSON.stringify({
          type: "hello",
          token: opts.token,
          handoverTabId,
        })
      );

      // Wait 50ms for hub hello processing
      await new Promise((r) => setTimeout(r, 50));

      resolve({
        async stop() {
          if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
            ws.close();
          }
        },
      });
    };

    ws.onerror = (err) => {
      clearTimeout(connectTimeout);
      reject(err);
    };

    ws.onmessage = async (event) => {
      try {
        const msg = JSON.parse(String(event.data));
        if (!msg || typeof msg.id !== "number") return;
        const { id, type } = msg;

        if (type === "ping") {
          ws.send(JSON.stringify({ id, result: { pong: true } }));
          return;
        }

        if (type === "handover.get") {
          ws.send(JSON.stringify({ id, result: { tabId: handoverTabId } }));
          return;
        }

        if (type === "tabs.list" || type === "tabs_list") {
          const tabs = Array.from(controlledTabs).map((tId) => ({
            tabId: tId,
            url: "about:blank",
            title: "Test Tab",
            active: true,
            agentOwned: true,
          }));
          ws.send(JSON.stringify({ id, result: { tabs } }));
          return;
        }

        if (type === "tabs.create" || type === "tabs_create") {
          const url = msg.url || "about:blank";
          let created: { tabId: number; url: string };
          if (opts.onTabsCreate) {
            created = await opts.onTabsCreate(url);
          } else {
            created = { tabId: ++autoTabIdCounter, url };
          }
          controlledTabs.add(created.tabId);
          ws.send(JSON.stringify({ id, result: created }));
          return;
        }

        if (type === "tabs.close" || type === "tabs_close") {
          const tabId = Number(msg.tabId);
          if (!controlledTabs.has(tabId)) {
            ws.send(JSON.stringify({ id, error: `tab not under agent control: ${tabId}` }));
            return;
          }
          controlledTabs.delete(tabId);
          if (handoverTabId === tabId) handoverTabId = null;
          ws.send(JSON.stringify({ id, result: { ok: true } }));
          return;
        }

        if (type === "cdp") {
          const tabId = Number(msg.tabId);
          if (!controlledTabs.has(tabId)) {
            ws.send(JSON.stringify({ id, error: `tab not under agent control: ${tabId}` }));
            return;
          }
          try {
            const res = await opts.onCdp(tabId, msg.method, msg.params);
            ws.send(JSON.stringify({ id, result: res }));
          } catch (err: any) {
            ws.send(JSON.stringify({ id, error: String(err?.message || err) }));
          }
          return;
        }

        ws.send(JSON.stringify({ id, error: `unknown extension request type: ${type}` }));
      } catch (err) {
        // ignore parse error
      }
    };
  });
}
