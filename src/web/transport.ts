import { CdpConnection, browserWsUrl, attachToPage } from "./cdp.js";
import { DEFAULT_PORT, ensureChrome, ensureDefaultChrome } from "./chrome.js";
import { getOrCreateHubToken, ensureHub } from "./hub.js";

export interface CdpTransport {
  readonly kind: "direct" | "extension";
  readonly targetId: string;
  send<T = any>(method: string, params?: object): Promise<T>;
  closeTab(): Promise<void>;
  detach(): void;
  focusTab(): Promise<boolean>;
}

export class DirectTransport implements CdpTransport {
  readonly kind = "direct";

  private constructor(
    private _conn: CdpConnection,
    public readonly targetId: string,
    private _sessionId: string
  ) {}

  static async openNewTab(o?: { profile?: string; port?: number; startUrl?: string }): Promise<DirectTransport> {
    const res = await ensureChrome({ profile: o?.profile, port: o?.port, startUrl: o?.startUrl });
    const port = res.port;
    const wsUrl = await browserWsUrl(port);
    const conn = await CdpConnection.connect(wsUrl);
    const target = await conn.send<{ targetId: string }>("Target.createTarget", {
      url: o?.startUrl ?? "about:blank",
    });
    const targetId = target.targetId;
    const sessionId = await attachToPage(conn, targetId);
    return new DirectTransport(conn, targetId, sessionId);
  }

  static async attachTab(o: { port?: number; targetId: string }): Promise<DirectTransport> {
    const port = o.port ?? DEFAULT_PORT;
    const wsUrl = await browserWsUrl(port);
    const conn = await CdpConnection.connect(wsUrl);
    const sessionId = await attachToPage(conn, o.targetId);
    return new DirectTransport(conn, o.targetId, sessionId);
  }

  send<T = any>(method: string, params?: object): Promise<T> {
    return this._conn.send<T>(method, params, this._sessionId);
  }

  async closeTab(): Promise<void> {
    try {
      await this._conn.send("Target.closeTarget", { targetId: this.targetId });
    } catch {}
    this.detach();
  }

  detach(): void {
    try {
      this._conn.close();
    } catch {}
  }

  async focusTab(): Promise<boolean> {
    try {
      const win = await this._conn.send<{ windowId: number }>("Browser.getWindowForTarget", {
        targetId: this.targetId,
      });
      if (win && typeof win.windowId === "number") {
        await this._conn.send("Browser.setWindowBounds", {
          windowId: win.windowId,
          bounds: { windowState: "normal" },
        });
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }
}

/**
 * Bring the whole extension path up: hub running, Chrome open on the profile that
 * carries the extension, bridge connected. Any consumer (CLI, tools, tests) should
 * call this instead of assuming the bridge is ready — the self-healing used to live
 * inside the CLI only, so scripts under tools/ died with "extension not connected"
 * while the CLI recovered from the very same state.
 */
export async function ensureExtensionReady(o?: {
  hubPort?: number;
  waitMs?: number;
}): Promise<{ ready: boolean; actions: string[]; status: { up: boolean; extension: boolean; port: number } }> {
  const actions: string[] = [];
  const waitMs = o?.waitMs ?? 95000;

  try {
    const hub = await ensureHub({ port: o?.hubPort });
    if (hub.started) actions.push("started the hub");
  } catch {
    // reported through status below
  }

  let status = await hubStatus(o?.hubPort);
  if (status.extension) return { ready: true, actions, status };

  if (status.up) {
    try {
      const ch = await ensureDefaultChrome();
      if (ch.launched) actions.push(`opened Chrome (profile ${ch.profileDirectory ?? "default"})`);
    } catch {
      // fall through to the wait; the caller reports the final state
    }
    const until = Date.now() + waitMs;
    while (Date.now() < until && !status.extension) {
      await new Promise((r) => setTimeout(r, 2000));
      status = await hubStatus(o?.hubPort);
    }
  }

  return { ready: status.extension, actions, status };
}

export async function hubStatus(hubPort?: number): Promise<{ up: boolean; extension: boolean; port: number }> {
  const port = hubPort ?? (Number(process.env.ACP_WEB_HUB_PORT) || 9334);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/web/health`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) {
      return { up: false, extension: false, port };
    }
    const data = (await res.json()) as { ok?: boolean; extension?: boolean };
    return {
      up: Boolean(data?.ok),
      extension: Boolean(data?.extension),
      port,
    };
  } catch {
    return { up: false, extension: false, port };
  }
}

export class ExtensionTransport implements CdpTransport {
  readonly kind = "extension";

  private constructor(
    public readonly targetId: string,
    private _hubPort: number,
    private _token: string
  ) {}

  private static _getHubDetails(hubPort?: number): { port: number; token: string } {
    const port = hubPort ?? (Number(process.env.ACP_WEB_HUB_PORT) || 9334);
    const token = getOrCreateHubToken();
    return { port, token };
  }

  /**
   * Turn a failed hub response into a message that names the ACTUAL problem.
   * Reporting every failure as "extension not connected" sent us chasing the
   * wrong fix once already: the hub was up and the extension was connected, but
   * it was answering 401 because a test run had rotated the token underneath it.
   */
  static async _hubError(res: Response, port: number): Promise<Error> {
    if (res.status === 401) {
      return new Error(
        `hub rejected the token — the hub on port ${port} is running with a different token; restart it (\`acp web hub start\`) and re-paste \`acp web hub token\` into the extension popup`
      );
    }
    if (res.status === 503) {
      return new Error(
        "extension not connected — run `acp web hub start` and switch the bridge on in the extension popup"
      );
    }
    let body = "";
    try {
      body = (await res.text()).slice(0, 200);
    } catch {}
    return new Error(`hub error ${res.status}${body ? `: ${body}` : ""}`);
  }

  static _unreachable(port: number): Error {
    return new Error(`hub not reachable on 127.0.0.1:${port} — run \`acp web hub start\``);
  }

  static async createTab(o?: { hubPort?: number; url?: string }): Promise<ExtensionTransport> {
    const { port, token } = ExtensionTransport._getHubDetails(o?.hubPort);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/v1/web/tabs/create`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ url: o?.url ?? "about:blank" }),
      });
      if (!res.ok) {
        throw await ExtensionTransport._hubError(res, port);
      }
      const data = (await res.json()) as { tabId?: number };
      if (typeof data?.tabId !== "number") {
        throw new Error("invalid tab creation response from extension hub");
      }
      return new ExtensionTransport(String(data.tabId), port, token);
    } catch (err: any) {
      if (err instanceof Error && !(err as any).cause && err.name !== "TypeError") {
        throw err;
      }
      throw ExtensionTransport._unreachable(port);
    }
  }

  static async attachTab(o: { hubPort?: number; tabId: number }): Promise<ExtensionTransport> {
    const { port, token } = ExtensionTransport._getHubDetails(o.hubPort);
    return new ExtensionTransport(String(o.tabId), port, token);
  }

  static async handover(o?: { hubPort?: number }): Promise<ExtensionTransport | null> {
    const { port, token } = ExtensionTransport._getHubDetails(o?.hubPort);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/v1/web/handover`, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });
      if (!res.ok) return null;
      const data = (await res.json()) as { tabId?: number | null };
      if (typeof data?.tabId !== "number") return null;
      return new ExtensionTransport(String(data.tabId), port, token);
    } catch {
      return null;
    }
  }

  static async listTabs(o?: {
    hubPort?: number;
  }): Promise<Array<{ tabId: number; url: string; title: string; active: boolean; agentOwned: boolean }>> {
    const { port, token } = ExtensionTransport._getHubDetails(o?.hubPort);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/v1/web/tabs`, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });
      if (!res.ok) return [];
      const data = (await res.json()) as {
        tabs?: Array<{ tabId: number; url: string; title: string; active: boolean; agentOwned: boolean }>;
      };
      return data?.tabs ?? [];
    } catch {
      return [];
    }
  }

  async send<T = any>(method: string, params?: object): Promise<T> {
    try {
      const res = await fetch(`http://127.0.0.1:${this._hubPort}/v1/web/cdp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this._token}`,
        },
        body: JSON.stringify({
          tabId: Number(this.targetId),
          method,
          params,
        }),
      });

      if (!res.ok) {
        throw await ExtensionTransport._hubError(res, this._hubPort);
      }

      const data = await res.json();
      if (data && typeof data === "object" && "error" in data) {
        throw new Error(String((data as any).error));
      }
      return data as T;
    } catch (err: any) {
      // Only a genuine network failure (fetch rejects with a TypeError) means the
      // hub is unreachable; every other error already carries its real cause.
      if (err instanceof Error && err.name !== "TypeError") {
        throw err;
      }
      throw ExtensionTransport._unreachable(this._hubPort);
    }
  }

  async closeTab(): Promise<void> {
    try {
      await fetch(`http://127.0.0.1:${this._hubPort}/v1/web/tabs/close`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this._token}`,
        },
        body: JSON.stringify({ tabId: Number(this.targetId) }),
      });
    } catch {}
  }

  detach(): void {
    // no-op for extension transport
  }

  async focusTab(): Promise<boolean> {
    try {
      const res = await fetch(`http://127.0.0.1:${this._hubPort}/v1/web/tabs/focus`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this._token}`,
        },
        body: JSON.stringify({ tabId: Number(this.targetId) }),
      });
      if (!res.ok) return false;
      const data = await res.json();
      if (data && typeof data === "object" && "error" in data) return false;
      return true;
    } catch {
      return false;
    }
  }
}
