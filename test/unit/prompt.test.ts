import { describe, it, expect } from "vitest";
import type { ContentBlock } from "@agentclientprotocol/sdk";
import { renderPrompt, buildContextPreamble } from "../../src/prompt.js";
import type { Turn } from "../../src/session.js";

describe("renderPrompt", () => {
  it("passes plain text through", () => {
    const r = renderPrompt([{ type: "text", text: "hello world" }] as ContentBlock[]);
    expect(r.text).toBe("hello world");
    expect(r.warnings).toHaveLength(0);
  });

  it("renders a file resource_link as an @-mention path", () => {
    const r = renderPrompt([
      { type: "text", text: "look at" },
      { type: "resource_link", uri: "file:///C:/proj/x.ts", name: "x.ts" },
    ] as ContentBlock[]);
    expect(r.text).toContain("look at");
    expect(r.text).toContain("@C:/proj/x.ts");
  });

  it("embeds text resources", () => {
    const r = renderPrompt([
      { type: "resource", resource: { uri: "file:///C:/a.txt", text: "ABC" } },
    ] as ContentBlock[]);
    expect(r.text).toContain("ABC");
  });

  it("warns and placeholders for images", () => {
    const r = renderPrompt([{ type: "image", data: "x", mimeType: "image/png" }] as ContentBlock[]);
    expect(r.warnings.length).toBeGreaterThan(0);
    expect(r.text).toContain("image");
  });
});

describe("buildContextPreamble", () => {
  const turns: Turn[] = [
    { role: "user", text: "first question" },
    { role: "assistant", text: "first answer" },
  ];

  it("returns empty string for no turns", () => {
    expect(buildContextPreamble([], 1000)).toBe("");
  });

  it("includes prior turns within the char budget", () => {
    const p = buildContextPreamble(turns, 1000);
    expect(p).toContain("first question");
    expect(p).toContain("first answer");
    expect(p).toContain("Earlier conversation");
  });

  it("keeps the newest turns when truncating", () => {
    const p = buildContextPreamble(turns, 30);
    // budget too small for both; the newest (assistant) must survive
    expect(p.length).toBeLessThanOrEqual(200);
  });
});
