import { describe, it, expect } from "vitest";
import { computeAcceptKey, encodeTextFrame, FrameDecoder } from "../../src/web/wsserver.js";

function buildClientTextFrame(
  payload: string,
  opts?: { fin?: boolean; opcode?: number; maskKey?: number[] }
): Buffer {
  const fin = opts?.fin ?? true;
  const opcode = opts?.opcode ?? 1;
  const maskKey = opts?.maskKey ?? [0x12, 0x34, 0x56, 0x78];

  const pBuf = Buffer.from(payload, "utf8");
  const len = pBuf.length;
  let header: Buffer;

  const firstByte = (fin ? 0x80 : 0x00) | (opcode & 0x0f);

  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = firstByte;
    header[1] = 0x80 | len;
  } else if (len <= 65535) {
    header = Buffer.alloc(4);
    header[0] = firstByte;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = firstByte;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }

  const maskBuf = Buffer.from(maskKey);
  const maskedPayload = Buffer.alloc(len);
  for (let i = 0; i < len; i++) {
    maskedPayload[i] = pBuf[i]! ^ maskKey[i % 4]!;
  }

  return Buffer.concat([header, maskBuf, maskedPayload]);
}

function buildClientPingFrame(payload = "ping"): Buffer {
  const pBuf = Buffer.from(payload, "utf8");
  const maskKey = [0xaa, 0xbb, 0xcc, 0xdd];
  const header = Buffer.alloc(2);
  header[0] = 0x89; // FIN=1, Ping=9
  header[1] = 0x80 | pBuf.length;
  const maskBuf = Buffer.from(maskKey);
  const masked = Buffer.alloc(pBuf.length);
  for (let i = 0; i < pBuf.length; i++) {
    masked[i] = pBuf[i]! ^ maskKey[i % 4]!;
  }
  return Buffer.concat([header, maskBuf, masked]);
}

describe("src/web/wsserver.ts pure framing", () => {
  it("computeAcceptKey matches RFC 6455 test vector", () => {
    const key = "dGhlIHNhbXBsZSBub25jZQ==";
    const accept = computeAcceptKey(key);
    expect(accept).toBe("s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
  });

  it("encodeTextFrame produces valid unmasked server frames and decodes correctly if unmasked payload processed", () => {
    const text = "Hello from server";
    const serverFrame = encodeTextFrame(text);
    expect(serverFrame[0]).toBe(0x81); // FIN=1, text
    expect(serverFrame[1]).toBe(text.length); // unmasked (MASK bit is 0)
    expect(serverFrame.subarray(2).toString("utf8")).toBe(text);
  });

  it("FrameDecoder round-trips masked client frames of various sizes: short, 200B (126 form), 70000B (127 form)", () => {
    const decoder = new FrameDecoder();

    // 1. Short
    const shortText = "Hello client frame";
    const shortFrame = buildClientTextFrame(shortText);
    const events1 = decoder.push(shortFrame);
    expect(events1).toEqual([{ type: "message", data: shortText }]);

    // 2. 200 bytes (126 form)
    const mediumText = "A".repeat(200);
    const mediumFrame = buildClientTextFrame(mediumText);
    const events2 = decoder.push(mediumFrame);
    expect(events2).toEqual([{ type: "message", data: mediumText }]);

    // 3. 70,000 bytes (127 form)
    const largeText = "B".repeat(70000);
    const largeFrame = buildClientTextFrame(largeText);
    const events3 = decoder.push(largeFrame);
    expect(events3).toEqual([{ type: "message", data: largeText }]);
  });

  it("decodes a message split across three TCP chunks into exactly one message event", () => {
    const decoder = new FrameDecoder();
    const fullText = "Message split across TCP chunks";
    const frame = buildClientTextFrame(fullText);

    const chunk1 = frame.subarray(0, 5);
    const chunk2 = frame.subarray(5, 15);
    const chunk3 = frame.subarray(15);

    const events1 = decoder.push(chunk1);
    expect(events1).toEqual([]);

    const events2 = decoder.push(chunk2);
    expect(events2).toEqual([]);

    const events3 = decoder.push(chunk3);
    expect(events3).toEqual([{ type: "message", data: fullText }]);
  });

  it("decodes a fragmented message (FIN=0 text + FIN=1 continuation) into one message", () => {
    const decoder = new FrameDecoder();
    const frame1 = buildClientTextFrame("Part 1 ", { fin: false, opcode: 1 });
    const frame2 = buildClientTextFrame("Part 2", { fin: true, opcode: 0 });

    const events1 = decoder.push(frame1);
    expect(events1).toEqual([]);

    const events2 = decoder.push(frame2);
    expect(events2).toEqual([{ type: "message", data: "Part 1 Part 2" }]);
  });

  it("emits a ping event when a ping frame arrives in the middle of a fragmented message without corrupting the message", () => {
    const decoder = new FrameDecoder();
    const frame1 = buildClientTextFrame("Frag1-", { fin: false, opcode: 1 });
    const pingFrame = buildClientPingFrame("hello-ping");
    const frame2 = buildClientTextFrame("Frag2", { fin: true, opcode: 0 });

    const events1 = decoder.push(frame1);
    expect(events1).toEqual([]);

    const events2 = decoder.push(pingFrame);
    expect(events2.length).toBe(1);
    expect(events2[0].type).toBe("ping");
    expect((events2[0] as any).data.toString("utf8")).toBe("hello-ping");

    const events3 = decoder.push(frame2);
    expect(events3).toEqual([{ type: "message", data: "Frag1-Frag2" }]);
  });

  it("emits an error event when message size exceeds the 32 MB cap", () => {
    const decoder = new FrameDecoder();
    // Build a header claiming 35 MB payload
    const header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(35 * 1024 * 1024), 2);
    const maskKey = Buffer.from([1, 2, 3, 4]);

    const events = decoder.push(Buffer.concat([header, maskKey]));
    expect(events).toEqual([{ type: "error", message: "max message size exceeded" }]);
  });
});
