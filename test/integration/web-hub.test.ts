import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { startHub, getOrCreateHubToken, resetHubStateForTesting } from "../../src/web/hub.js";

describe("Extension Hub integration test (src/web/hub.ts)", () => {
  let hub: { url: string; port: number; close: () => Promise<void> } | null = null;
  let hubToken: string;

  beforeEach(async () => {
    resetHubStateForTesting();
    hubToken = getOrCreateHubToken();
    hub = await startHub({ port: 0 });
  });

  afterEach(async () => {
    if (hub) {
      await hub.close();
      hub = null;
    }
    resetHubStateForTesting();
  });

  it("GET /v1/web/health without auth returns 200 with extension: false", async () => {
    const res = await fetch(`${hub!.url}/v1/web/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.extension).toBe(false);
    expect(body.extensionId).toBeNull();
  });

  it("POST /v1/web/cdp without auth token returns 401", async () => {
    const res = await fetch(`${hub!.url}/v1/web/cdp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tabId: 1, method: "Runtime.evaluate" }),
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toContain("unauthorized");
  });

  it("POST /v1/web/cdp with token but no extension connected returns 503", async () => {
    const res = await fetch(`${hub!.url}/v1/web/cdp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${hubToken}`,
      },
      body: JSON.stringify({ tabId: 1, method: "Runtime.evaluate" }),
    });
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe("extension not connected");
  });

  it("rejects hello with WRONG token by closing WS connection with code 4001", async () => {
    const wsUrl = `ws://127.0.0.1:${hub!.port}/ext`;
    const ws = new WebSocket(wsUrl);

    const closePromise = new Promise<{ code: number; reason: string }>((resolve) => {
      ws.onclose = (evt) => resolve({ code: evt.code, reason: evt.reason });
    });

    await new Promise<void>((resolve) => {
      ws.onopen = () => resolve();
    });

    const badToken = "wrong-token-value";
    ws.send(JSON.stringify({ type: "hello", token: badToken }));

    const closeInfo = await closePromise;
    expect(closeInfo.code).toBe(4001);

    const healthRes = await fetch(`${hub!.url}/v1/web/health`);
    const health = await healthRes.json();
    expect(health.extension).toBe(false);
  });

  it("accepts hello with CORRECT token, updates health, and handles CDP HTTP request/response routing", async () => {
    const wsUrl = `ws://127.0.0.1:${hub!.port}/ext`;
    const ws = new WebSocket(wsUrl);

    await new Promise<void>((resolve) => {
      ws.onopen = () => resolve();
    });

    // Listen for CDP request sent to fake extension
    ws.onmessage = (event) => {
      const msg = JSON.parse(String(event.data));
      if (msg.type === "cdp" && msg.id) {
        ws.send(JSON.stringify({ id: msg.id, result: { value: 42 } }));
      }
    };

    ws.send(JSON.stringify({ type: "hello", token: hubToken }));

    // Wait 50ms for hello handshake processing
    await new Promise((r) => setTimeout(r, 50));

    const healthRes = await fetch(`${hub!.url}/v1/web/health`);
    const health = await healthRes.json();
    expect(health.extension).toBe(true);

    // Call POST /v1/web/cdp
    const cdpRes = await fetch(`${hub!.url}/v1/web/cdp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${hubToken}`,
      },
      body: JSON.stringify({ tabId: 1, method: "Runtime.evaluate", params: { expression: "1 + 1" } }),
    });

    expect(cdpRes.status).toBe(200);
    const cdpBody = await cdpRes.json();
    expect(cdpBody).toEqual({ value: 42 });

    ws.close();
  });

  it("replaces a active extension connection when a second valid hello arrives (closing first with code 4000)", async () => {
    const wsUrl = `ws://127.0.0.1:${hub!.port}/ext`;
    const ws1 = new WebSocket(wsUrl);

    await new Promise<void>((resolve) => {
      ws1.onopen = () => resolve();
    });

    const close1Promise = new Promise<number>((resolve) => {
      ws1.onclose = (evt) => resolve(evt.code);
    });

    ws1.send(JSON.stringify({ type: "hello", token: hubToken }));
    await new Promise((r) => setTimeout(r, 50));

    // Connect second extension
    const ws2 = new WebSocket(wsUrl);
    await new Promise<void>((resolve) => {
      ws2.onopen = () => resolve();
    });

    ws2.send(JSON.stringify({ type: "hello", token: hubToken }));

    const code1 = await close1Promise;
    expect(code1).toBe(4000);

    const healthRes = await fetch(`${hub!.url}/v1/web/health`);
    const health = await healthRes.json();
    expect(health.extension).toBe(true);

    ws2.close();
  });
});
