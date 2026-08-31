import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { WsConnection, attachWebSocketServer } from "./wsserver.js";

export const DEFAULT_HUB_PORT = 9334;

export function hubTokenPath(): string {
  return join(homedir(), ".acp", "web-ext-token");
}

export function getOrCreateHubToken(): string {
  const pPath = hubTokenPath();
  if (existsSync(pPath)) {
    return readFileSync(pPath, "utf8").trim();
  }
  return rotateHubToken();
}

export function rotateHubToken(): string {
  const pPath = hubTokenPath();
  const parentDir = dirname(pPath);
  mkdirSync(parentDir, { recursive: true });
  const token = randomBytes(32).toString("hex");
  writeFileSync(pPath, token, "utf8");
  try {
    chmodSync(pPath, 0o600);
  } catch {
    // Ignore chmod failure on platforms without POSIX permissions (e.g. Windows)
  }
  return token;
}

/**
 * Identity of the build this process is running.
 *
 * The hub is long-lived: it survives every rebuild, so a hub started hours ago
 * happily serves an old routing table. That is not theoretical — the whole
 * window-restore feature silently did nothing because the running hub predated
 * the endpoint and answered 404, while everything else looked healthy.
 */
export function hubBuildId(): string {
  try {
    const here = fileURLToPath(import.meta.url);
    return String(Math.floor(statSync(here).mtimeMs));
  } catch {
    return "unknown";
  }
}

export function hubPidPath(): string {
  return join(homedir(), ".acp", "web-hub.pid");
}

/**
 * Last-resort retirement for a hub that predates the graceful /shutdown endpoint.
 * A stale hub cannot be asked politely to leave — it never learned how — so the
 * pid it recorded at startup is the only handle we have on it.
 */
export function killHubByPidFile(): boolean {
  try {
    const p = hubPidPath();
    if (!existsSync(p)) return false;
    const pid = Number(readFileSync(p, "utf8").trim());
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false;
    process.kill(pid);
    return true;
  } catch {
    return false;
  }
}

export async function hubHealth(
  port?: number,
): Promise<{ ok: boolean; buildId?: string; extension?: boolean } | null> {
  const p = port ?? (Number(process.env.ACP_WEB_HUB_PORT) || DEFAULT_HUB_PORT);
  try {
    const res = await fetch(`http://127.0.0.1:${p}/v1/web/health`, {
      signal: AbortSignal.timeout(800),
    });
    if (!res.ok) return null;
    return (await res.json()) as { ok: boolean; buildId?: string; extension?: boolean };
  } catch {
    return null;
  }
}

export async function isHubUp(port?: number): Promise<boolean> {
  const p = port ?? (Number(process.env.ACP_WEB_HUB_PORT) || DEFAULT_HUB_PORT);
  try {
    const res = await fetch(`http://127.0.0.1:${p}/v1/web/health`, {
      signal: AbortSignal.timeout(800),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Start the hub if it is not already running, and wait until it answers.
 *
 * The hub used to be the user's problem: a foreground `acp web hub start` that
 * died with every reboot and produced a misleading "extension not connected"
 * afterwards. Every command that needs the bridge calls this instead, so the
 * toolkit looks after its own daemon.
 */
export async function ensureHub(o?: { port?: number; timeoutMs?: number }): Promise<{
  started: boolean;
  port: number;
}> {
  const port = o?.port ?? (Number(process.env.ACP_WEB_HUB_PORT) || DEFAULT_HUB_PORT);
  const timeoutMs = o?.timeoutMs ?? 10000;

  const current = hubBuildId();
  const health = await hubHealth(port);
  if (health?.ok) {
    if (health.buildId === current) return { started: false, port };
    // A hub from an older build is worse than no hub: it answers, looks healthy,
    // and quietly 404s the endpoints added since. Retire it and start fresh.
    try {
      await fetch(`http://127.0.0.1:${port}/v1/web/shutdown`, {
        method: "POST",
        headers: { Authorization: `Bearer ${getOrCreateHubToken()}` },
        signal: AbortSignal.timeout(2000),
      });
    } catch {
      // It may die before answering; that is the desired outcome anyway.
    }
    let deadline = Date.now() + 3000;
    while (Date.now() < deadline && (await isHubUp(port))) {
      await new Promise((r) => setTimeout(r, 200));
    }
    if (await isHubUp(port)) {
      // It ignored the request (older builds have no /shutdown at all).
      killHubByPidFile();
      deadline = Date.now() + 3000;
      while (Date.now() < deadline && (await isHubUp(port))) {
        await new Promise((r) => setTimeout(r, 200));
      }
    }
  }

  const here = fileURLToPath(import.meta.url); // <dist>/web/hub.js
  const cli = join(dirname(dirname(here)), "web-cli.js");
  const child = spawn(process.execPath, [cli, "hub", "start", "--port", String(port)], {
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  child.unref();

  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    await new Promise((r) => setTimeout(r, 250));
    if (await isHubUp(port)) return { started: true, port };
  }
  throw new Error(`hub did not come up on 127.0.0.1:${port} within ${timeoutMs}ms`);
}

interface PendingHubRequest {
  resolve: (value: any) => void;
  reject: (reason: any) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface ActiveExtensionConnection {
  ws: WsConnection;
  connectedAt: string;
  extensionId: string;
  lastSeen: number;
}

let activeExt: ActiveExtensionConnection | null = null;
let userHandoverTabId: number | null = null;
let nextRequestId = 1;
const pendingRequests = new Map<number, PendingHubRequest>();
let keepaliveInterval: ReturnType<typeof setInterval> | null = null;

export function verifyOrigin(origin: string | undefined): boolean {
  if (!origin) return true; // Accept Node CLI / test clients (no Origin header)
  if (origin.startsWith("chrome-extension://")) return true;
  if (origin.startsWith("http://") || origin.startsWith("https://")) return false;
  return false;
}

function checkHubAuth(req: IncomingMessage, hubToken: string): boolean {
  try {
    let header = req.headers["authorization"];
    if (Array.isArray(header)) header = header[0];
    if (!header || !header.startsWith("Bearer ")) return false;
    const supplied = header.slice(7);
    if (supplied.length !== hubToken.length) return false;
    return timingSafeEqual(Buffer.from(supplied), Buffer.from(hubToken));
  } catch {
    return false;
  }
}

export function callExtension<T = any>(payload: object, timeoutMs = 30000): Promise<T> {
  if (!activeExt || activeExt.ws.closed) {
    return Promise.reject(new Error("extension not connected"));
  }

  const id = nextRequestId++;
  const message = JSON.stringify({ id, ...payload });

  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingRequests.delete(id);
      reject(new Error("extension request timeout"));
    }, timeoutMs);

    pendingRequests.set(id, { resolve, reject, timer });

    try {
      activeExt!.ws.send(message);
    } catch (err) {
      clearTimeout(timer);
      pendingRequests.delete(id);
      reject(err);
    }
  });
}

export function resetHubStateForTesting(): void {
  if (activeExt) {
    try {
      activeExt.ws.close(1000, "test reset");
    } catch {}
    activeExt = null;
  }
  userHandoverTabId = null;
  for (const pending of pendingRequests.values()) {
    clearTimeout(pending.timer);
    pending.reject(new Error("hub reset"));
  }
  pendingRequests.clear();
  if (keepaliveInterval) {
    clearInterval(keepaliveInterval);
    keepaliveInterval = null;
  }
}

export async function startHub(o?: { port?: number }): Promise<{
  url: string;
  port: number;
  close: () => Promise<void>;
}> {
  const port = o?.port ?? (Number(process.env.ACP_WEB_HUB_PORT) || DEFAULT_HUB_PORT);
  // Ensure the token file exists at startup; every check re-reads it from disk.
  getOrCreateHubToken();
  try {
    mkdirSync(dirname(hubPidPath()), { recursive: true });
    writeFileSync(hubPidPath(), String(process.pid), "utf8");
  } catch {
    // Not fatal: only the forced-retirement path depends on it.
  }

  const handleMessageFromExtension = (ws: WsConnection, text: string) => {
    let msg: any;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }

    if (activeExt && activeExt.ws === ws) {
      activeExt.lastSeen = Date.now();
    }

    if (typeof msg.id === "number") {
      const pending = pendingRequests.get(msg.id);
      if (pending) {
        pendingRequests.delete(msg.id);
        clearTimeout(pending.timer);
        if (msg.error) {
          pending.reject(new Error(String(msg.error)));
        } else {
          pending.resolve(msg.result !== undefined ? msg.result : msg);
        }
      }
    } else if (msg.type === "handover" && typeof msg.tabId === "number") {
      userHandoverTabId = msg.tabId;
    }
  };

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const sendJson = (status: number, body: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };

    try {
      const url = req.url || "/";
      const method = req.method || "GET";

      if (method === "GET" && url === "/v1/web/health") {
        sendJson(200, {
          ok: true,
          extension: Boolean(activeExt && !activeExt.ws.closed),
          extensionId: activeExt ? activeExt.extensionId : null,
          connectedAt: activeExt ? activeExt.connectedAt : null,
          port,
          buildId: hubBuildId(),
        });
        return;
      }

      // Lets a newer build retire this process cleanly instead of leaving a
      // stale hub answering 404 for endpoints it never had.
      if (method === "POST" && url === "/v1/web/shutdown") {
        if (!checkHubAuth(req, getOrCreateHubToken())) {
          sendJson(401, { error: "unauthorized" });
          return;
        }
        sendJson(200, { ok: true, stopping: true });
        setTimeout(() => process.exit(0), 150);
        return;
      }

      if (!checkHubAuth(req, getOrCreateHubToken())) {
        sendJson(401, { error: "unauthorized — missing or invalid Bearer token" });
        return;
      }

      if (method === "GET" && url === "/v1/web/handover") {
        sendJson(200, { tabId: userHandoverTabId });
        return;
      }

      if (method === "POST" && url === "/v1/web/cdp") {
        let bodyStr = "";
        req.setEncoding("utf8");
        for await (const chunk of req) {
          bodyStr += chunk;
          if (bodyStr.length > 32 * 1024 * 1024) {
            sendJson(413, { error: "payload too large" });
            return;
          }
        }
        let body: any;
        try {
          body = JSON.parse(bodyStr);
        } catch {
          sendJson(400, { error: "invalid JSON body" });
          return;
        }

        try {
          const result = await callExtension({
            type: "cdp",
            tabId: body.tabId,
            method: body.method,
            params: body.params,
          });
          sendJson(200, result);
        } catch (err: any) {
          sendJson(503, { error: "extension not connected" });
        }
        return;
      }

      if (method === "POST" && url === "/v1/web/tabs/create") {
        let bodyStr = "";
        req.setEncoding("utf8");
        for await (const chunk of req) {
          bodyStr += chunk;
        }
        let body: any = {};
        if (bodyStr.trim()) {
          try {
            body = JSON.parse(bodyStr);
          } catch {}
        }

        try {
          const result = await callExtension({ type: "tabs_create", url: body.url });
          sendJson(200, result);
        } catch {
          sendJson(503, { error: "extension not connected" });
        }
        return;
      }

      if (method === "GET" && url === "/v1/web/tabs") {
        try {
          const result = await callExtension({ type: "tabs_list" });
          sendJson(200, result);
        } catch {
          sendJson(503, { error: "extension not connected" });
        }
        return;
      }

      if (method === "POST" && url === "/v1/web/tabs/close") {
        let bodyStr = "";
        req.setEncoding("utf8");
        for await (const chunk of req) {
          bodyStr += chunk;
        }
        let body: any = {};
        if (bodyStr.trim()) {
          try {
            body = JSON.parse(bodyStr);
          } catch {}
        }

        try {
          await callExtension({ type: "tabs_close", tabId: body.tabId });
          sendJson(200, { ok: true });
        } catch {
          sendJson(503, { error: "extension not connected" });
        }
        return;
      }

      if (method === "POST" && url === "/v1/web/tabs/focus") {
        let bodyStr = "";
        req.setEncoding("utf8");
        for await (const chunk of req) {
          bodyStr += chunk;
        }
        let body: any = {};
        if (bodyStr.trim()) {
          try {
            body = JSON.parse(bodyStr);
          } catch {}
        }

        try {
          const result = await callExtension({ type: "tabs_focus", tabId: body.tabId });
          sendJson(200, result);
        } catch {
          sendJson(503, { error: "extension not connected" });
        }
        return;
      }

      sendJson(404, { error: "not found" });
    } catch {
      sendJson(503, { error: "extension not connected" });
    }
  });

  attachWebSocketServer(server, {
    path: "/ext",
    verifyOrigin,
    onConnection: (ws: WsConnection, req: IncomingMessage) => {
      const origin = req.headers["origin"] as string | undefined;
      const extId = origin ? origin.replace(/^chrome-extension:\/\//, "") : "unknown";

      let helloReceived = false;
      const helloTimer = setTimeout(() => {
        if (!helloReceived) {
          ws.close(4001, "unauthorized");
        }
      }, 3000);

      ws.on("message", (text: string) => {
        if (!helloReceived) {
          let msg: any;
          try {
            msg = JSON.parse(text);
          } catch {
            ws.close(4001, "unauthorized");
            return;
          }

          if (msg?.type === "hello" && typeof msg.token === "string") {
            const supplied = msg.token;
            // Read from disk, never from a value captured at startup: a hub holding
            // a stale token rejects the extension with a 401 that looks exactly like
            // "extension not connected". That cost us a debugging round already.
            const hubToken = getOrCreateHubToken();
            if (
              supplied.length === hubToken.length &&
              timingSafeEqual(Buffer.from(supplied), Buffer.from(hubToken))
            ) {
              helloReceived = true;
              clearTimeout(helloTimer);

              // Close existing connection if present
              if (activeExt && !activeExt.ws.closed) {
                activeExt.ws.close(4000, "replaced");
              }

              activeExt = {
                ws,
                connectedAt: new Date().toISOString(),
                extensionId: extId,
                lastSeen: Date.now(),
              };

              if (typeof msg.handoverTabId === "number") {
                userHandoverTabId = msg.handoverTabId;
              }
              return;
            }
          }
          ws.close(4001, "unauthorized");
          return;
        }

        handleMessageFromExtension(ws, text);
      });

      ws.on("close", () => {
        clearTimeout(helloTimer);
        if (activeExt && activeExt.ws === ws) {
          activeExt = null;
          for (const pending of pendingRequests.values()) {
            clearTimeout(pending.timer);
            pending.reject(new Error("extension disconnected"));
          }
          pendingRequests.clear();
        }
      });
    },
  });

  // Keepalive interval: ping every 20s
  keepaliveInterval = setInterval(() => {
    if (activeExt) {
      if (activeExt.ws.closed) {
        activeExt = null;
      } else if (Date.now() - activeExt.lastSeen > 45000) {
        activeExt.ws.close(1001, "ping timeout");
        activeExt = null;
      } else {
        activeExt.ws.ping();
      }
    }
  }, 20000);

  return new Promise((resolve, reject) => {
    server.on("error", (err) => reject(err));
    server.listen(port, "127.0.0.1", () => {
      const addressInfo = server.address() as import("node:net").AddressInfo;
      const actualPort = addressInfo.port;
      resolve({
        url: `http://127.0.0.1:${actualPort}`,
        port: actualPort,
        close: () =>
          new Promise<void>((resClose) => {
            if (keepaliveInterval) {
              clearInterval(keepaliveInterval);
              keepaliveInterval = null;
            }
            if (activeExt) {
              try {
                activeExt.ws.close(1000, "hub shutting down");
              } catch {}
              activeExt = null;
            }
            for (const pending of pendingRequests.values()) {
              clearTimeout(pending.timer);
              pending.reject(new Error("hub shutting down"));
            }
            pendingRequests.clear();
            server.close(() => resClose());
          }),
      });
    });
  });
}
