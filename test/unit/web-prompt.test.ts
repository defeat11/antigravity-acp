import { describe, it, expect } from "vitest";
import { webToolsBlock } from "../../src/delegate.js";

describe("webToolsBlock prompt generator", () => {
  it("returns an empty string when web control is disabled (false)", () => {
    expect(webToolsBlock(false)).toBe("");
  });

  it("returns the Arabic prompt block with required commands and safety rules when enabled (true)", () => {
    const block = webToolsBlock(true);
    expect(block).toContain("acp web call navigate");
    expect(block).toContain("acp web call evaluate --code \"<js>\" --session <name> --write");
    expect(block).toContain("--session");
    expect(block).toContain("--write");
    expect(block).toContain("needs_user");
    expect(block).toContain("captcha");
  });

  it("does not offer curl or wget as allowed commands", () => {
    const block = webToolsBlock(true);
    // Verified: curl and wget are mentioned only to state they remain forbidden
    expect(block).not.toContain("acp web call curl");
    expect(block).not.toContain("acp web call wget");
  });
});
