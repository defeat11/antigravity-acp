import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";

export function isWebSocketUpgrade(req: IncomingMessage): boolean {
  const upgrade = req.headers["upgrade"];
  const connection = req.headers["connection"];
  const isUpgrade = typeof upgrade === "string" && upgrade.toLowerCase() === "websocket";
  const isConnUpgrade =
    typeof connection === "string" &&
    connection.toLowerCase().split(",").map((s) => s.trim()).includes("upgrade");
  return isUpgrade && isConnUpgrade;
}

export function computeAcceptKey(secWebSocketKey: string): string {
  const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
  return createHash("sha1").update(secWebSocketKey + GUID).digest("base64");
}

export function encodeTextFrame(payload: string): Buffer {
  const payloadBuf = Buffer.from(payload, "utf8");
  const len = payloadBuf.length;
  let header: Buffer;

  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x81; // FIN=1, opcode=1 (text)
    header[1] = len;
  } else if (len <= 65535) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }

  return Buffer.concat([header, payloadBuf]);
}

export function encodeCloseFrame(code?: number, reason?: string): Buffer {
  if (code === undefined) {
    const buf = Buffer.alloc(2);
    buf[0] = 0x88; // FIN=1, opcode=8 (close)
    buf[1] = 0;
    return buf;
  }

  const reasonBuf = reason ? Buffer.from(reason, "utf8") : Buffer.alloc(0);
  const len = 2 + reasonBuf.length;

  let header: Buffer;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x88;
    header[1] = len;
  } else {
    header = Buffer.alloc(4);
    header[0] = 0x88;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  }

  const payload = Buffer.alloc(2 + reasonBuf.length);
  payload.writeUInt16BE(code, 0);
  if (reasonBuf.length > 0) {
    reasonBuf.copy(payload, 2);
  }

  return Buffer.concat([header, payload]);
}

export function encodeControlFrame(opcode: 0x9 | 0xA, payload?: Buffer): Buffer {
  const pBuf = payload ?? Buffer.alloc(0);
  const len = Math.min(pBuf.length, 125);
  const header = Buffer.alloc(2);
  header[0] = 0x80 | (opcode & 0x0f);
  header[1] = len;
  return Buffer.concat([header, pBuf.subarray(0, len)]);
}

export type WsDecoderEvent =
  | { type: "message"; data: string }
  | { type: "ping"; data: Buffer }
  | { type: "pong" }
  | { type: "close"; code?: number; reason?: string }
  | { type: "error"; message: string };

const MAX_MESSAGE_SIZE = 32 * 1024 * 1024; // 32 MB

export class FrameDecoder {
  private _buffer = Buffer.alloc(0);
  private _fragOpcode: number | null = null;
  private _fragBuffers: Buffer[] = [];
  private _fragTotalLen = 0;

  push(chunk: Buffer): WsDecoderEvent[] {
    this._buffer = Buffer.concat([this._buffer, chunk]);
    const events: WsDecoderEvent[] = [];

    while (this._buffer.length >= 2) {
      const b0 = this._buffer[0]!;
      const b1 = this._buffer[1]!;

      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let payloadLen = b1 & 0x7f;

      let headerLen = 2;
      if (payloadLen === 126) {
        if (this._buffer.length < 4) break;
        payloadLen = this._buffer.readUInt16BE(2);
        headerLen = 4;
      } else if (payloadLen === 127) {
        if (this._buffer.length < 10) break;
        const bigLen = this._buffer.readBigUInt64BE(2);
        if (bigLen > BigInt(MAX_MESSAGE_SIZE)) {
          events.push({ type: "error", message: "max message size exceeded" });
          this._buffer = Buffer.alloc(0);
          this._resetFrag();
          return events;
        }
        payloadLen = Number(bigLen);
        headerLen = 10;
      }

      const maskLen = masked ? 4 : 0;
      const totalHeaderLen = headerLen + maskLen;
      const totalFrameLen = totalHeaderLen + payloadLen;

      if (this._buffer.length < totalFrameLen) {
        break; // Wait for complete frame
      }

      // Check per-frame or accumulated message size
      if (payloadLen > MAX_MESSAGE_SIZE || this._fragTotalLen + payloadLen > MAX_MESSAGE_SIZE) {
        events.push({ type: "error", message: "max message size exceeded" });
        this._buffer = Buffer.alloc(0);
        this._resetFrag();
        return events;
      }

      let maskKey: Buffer | null = null;
      if (masked) {
        maskKey = this._buffer.subarray(headerLen, headerLen + 4);
      }

      const rawPayload = this._buffer.subarray(totalHeaderLen, totalFrameLen);
      const unmasked = Buffer.alloc(payloadLen);
      if (masked && maskKey) {
        for (let i = 0; i < payloadLen; i++) {
          unmasked[i] = rawPayload[i]! ^ maskKey[i % 4]!;
        }
      } else {
        rawPayload.copy(unmasked);
      }

      // Advance buffer for parsed frame
      this._buffer = this._buffer.subarray(totalFrameLen);

      // Handle Control Frames (0x8 close, 0x9 ping, 0xA pong) - interleaved
      if (opcode === 0x8) {
        let code: number | undefined;
        let reason: string | undefined;
        if (unmasked.length >= 2) {
          code = unmasked.readUInt16BE(0);
          reason = unmasked.subarray(2).toString("utf8");
        }
        events.push({ type: "close", code, reason });
      } else if (opcode === 0x9) {
        events.push({ type: "ping", data: unmasked });
      } else if (opcode === 0xA) {
        events.push({ type: "pong" });
      } else if (opcode === 0x1 || opcode === 0x2) {
        // Start text (0x1) or binary (0x2) message
        this._fragOpcode = opcode;
        this._fragBuffers = [unmasked];
        this._fragTotalLen = unmasked.length;

        if (fin) {
          const data = unmasked.toString("utf8");
          events.push({ type: "message", data });
          this._resetFrag();
        }
      } else if (opcode === 0x0) {
        // Continuation frame
        if (this._fragOpcode === null) {
          events.push({ type: "error", message: "unexpected continuation frame" });
          this._resetFrag();
          continue;
        }

        this._fragBuffers.push(unmasked);
        this._fragTotalLen += unmasked.length;

        if (fin) {
          const fullBuf = Buffer.concat(this._fragBuffers);
          const data = fullBuf.toString("utf8");
          events.push({ type: "message", data });
          this._resetFrag();
        }
      } else {
        events.push({ type: "error", message: `unsupported opcode: ${opcode}` });
      }
    }

    return events;
  }

  private _resetFrag(): void {
    this._fragOpcode = null;
    this._fragBuffers = [];
    this._fragTotalLen = 0;
  }
}

export class WsConnection {
  private _closed = false;
  private _listeners = new Map<string, Set<Function>>();

  constructor(private _socket: Socket) {
    const decoder = new FrameDecoder();

    _socket.on("data", (chunk: Buffer) => {
      const events = decoder.push(chunk);
      for (const ev of events) {
        if (ev.type === "message") {
          this._emit("message", ev.data);
        } else if (ev.type === "ping") {
          try {
            _socket.write(encodeControlFrame(0xA, ev.data));
          } catch {}
          this._emit("ping", ev.data);
        } else if (ev.type === "pong") {
          this._emit("pong");
        } else if (ev.type === "close") {
          this.close(ev.code, ev.reason);
        } else if (ev.type === "error") {
          this._emit("error", new Error(ev.message));
          this.close(1009, ev.message);
        }
      }
    });

    _socket.on("close", () => {
      this._handleClose();
    });

    _socket.on("error", (err: Error) => {
      this._emit("error", err);
      this._handleClose();
    });
  }

  get closed(): boolean {
    return this._closed;
  }

  send(text: string): void {
    if (this._closed) return;
    try {
      this._socket.write(encodeTextFrame(text));
    } catch (err) {
      this._emit("error", err);
    }
  }

  ping(): void {
    if (this._closed) return;
    try {
      this._socket.write(encodeControlFrame(0x9));
    } catch (err) {
      this._emit("error", err);
    }
  }

  close(code?: number, reason?: string): void {
    if (this._closed) return;
    this._closed = true;
    try {
      this._socket.write(encodeCloseFrame(code, reason));
    } catch {}
    try {
      this._socket.end();
    } catch {}
    this._handleClose();
  }

  on(event: "message" | "close" | "error" | "ping" | "pong", handler: Function): () => void {
    if (!this._listeners.has(event)) {
      this._listeners.set(event, new Set());
    }
    const set = this._listeners.get(event)!;
    set.add(handler);
    return () => {
      set.delete(handler);
    };
  }

  private _emit(event: string, ...args: any[]): void {
    const set = this._listeners.get(event);
    if (set) {
      for (const fn of Array.from(set)) {
        try {
          fn(...args);
        } catch {}
      }
    }
  }

  private _handleClose(): void {
    if (this._closed) return;
    this._closed = true;
    this._emit("close");
  }
}

export function attachWebSocketServer(
  server: import("node:http").Server,
  o: {
    path: string;
    verifyOrigin?: (origin: string | undefined) => boolean;
    onConnection: (ws: WsConnection, req: IncomingMessage) => void;
  }
): void {
  server.on("upgrade", (req: IncomingMessage, socket: Socket) => {
    try {
      const reqUrl = new URL(req.url || "/", "http://127.0.0.1");
      if (reqUrl.pathname !== o.path) {
        return;
      }

      if (!isWebSocketUpgrade(req)) {
        socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }

      const key = req.headers["sec-websocket-key"];
      const version = req.headers["sec-websocket-version"];
      if (typeof key !== "string" || !key || version !== "13") {
        socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }

      const origin = req.headers["origin"] as string | undefined;
      if (o.verifyOrigin && !o.verifyOrigin(origin)) {
        socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }

      const acceptKey = computeAcceptKey(key);
      const responseHeaders = [
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Accept: ${acceptKey}`,
        "\r\n",
      ].join("\r\n");

      socket.write(responseHeaders);
      const ws = new WsConnection(socket);
      o.onConnection(ws, req);
    } catch {
      socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      socket.destroy();
    }
  });
}
