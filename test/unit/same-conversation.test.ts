import { describe, it, expect } from "vitest";
import { sameConversation, retryNeedsReload } from "../../src/web/state.js";

describe("sameConversation: does a reused tab need navigating?", () => {
  it("is true for the same conversation regardless of query state", () => {
    // The app appends its own parameters after load. Treating those as a
    // difference would reload the page on every run — the exact cost this check
    // exists to avoid.
    expect(
      sameConversation("https://chat.qwen.ai/c/abc-123?fev=0.0.1", "https://chat.qwen.ai/c/abc-123"),
    ).toBe(true);
    expect(
      sameConversation("https://chat.qwen.ai/c/abc-123/", "https://chat.qwen.ai/c/abc-123"),
    ).toBe(true);
  });

  it("is false for a different conversation", () => {
    expect(
      sameConversation("https://chat.qwen.ai/c/abc-123", "https://chat.qwen.ai/c/zzz-999"),
    ).toBe(false);
  });

  it("is false between a conversation and the root", () => {
    // Reusing a tab that sits on an old conversation for a NEW question must
    // navigate; skipping that would post the question into someone else's thread.
    expect(sameConversation("https://chat.qwen.ai/c/abc-123", "https://chat.qwen.ai/")).toBe(false);
  });

  it("never guesses on empty or malformed input", () => {
    expect(sameConversation("", "https://chat.qwen.ai/")).toBe(false);
    expect(sameConversation("not a url", "also not")).toBe(false);
    expect(sameConversation("not a url", "not a url")).toBe(true);
  });
});

describe("retryNeedsReload: a retry must not refresh needlessly", () => {
  it("stays put when the tab is already on this conversation", () => {
    expect(
      retryNeedsReload("https://chat.qwen.ai/c/abc?fev=1", "https://chat.qwen.ai/c/abc"),
    ).toBe(false);
  });

  it("stays in the conversation the first message just created", () => {
    // startUrl is the root because the session had no conversation yet; sending
    // moved the tab to /c/<id>. Reloading to the root would abandon that thread
    // and open a second one under the same key — the exact shape the isolation
    // audit flags.
    expect(retryNeedsReload("https://chat.qwen.ai/c/new-id", "https://chat.qwen.ai/")).toBe(false);
  });

  it("reloads when the tab drifted to a different conversation", () => {
    expect(
      retryNeedsReload("https://chat.qwen.ai/c/other", "https://chat.qwen.ai/c/mine"),
    ).toBe(true);
  });

  it("reloads when the page cannot be read at all", () => {
    // A tab that will not answer a location read is not a tab we can retry into.
    expect(retryNeedsReload("", "https://chat.qwen.ai/c/mine")).toBe(true);
  });

  it("reloads when the tab left the site entirely", () => {
    expect(retryNeedsReload("https://example.com/c/abc", "https://chat.qwen.ai/")).toBe(true);
  });
});
