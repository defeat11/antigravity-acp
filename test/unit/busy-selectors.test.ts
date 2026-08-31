import { describe, it, expect } from "vitest";
import {
  busyRecipeFor,
  suggestWaitCommand,
  blindWaitAdvice,
  knownBusyHosts,
  normalizeHostKey,
} from "../../src/web/busy-selectors.js";

describe("busy-selectors: making the honest path the easy one", () => {
  it("knows the pair measured on the live Qwen page", () => {
    const r = busyRecipeFor("chat.qwen.ai");
    expect(r?.busy).toBe("[aria-label='Stop']");
    expect(r?.stable).toBe("[class*=markdown]");
  });

  it("does not care about www or casing", () => {
    expect(normalizeHostKey("WWW.Chat.Qwen.AI")).toBe("chat.qwen.ai");
    expect(busyRecipeFor("www.chat.qwen.ai")).not.toBeNull();
  });

  it("says nothing about a site it has not measured", () => {
    // A guessed recipe is worse than none: it would be trusted.
    expect(busyRecipeFor("example.com")).toBeNull();
    expect(suggestWaitCommand("example.com", "s")).toBeNull();
  });

  it("prints a command that can be copied, not advice to be interpreted", () => {
    const cmd = suggestWaitCommand("chat.qwen.ai", "review");
    expect(cmd).toContain("--stable");
    expect(cmd).toContain("--busy");
    expect(cmd).toContain("--session review");
  });

  it("omits the session flag when it is the default", () => {
    expect(suggestWaitCommand("chat.qwen.ai", "default")).not.toContain("--session");
  });

  it("names the anti-pattern and offers the alternative in the same breath", () => {
    const advice = blindWaitAdvice("chat.qwen.ai", "review");
    expect(advice).toContain("لم يصدُق شرطه");
    expect(advice).toContain("--stable");
  });

  it("still helps on an unknown host, without inventing selectors", () => {
    const advice = blindWaitAdvice("example.com", "s");
    expect(advice).toContain("--stable <css>");
    expect(advice).not.toContain("markdown");
  });

  it("can list what it knows, so the surface is discoverable", () => {
    expect(knownBusyHosts()).toContain("chat.qwen.ai");
  });
});
