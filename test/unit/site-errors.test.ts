import { describe, it, expect } from "vitest";
import { detectSiteError } from "../../src/web/site-errors.js";

describe("detectSiteError unit tests", () => {
  it("detects English site error markers correctly", () => {
    const res1 = detectSiteError("503 Service Unavailable");
    expect(res1).toEqual({ kind: "unavailable", marker: "Service Unavailable" });

    const res2 = detectSiteError("Error: Something went wrong while connecting.");
    expect(res2).toEqual({ kind: "generic", marker: "Something went wrong" });

    const res3 = detectSiteError("429 Too Many Requests. Please wait.");
    expect(res3).toEqual({ kind: "rate_limit", marker: "Too Many Requests" });

    const res4 = detectSiteError("Fetch failed: Network Error");
    expect(res4).toEqual({ kind: "network", marker: "Network Error" });
  });

  it("detects Arabic site error markers correctly", () => {
    const res1 = detectSiteError("عذراً، الخدمة غير متوفرة حالياً");
    expect(res1).toEqual({ kind: "unavailable", marker: "الخدمة غير متوفرة" });

    const res2 = detectSiteError("تنبيه: حدث خطأ أثناء الاتصال بالخادم");
    expect(res2).toEqual({ kind: "generic", marker: "حدث خطأ" });

    const res3 = detectSiteError("لقد تجاوزت الحد الأقصى من الطلبات");
    expect(res3).toEqual({ kind: "rate_limit", marker: "الحد الأقصى" });

    const res4 = detectSiteError("تعذر الاتصال بالشبكة، حاول مرة أخرى");
    expect(res4).toEqual({ kind: "generic", marker: "حاول مرة أخرى" });
  });

  it("returns null for ordinary normal page content", () => {
    const cleanText = "Here is the response from Qwen about quantum computing. Quantum mechanics is a fundamental theory in physics.";
    expect(detectSiteError(cleanText)).toBeNull();
  });
});
