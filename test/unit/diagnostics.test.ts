import { describe, it, expect } from "vitest";
import { classifyFailure, buildErrorDetail } from "../../src/diagnostics.js";

describe("classifyFailure", () => {
  it("classifies error messages correctly", () => {
    // 1. auth_required
    expect(classifyFailure("user is not logged in")).toBe("auth_required");
    expect(classifyFailure(new Error("Authentication failed"))).toBe("auth_required");

    // 2. timeout
    expect(classifyFailure("operation ETIMEDOUT")).toBe("timeout");
    expect(classifyFailure(new Error("connection timed out"))).toBe("timeout");
    expect(classifyFailure("read timeout occurred")).toBe("timeout");

    // 3. network
    expect(classifyFailure("connection closed ECONNRESET")).toBe("network");
    expect(classifyFailure("ECONNREFUSED on port 80")).toBe("network");
    expect(classifyFailure(new Error("dns lookup ENOTFOUND example.com"))).toBe("network");
    expect(classifyFailure("write EPIPE")).toBe("network");
    expect(classifyFailure("fetch failed to load url")).toBe("network");
    expect(classifyFailure("a network failure occurred")).toBe("network");

    // 4. agy_crashed
    expect(classifyFailure("process exited with exit code 127")).toBe("agy_crashed");
    expect(classifyFailure(new Error("spawn node ENOENT"))).toBe("agy_crashed");
    expect(classifyFailure("socket closed unexpectedly")).toBe("agy_crashed");
    expect(classifyFailure("process exited early")).toBe("agy_crashed");
    expect(classifyFailure("unexpected end of stream")).toBe("agy_crashed");
    expect(classifyFailure("stream closed by peer")).toBe("agy_crashed");

    // 5. protocol
    expect(classifyFailure("protocol violation")).toBe("protocol");
    expect(classifyFailure(new Error("received invalid response format"))).toBe("protocol");
    expect(classifyFailure("unexpected message type")).toBe("protocol");

    // 6. failed (default)
    expect(classifyFailure("something completely different")).toBe("failed");
  });
});

describe("buildErrorDetail", () => {
  it("builds error details with stack limited to 3 lines", () => {
    const error = new Error("something went wrong");
    error.stack = "Error: something went wrong\n    at foo (foo.ts:10:5)\n    at bar (bar.ts:20:5)\n    at baz (baz.ts:30:5)\n    at extra (extra.ts:40:5)";
    
    const detail = buildErrorDetail(error);
    expect(detail.message).toBe("something went wrong");
    expect(detail.stack).toEqual([
      "Error: something went wrong",
      "at foo (foo.ts:10:5)",
      "at bar (bar.ts:20:5)"
    ]);
  });

  it("handles errors with no stack trace", () => {
    const detail = buildErrorDetail("plain string error");
    expect(detail.message).toBe("plain string error");
    expect(detail.stack).toEqual([]);
  });
});
