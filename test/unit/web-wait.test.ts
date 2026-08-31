import { describe, it, expect } from "vitest";
import { validateWaitArgs } from "../../src/web/actions.js";
import { classifyAction } from "../../src/web/guard.js";

describe("web/actions.ts - validateWaitArgs", () => {
  it("returns error when zero conditions are provided", () => {
    const res = validateWaitArgs({});
    expect(res).not.toBeNull();
    expect(res?.ok).toBe(false);
    expect(res?.error).toBe("waitFor needs exactly one of --until/--selector/--text/--gone/--stable");
  });

  it("returns error when multiple conditions are provided", () => {
    const res = validateWaitArgs({
      untilJs: "window.ready === true",
      selector: ".submit-btn",
    });
    expect(res).not.toBeNull();
    expect(res?.ok).toBe(false);
    expect(res?.error).toBe("waitFor needs exactly one of --until/--selector/--text/--gone/--stable");
  });

  it("returns null when exactly one condition is provided", () => {
    expect(validateWaitArgs({ untilJs: "true" })).toBeNull();
    expect(validateWaitArgs({ selector: "#btn" })).toBeNull();
    expect(validateWaitArgs({ text: "Success" })).toBeNull();
    expect(validateWaitArgs({ gone: ".loading" })).toBeNull();
  });
});

describe("web/guard.ts - wait action classification", () => {
  it("allows wait action in read-only session on allowed domain", () => {
    const res = classifyAction({
      action: "wait",
      url: "https://allowed.com/page",
      readOnly: true,
      allowlist: ["allowed.com"],
    });

    expect(res.decision).toBe("allow");
    expect(res.reason).toBe("ok");
  });

  it("denies wait action on non-allowlisted domain", () => {
    const res = classifyAction({
      action: "wait",
      url: "https://forbidden.com/page",
      readOnly: true,
      allowlist: ["allowed.com"],
    });

    expect(res.decision).toBe("deny");
    expect(res.reason).toContain("domain not allowed");
  });
});

describe("wait --stable: the trained completion rule, available to anyone", () => {
  it("accepts a stable/busy pair", () => {
    expect(
      validateWaitArgs({ stable: "[class*=markdown]", busy: "[aria-label='Stop']" }),
    ).toBeNull();
  });

  it("refuses --stable without --busy, and says how to opt out", () => {
    // Stability alone cannot tell a paused stream from a finished one — they
    // look identical. Requiring the second signal does not remove the option to
    // go without it; it makes going without it visible in the command.
    const res = validateWaitArgs({ stable: "[class*=markdown]" });
    expect(res?.ok).toBe(false);
    expect(res?.error).toContain("--busy");
    expect(res?.error).toContain("none");
  });

  it("allows an explicit declaration that the site has no busy indicator", () => {
    expect(validateWaitArgs({ stable: ".content", busy: "none" })).toBeNull();
  });

  it("refuses --busy on its own", () => {
    expect(validateWaitArgs({ busy: ".spinner" })?.ok).toBe(false);
  });

  it("still refuses combining --stable with another condition", () => {
    expect(validateWaitArgs({ stable: ".a", busy: "none", untilJs: "true" })?.ok).toBe(false);
  });
});
