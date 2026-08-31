import { describe, it, expect } from "vitest";
import { detectSiteError, isRetryableSiteError, parseWaitHint } from "../../src/web/site-errors.js";

describe("a stated limit is believed, not retried", () => {
  it("classifies the real daily-limit notice", () => {
    // Captured live: this is the exact wording the site shows.
    const notice = "You have reached the daily usage limit. Please wait 8 hours before trying again.";
    const match = detectSiteError(notice);
    expect(match?.kind).toBe("rate_limit");
    expect(isRetryableSiteError(match!.kind)).toBe(false);
  });

  it("still retries the failures that are worth retrying", () => {
    expect(isRetryableSiteError("generic")).toBe(true);
    expect(isRetryableSiteError("network")).toBe(true);
    expect(isRetryableSiteError("unavailable")).toBe(true);
  });

  it("reads the wait out of the notice so 'later' has a number", () => {
    expect(parseWaitHint("Please wait 8 hours before trying again.")).toBe(480);
    expect(parseWaitHint("try again in 30 minutes")).toBe(30);
    expect(parseWaitHint("انتظر 3 ساعات")).toBe(180);
    expect(parseWaitHint("عاود بعد 45 دقيقة")).toBe(45);
  });

  it("returns nothing rather than guessing when no time is stated", () => {
    expect(parseWaitHint("You have reached the limit.")).toBeNull();
    expect(parseWaitHint("")).toBeNull();
  });
});
