import { describe, it, expect } from "vitest";
import { resolveExecutable } from "../../src/bin-resolver.js";

describe("resolveExecutable", () => {
  it("resolves a binary that is on PATH (node)", () => {
    const p = resolveExecutable("node");
    expect(p).toBeTruthy();
    expect(p!.toLowerCase()).toContain("node");
  });

  it("returns null for a non-existent binary", () => {
    expect(resolveExecutable("definitely-not-a-real-binary-xyz-12345")).toBeNull();
  });

  it("returns null for an explicit path that does not exist", () => {
    expect(resolveExecutable("/no/such/dir/agy")).toBeNull();
  });
});
