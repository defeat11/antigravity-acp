import { describe, it, expect } from "vitest";
import { extractLikelyNames, redactPII } from "../../src/web/redact.js";

describe("redact: the CV owner's own name", () => {
  it("finds the name without the caller having to know it", () => {
    // The review called relying on the caller a certain leak, not a hypothetical.
    expect(extractLikelyNames("سامي المطيري\nمهندس برمجيات")).toContain("سامي المطيري");
    expect(extractLikelyNames("# Ahmed Al-Otaibi\n**Backend Engineer**")).toContain("Ahmed Al-Otaibi");
    expect(extractLikelyNames("الاسم: فيصل بن سعد")).toContain("فيصل بن سعد");
    expect(extractLikelyNames("Name: Sara Hassan")).toContain("Sara Hassan");
  });

  it("derives a name from a personal e-mail local part", () => {
    const names = extractLikelyNames("reach me at sami.al-otaibi@example.com");
    expect(names.some((n) => n.includes("sami"))).toBe(true);
  });

  it("does not mistake section headings or job titles for people", () => {
    // Redacting "Professional Summary" would mangle the document structure.
    expect(extractLikelyNames("# Professional Summary\ntext")).toEqual([]);
    expect(extractLikelyNames("Work Experience\ntext")).toEqual([]);
    expect(extractLikelyNames("الملخص المهني\nنص")).toEqual([]);
    expect(extractLikelyNames("Senior Backend Engineer")).toEqual([]);
  });

  it("ignores role mailboxes — they name a function, not a person", () => {
    expect(extractLikelyNames("info@company.com")).toEqual([]);
    expect(extractLikelyNames("careers@company.com")).toEqual([]);
  });

  it("redacts the discovered name automatically, with no caller input", () => {
    const r = redactPII("سامي المطيري\nمهندس برمجيات\nsami.almutairi@example.com", []);
    expect(r.text).not.toContain("سامي المطيري");
    expect(r.text).toContain("[NAME_1]");
    expect(r.text).toContain("مهندس برمجيات"); // the profession survives
  });
});

describe("redact: a name with a parenthetical alias", () => {
  it("catches an all-caps heading name that carries an alias", () => {
    // Found in production: the phone, e-mail, LinkedIn and GitHub on the lines
    // below were all redacted, and the NAME went out intact — because the line
    // was judged before it was cleaned, and "(NOURA)" starts with a bracket.
    const names = extractLikelyNames("# LAYLA ABDULLATIF (NOURA)\n**Power Platform Developer**");
    expect(names).toContain("LAYLA ABDULLATIF");
    // The alias is what people actually call him, so it is redacted as well.
    expect(names).toContain("NOURA");
  });

  it("removes both from the text that leaves the machine", () => {
    const cv = [
      "# LAYLA ABDULLATIF (NOURA)",
      "**Power Platform Developer | Solutions Architect**",
      "Riyadh | +966 500000000 | someone@example.com",
      "NOURA led the integration workstream.",
    ].join("\n");
    const out = redactPII(cv);
    expect(out.text).not.toContain("LAYLA");
    expect(out.text).not.toContain("ABDULLATIF");
    expect(out.text).not.toContain("NOURA");
    // The professional content survives — over-redaction destroys the evaluation.
    expect(out.text).toContain("Power Platform Developer");
    expect(out.text).toContain("integration workstream");
  });

  it("still ignores a heading that is a section, not a person", () => {
    expect(extractLikelyNames("# Professional Summary (Updated)")).not.toContain(
      "Professional Summary",
    );
  });
});
