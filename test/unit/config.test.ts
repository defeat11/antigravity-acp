import { describe, it, expect } from "vitest";
import { loadConfig, findReservedExtraArgs } from "../../src/config.js";

describe("loadConfig", () => {
  it("applies safe defaults", () => {
    const c = loadConfig({});
    expect(c.model).toBe("gemini-3.6-flash-high");
    expect(c.permissionMode).toBe("auto");
    expect(c.persist).toBe("continue");
    expect(c.consent).toBe("off");
    expect(c.printTimeout).toBe("10m");
    expect(c.dryRun).toBe(false);
    expect(c.logLevel).toBe("info");
    expect(c.maxContextChars).toBe(24000);
  });

  it("coerces invalid enum values to defaults", () => {
    expect(loadConfig({ ACP_AGY_PERMISSION_MODE: "nope" }).permissionMode).toBe("auto");
    expect(loadConfig({ ACP_AGY_PERSIST: "weird" }).persist).toBe("continue");
    expect(loadConfig({ ACP_LOG_LEVEL: "loud" }).logLevel).toBe("info");
  });

  it("parses booleans and integers", () => {
    expect(loadConfig({ ACP_AGY_DRY_RUN: "1" }).dryRun).toBe(true);
    expect(loadConfig({ ACP_AGY_DRY_RUN: "true" }).dryRun).toBe(true);
    expect(loadConfig({ ACP_AGY_DRY_RUN: "no" }).dryRun).toBe(false);
    expect(loadConfig({ ACP_MAX_CONTEXT_CHARS: "5000" }).maxContextChars).toBe(5000);
    expect(loadConfig({ ACP_MAX_CONTEXT_CHARS: "abc" }).maxContextChars).toBe(24000);
    expect(loadConfig({ ACP_MAX_CONTEXT_CHARS: "10" }).maxContextChars).toBe(24000); // below min
  });

  it("treats unset model as default but explicit empty as skip", () => {
    expect(loadConfig({}).model).toBe("gemini-3.6-flash-high");
    expect(loadConfig({ ACP_AGY_MODEL: "" }).model).toBe("");
    expect(loadConfig({ ACP_AGY_MODEL: "  gemini-3.6-flash-low  " }).model).toBe("gemini-3.6-flash-low");
  });

  it("tokenizes extra args honoring quotes", () => {
    expect([...loadConfig({ ACP_AGY_EXTRA_ARGS: '--a "b c" --d' }).extraArgs]).toEqual([
      "--a",
      "b c",
      "--d",
    ]);
    expect([...loadConfig({}).extraArgs]).toEqual([]);
  });
});

describe("findReservedExtraArgs", () => {
  it("detects adapter-managed flags", () => {
    expect(findReservedExtraArgs(["--model", "x", "--verbose"])).toEqual(["--model"]);
    expect(findReservedExtraArgs(["--print=hi", "-p"])).toEqual(expect.arrayContaining(["--print", "-p"]));
  });
  it("returns empty when none conflict", () => {
    expect(findReservedExtraArgs(["--verbose", "--add-dir", "/x"])).toEqual([]);
  });
});
