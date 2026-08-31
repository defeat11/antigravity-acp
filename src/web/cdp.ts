/*
HARD INVARIANT:
This module must NEVER call Runtime.enable, Console.enable, Log.enable, Debugger.enable, Profiler.enable, or
Page.addScriptToEvaluateOnNewDocument. Those are precisely the signals that anti-bot scripts sniff to detect
DevTools/automation. Runtime.evaluate, DOM.*, Input.* and Page.captureScreenshot all work WITHOUT enabling Runtime.
*/

export interface CdpTarget {
  targetId: string;
  type: string;
  url: string;
  title: string;
  webSocketDebuggerUrl?: string;
}

export async function listTargets(port: number): Promise<CdpTarget[]> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/list`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data) ? (data as CdpTarget[]) : [];
  } catch {
    return [];
  }
}

export async function browserWsUrl(port: number): Promise<string> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) {
      throw new Error(`chrome devtools endpoint not reachable on port ${port}`);
    }
    const data = (await res.json()) as { webSocketDebuggerUrl?: string };
    if (!data || typeof data.webSocketDebuggerUrl !== "string") {
      throw new Error(`chrome devtools endpoint not reachable on port ${port}`);
    }
    return data.webSocketDebuggerUrl;
  } catch (err: any) {
    if (err instanceof Error && err.message === `chrome devtools endpoint not reachable on port ${port}`) {
      throw err;
    }
    throw new Error(`chrome devtools endpoint not reachable on port ${port}`);
  }
}

interface PendingRequest {
  method: string;
  resolve: (value: any) => void;
  reject: (reason: any) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class CdpConnection {
  private _ws: WebSocket;
  private _nextId = 1;
  private _pending = new Map<number, PendingRequest>();
  private _eventHandlers = new Map<string, Set<Function>>();
  private _closed = false;
  private _defaultTimeoutMs: number;

  private constructor(ws: WebSocket, timeoutMs?: number) {
    this._ws = ws;
    this._defaultTimeoutMs = timeoutMs ?? 30000;

    this._ws.onmessage = (event: MessageEvent) => {
      this._handleMessage(event.data);
    };

    this._ws.onerror = () => {
      if (this._closed) return;
      this._handleClose();
    };

    this._ws.onclose = () => {
      this._handleClose();
    };
  }

  static connect(wsUrl: string, opts?: { timeoutMs?: number }): Promise<CdpConnection> {
    const timeoutMs = opts?.timeoutMs ?? 10000;
    return new Promise((resolve, reject) => {
      let ws: WebSocket;
      try {
        ws = new WebSocket(wsUrl);
      } catch (err) {
        return reject(err);
      }

      let opened = false;
      let timer: ReturnType<typeof setTimeout> | null = null;

      const cleanup = () => {
        if (timer) clearTimeout(timer);
        ws.onopen = null;
        ws.onerror = null;
      };

      timer = setTimeout(() => {
        if (!opened) {
          cleanup();
          try {
            ws.close();
          } catch {}
          reject(new Error("cdp connect timeout"));
        }
      }, timeoutMs);

      ws.onopen = () => {
        opened = true;
        cleanup();
        const conn = new CdpConnection(ws, opts?.timeoutMs);
        resolve(conn);
      };

      ws.onerror = (evt) => {
        if (!opened) {
          cleanup();
          reject(evt instanceof Error ? evt : new Error("WebSocket error before open"));
        }
      };
    });
  }

  get closed(): boolean {
    return this._closed;
  }

  send<T = any>(method: string, params?: object, sessionId?: string): Promise<T> {
    if (this._closed) {
      return Promise.reject(new Error("cdp connection closed"));
    }

    const id = this._nextId++;
    const message: Record<string, any> = { id, method };
    if (params !== undefined) message.params = params;
    if (sessionId !== undefined) message.sessionId = sessionId;

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`cdp timeout: ${method}`));
      }, this._defaultTimeoutMs);

      this._pending.set(id, {
        method,
        resolve: (val: any) => resolve(val as T),
        reject,
        timer,
      });

      try {
        this._ws.send(JSON.stringify(message));
      } catch (err) {
        clearTimeout(timer);
        this._pending.delete(id);
        reject(err);
      }
    });
  }

  on(event: string, handler: (params: any, sessionId?: string) => void): () => void {
    if (!this._eventHandlers.has(event)) {
      this._eventHandlers.set(event, new Set());
    }
    const set = this._eventHandlers.get(event)!;
    set.add(handler);

    return () => {
      set.delete(handler);
      if (set.size === 0) {
        this._eventHandlers.delete(event);
      }
    };
  }

  close(): void {
    if (this._closed) return;
    this._closed = true;
    try {
      this._ws.close();
    } catch {}
    this._handleClose();
  }

  private _handleClose(): void {
    this._closed = true;
    if (this._pending.size === 0) return;

    for (const pending of this._pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("cdp connection closed"));
    }
    this._pending.clear();
  }

  private _handleMessage(data: any): void {
    let msg: any;
    try {
      const text = typeof data === "string" ? data : data.toString();
      msg = JSON.parse(text);
    } catch {
      return;
    }

    if (typeof msg.id === "number") {
      const pending = this._pending.get(msg.id);
      if (pending) {
        this._pending.delete(msg.id);
        clearTimeout(pending.timer);
        if (msg.error) {
          pending.reject(
            new Error(`cdp error: ${pending.method}: ${msg.error.message} (code ${msg.error.code})`)
          );
        } else {
          pending.resolve(msg.result);
        }
      }
    } else if (msg.method) {
      const handlers = this._eventHandlers.get(msg.method);
      if (handlers) {
        for (const handler of Array.from(handlers)) {
          try {
            handler(msg.params, msg.sessionId);
          } catch {
            // A handler that throws must not break the dispatch loop
          }
        }
      }

      // Handlers registered under "*" receive (method, params, sessionId)
      const starHandlers = this._eventHandlers.get("*");
      if (starHandlers) {
        for (const handler of Array.from(starHandlers)) {
          try {
            handler(msg.method, msg.params, msg.sessionId);
          } catch {
            // A handler that throws must not break the dispatch loop
          }
        }
      }
    }
  }
}

export async function attachToPage(conn: CdpConnection, targetId: string): Promise<string> {
  const res = await conn.send<{ sessionId: string }>("Target.attachToTarget", {
    targetId,
    flatten: true,
  });
  return res.sessionId;
}
