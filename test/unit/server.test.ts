import { describe, it, expect, vi } from "vitest";

vi.mock("../../src/delegate.js", () => {
  return {
    runDelegate: vi.fn(),
  };
});

import { getOrCreateToken, isProjectAllowed, startApiServer } from "../../src/server.js";

describe("API Server Unit Tests", () => {
  it("getOrCreateToken is idempotent and returns a 64-character hex string", () => {
    const token1 = getOrCreateToken();
    const token2 = getOrCreateToken();
    expect(token1).toBe(token2);
    expect(token1).toMatch(/^[0-9a-f]{64}$/);
  });

  it("isProjectAllowed returns false for a nonexistent random project path", () => {
    const allowed = isProjectAllowed("/some/definitely/nonexistent/path/xyz123");
    expect(allowed).toBe(false);
  });

  it("starts the API server on port 0 and serves health check without auth, then closes", async () => {
    // Port 0 selects an ephemeral port dynamically
    const server = await startApiServer({ port: 0 });
    try {
      expect(server.url).toContain("http://127.0.0.1:");
      
      const res = await fetch(`${server.url}/v1/health`);
      expect(res.status).toBe(200);
      
      const json = (await res.json()) as { ok: boolean; time: string };
      expect(json.ok).toBe(true);
      expect(json.time).toBeDefined();
    } finally {
      await server.close();
    }
  });

  it("returns 401 unauthorized on capacity or delegate routes without auth", async () => {
    const server = await startApiServer({ port: 0 });
    try {
      const res = await fetch(`${server.url}/v1/capacity`);
      expect(res.status).toBe(401);
      const json = (await res.json()) as { error: string };
      expect(json.error).toContain("unauthorized");
    } finally {
      await server.close();
    }
  });
});
