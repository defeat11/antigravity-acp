import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readSessions,
  writeSessions,
  getSession,
  putSession,
  dropSession,
  readDomains,
  addDomain,
  removeDomain,
  getSessionsPath,
  isResumableUrl,
} from "../../src/web/state.js";
import { classifyAction, isDomainAllowed, mapActionName } from "../../src/web/guard.js";
import { isEditableElement, resolveVirtualKeyCode } from "../../src/web/actions.js";
import { resolveVia } from "../../src/web-cli.js";

describe("web/state.ts", () => {
  let tmpHome: string;
  let origHome: string | undefined;
  let origUserProfile: string | undefined;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "acp-web-state-test-"));
    origHome = process.env.HOME;
    origUserProfile = process.env.USERPROFILE;
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;
  });

  afterEach(() => {
    process.env.HOME = origHome;
    process.env.USERPROFILE = origUserProfile;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("readSessions returns {} when missing, and round-trips putSession/getSession/dropSession", () => {
    expect(readSessions()).toEqual({});
    expect(getSession("default")).toBeNull();

    putSession("default", {
      targetId: "target-123",
      readOnly: true,
      createdAt: "2026-08-05T00:00:00Z",
    });

    const retrieved = getSession("default");
    expect(retrieved).not.toBeNull();
    expect(retrieved?.targetId).toBe("target-123");
    expect(retrieved?.readOnly).toBe(true);

    expect(readSessions()["default"]).toBeDefined();

    dropSession("default");
    expect(getSession("default")).toBeNull();
    expect(readSessions()).toEqual({});
  });

  it("readSessions returns {} for corrupt JSON without throwing", () => {
    const sPath = getSessionsPath();
    writeSessions({ foo: { targetId: "x", readOnly: true, createdAt: "now" } });
    writeFileSync(sPath, "{ corrupt json ...", "utf8");

    expect(readSessions()).toEqual({});
  });

  it("addDomain normalizes URL inputs, avoids duplicates, and removeDomain deletes", () => {
    expect(readDomains()).toEqual([]);

    const list1 = addDomain("https://WWW.Example.com/path");
    expect(list1).toEqual(["example.com"]);

    const list2 = addDomain("https://www.example.com");
    expect(list2).toEqual(["example.com"]);

    const list3 = removeDomain("example.com");
    expect(list3).toEqual([]);
  });

  it("profileDir('default') falls back to legacy path when it exists, and to profilesRoot()/default otherwise", async () => {
    const { profileDir, profilesRoot } = await import("../../src/web/chrome.js");
    const { mkdirSync, writeFileSync } = await import("node:fs");

    // Case 1: no legacy dir exists
    const dirNoLegacy = profileDir("default");
    expect(dirNoLegacy).toBe(join(profilesRoot(), "default"));

    // Case 2: legacy dir exists
    const legacyPath = join(tmpHome, ".acp", "browser-profile");
    mkdirSync(legacyPath, { recursive: true });
    writeFileSync(join(legacyPath, "test.txt"), "hello");

    const dirWithLegacy = profileDir("default");
    expect(dirWithLegacy).toBe(legacyPath);
  });

  it("port allocation gives 9333 to default and distinct free ports (skipping reserved 9334) to other profiles", async () => {
    const { touchProfileRecord, getProfileRecord } = await import("../../src/web/state.js");

    const pDefault = touchProfileRecord("default");
    expect(pDefault.port).toBe(9333);

    const pWork = touchProfileRecord("work");
    expect(pWork.port).toBe(9335);

    const pPersonal = touchProfileRecord("personal");
    expect(pPersonal.port).toBe(9336);

    expect(getProfileRecord("work")?.port).toBe(9335);
  });

  it("touchProfileRecord repairs a stored profile holding a reserved port", async () => {
    const { touchProfileRecord, writeProfiles, readProfiles } = await import("../../src/web/state.js");

    // Seed a profile with reserved port 9334
    writeProfiles({
      badprofile: { port: 9334, createdAt: "2026-08-05T00:00:00Z" },
    });

    const rec = touchProfileRecord("badprofile");
    expect(rec.port).not.toBe(9334);
    expect(rec.port).toBe(9335);
    expect(rec.reallocatedFrom).toBe(9334);

    const updated = readProfiles();
    expect(updated.badprofile.port).toBe(9335);
  });

  it("session record round-trips profile field and old record without it defaults to default", () => {
    putSession("named-session", {
      targetId: "t1",
      readOnly: false,
      createdAt: "2026-08-05T00:00:00Z",
      profile: "work",
    });

    const rec = getSession("named-session");
    expect(rec?.profile).toBe("work");

    putSession("legacy-session", {
      targetId: "t2",
      readOnly: true,
      createdAt: "2026-08-05T00:00:00Z",
    });

    const oldRec = getSession("legacy-session");
    expect(oldRec?.profile).toBeUndefined();
  });
});

describe("web/guard.ts - guard fixes & action mapping", () => {
  it("maps action names correctly: close -> close_tab, close_tab -> close_tab, navigate -> navigate", () => {
    expect(mapActionName("close")).toBe("close_tab");
    expect(mapActionName("close_tab")).toBe("close_tab");
    expect(mapActionName("navigate")).toBe("navigate");
  });

  it("exempts list_tabs and close_tab from domain checks even on non-allowlisted domains", () => {
    const resList = classifyAction({
      action: "list_tabs",
      url: "https://notallowed.com/page",
      readOnly: true,
      allowlist: [],
    });
    expect(resList.decision).toBe("allow");
    expect(resList.reason).toBe("ok");

    const resClose = classifyAction({
      action: "close",
      url: "https://notallowed.com/page",
      readOnly: true,
      allowlist: [],
    });
    expect(resClose.decision).toBe("allow");
    expect(resClose.reason).toBe("ok");
  });

  it("denies file:/// URL with unsupported URL scheme and NOT acp web allow file", () => {
    const res = classifyAction({
      action: "navigate",
      url: "file:///C:/secret.txt",
      readOnly: false,
      allowlist: ["*"],
    });

    expect(res.decision).toBe("deny");
    expect(res.reason).toContain("unsupported URL scheme: file");
    expect(res.reason).not.toContain("acp web allow file");
  });

  it("allows https URL when allowlist is [*]", () => {
    expect(isDomainAllowed("https://example.com/foo", ["*"])).toBe(true);

    const res = classifyAction({
      action: "navigate",
      url: "https://example.com/foo",
      readOnly: false,
      allowlist: ["*"],
    });

    expect(res.decision).toBe("allow");
    expect(res.reason).toBe("ok");
  });

  it("denies non-allowed https host with reason containing only the host", () => {
    const res = classifyAction({
      action: "navigate",
      url: "https://restricted-domain.com/secret/page?x=1",
      readOnly: false,
      allowlist: ["allowed-domain.com"],
    });

    expect(res.decision).toBe("deny");
    expect(res.reason).toBe("domain not allowed: restricted-domain.com — run: acp web allow restricted-domain.com");
    expect(res.reason).not.toContain("secret");
  });
});

describe("web/actions.ts - pure helpers", () => {
  it("resolveVirtualKeyCode maps known keys and returns null for unknown keys", () => {
    const enter = resolveVirtualKeyCode("Enter");
    expect(enter?.windowsVirtualKeyCode).toBe(13);
    expect(enter?.code).toBe("Enter");

    const arrowDown = resolveVirtualKeyCode("ArrowDown");
    expect(arrowDown?.windowsVirtualKeyCode).toBe(40);
    expect(arrowDown?.code).toBe("ArrowDown");

    const space = resolveVirtualKeyCode("Space");
    expect(space?.windowsVirtualKeyCode).toBe(32);
    expect(space?.text).toBe(" ");

    expect(resolveVirtualKeyCode("UnknownKeyName")).toBeNull();
  });

  it("isEditableElement correctly identifies editable inputs, textareas, and contenteditables", () => {
    expect(isEditableElement({ tag: "input", type: "text" })).toBe(true);
    expect(isEditableElement({ tag: "input", type: "password" })).toBe(true);
    expect(isEditableElement({ tag: "textarea" })).toBe(true);
    expect(isEditableElement({ tag: "div", isContentEditable: true })).toBe(true);

    expect(isEditableElement({ tag: "a" })).toBe(false);
    expect(isEditableElement({ tag: "button" })).toBe(false);
    expect(isEditableElement({ tag: "input", type: "submit" })).toBe(false);
    expect(isEditableElement({ tag: "input", type: "checkbox" })).toBe(false);
    expect(isEditableElement({ tag: "input", type: "radio" })).toBe(false);
    expect(isEditableElement({ tag: "input", type: "file" })).toBe(false);
  });
});

describe("web/state.ts - session via field & resolveVia resolution", () => {
  // Same isolation rule as the token block above: this suite calls putSession,
  // and without a temp HOME it writes fixture sessions ("ext-session", "old-session")
  // straight into the user's real ~/.acp/web-sessions.json. Found them sitting there.
  let tmpHome: string;
  let origHome: string | undefined;
  let origUserProfile: string | undefined;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "acp-web-via-test-"));
    origHome = process.env.HOME;
    origUserProfile = process.env.USERPROFILE;
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;
  });

  afterEach(() => {
    process.env.HOME = origHome;
    process.env.USERPROFILE = origUserProfile;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("session record round-trips via field and old record without via leaves it undefined", () => {
    putSession("ext-session", {
      targetId: "42",
      readOnly: false,
      createdAt: "2026-08-05T00:00:00Z",
      via: "extension",
    });

    const rec = getSession("ext-session");
    expect(rec?.via).toBe("extension");

    putSession("old-session", {
      targetId: "99",
      readOnly: true,
      createdAt: "2026-08-05T00:00:00Z",
    });

    const oldRec = getSession("old-session");
    expect(oldRec?.via).toBeUndefined();
  });

  it("resolveVia resolves auto/direct/extension correctly", () => {
    expect(resolveVia("auto", true)).toBe("extension");
    expect(resolveVia("auto", false)).toBe("direct");
    expect(resolveVia(undefined, true)).toBe("extension");
    expect(resolveVia(undefined, false)).toBe("direct");

    expect(resolveVia("direct", true)).toBe("direct");
    expect(resolveVia("direct", false)).toBe("direct");

    expect(resolveVia("extension", true)).toBe("extension");
    expect(() => resolveVia("extension", false)).toThrowError("extension not connected");
  });
});

describe("extension/ static checks", () => {
  it("manifest.json exists, parses as MV3 JSON, and requests debugger permission", () => {
    const content = readFileSync(join(process.cwd(), "extension", "manifest.json"), "utf8");
    const manifest = JSON.parse(content);
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.name).toBe("ACP WebBridge");
    expect(Array.isArray(manifest.permissions)).toBe(true);
    expect(manifest.permissions).toContain("debugger");
  });

  it("bridge-core.js/sw.js exist and enforce tab control rule ('tab not under agent control')", () => {
    const coreContent = readFileSync(join(process.cwd(), "extension", "bridge-core.js"), "utf8");
    const swContent = readFileSync(join(process.cwd(), "extension", "sw.js"), "utf8");
    expect(coreContent + swContent).toContain("tab not under agent control");
  });
});

describe("web/state.ts - isResumableUrl", () => {
  it("accepts a real conversation URL", () => {
    expect(isResumableUrl("https://chat.qwen.ai/c/cef1aa46-d020-4d86-a493-b8c54fcb3a43")).toBe(true);
  });

  it("rejects pages that cannot restore a conversation", () => {
    expect(isResumableUrl("https://chat.qwen.ai/")).toBe(false); // a fresh chat
    expect(isResumableUrl("https://chat.qwen.ai/c/local")).toBe(false); // ephemeral
    expect(isResumableUrl("https://chat.qwen.ai/?temporary-chat=true")).toBe(false);
    expect(isResumableUrl("https://chat.qwen.ai/c/abc?temporary-chat=true")).toBe(false);
    expect(isResumableUrl("about:blank")).toBe(false);
    expect(isResumableUrl("file:///C:/x.html")).toBe(false);
    expect(isResumableUrl("")).toBe(false);
    expect(isResumableUrl(null)).toBe(false);
    expect(isResumableUrl("not a url")).toBe(false);
  });
});

describe("web-cli token security & token rotation", () => {
  // Without this isolation the rotation test rewrites the REAL ~/.acp/web-ext-token,
  // which silently breaks a live extension<->hub session on the developer's machine.
  // That actually happened: a test run mid-session invalidated the token the running
  // hub had cached, and every browser command then failed.
  let tmpHome: string;
  let origHome: string | undefined;
  let origUserProfile: string | undefined;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "acp-web-token-test-"));
    origHome = process.env.HOME;
    origUserProfile = process.env.USERPROFILE;
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;
  });

  afterEach(() => {
    process.env.HOME = origHome;
    process.env.USERPROFILE = origUserProfile;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("rotateHubToken creates a new 64-hex token different from previous token and writes to file", async () => {
    const { getOrCreateHubToken, rotateHubToken, hubTokenPath } = await import("../../src/web/hub.js");
    const token1 = getOrCreateHubToken();
    expect(token1).toMatch(/^[0-9a-f]{64}$/);

    const token2 = rotateHubToken();
    expect(token2).toMatch(/^[0-9a-f]{64}$/);
    expect(token2).not.toBe(token1);

    const diskToken = readFileSync(hubTokenPath(), "utf8").trim();
    expect(diskToken).toBe(token2);
  });

  it("REGRESSION GUARD: src/web-cli.ts stdout writes never leak token variables outside hub token branch", () => {
    const cliContent = readFileSync(join(process.cwd(), "src", "web-cli.ts"), "utf8");

    // Extract sub === "install" block
    const installBlock = cliContent.slice(
      cliContent.indexOf('if (sub === "install")'),
      cliContent.indexOf('if (sub === "hub")')
    );
    expect(installBlock).not.toContain("getOrCreateHubToken");
    expect(installBlock).not.toContain("${token}");

    // Extract sub === "doctor" block
    const doctorBlock = cliContent.slice(
      cliContent.indexOf('if (sub === "doctor")'),
      cliContent.indexOf('if (sub === "call")')
    );
    expect(doctorBlock).not.toContain("getOrCreateHubToken");
    expect(doctorBlock).not.toContain("${token}");

    // Extract hubSub === "start" block
    const hubStartBlock = cliContent.slice(
      cliContent.indexOf('if (hubSub === "start")'),
      cliContent.indexOf('process.stderr.write("usage: acp web hub')
    );
    expect(hubStartBlock).not.toContain("getOrCreateHubToken");
    expect(hubStartBlock).not.toContain("${token}");

    // Verify rotate token option is present in hub token branch
    expect(cliContent).toContain('hubSub === "token"');
    expect(cliContent).toContain('hasFlag("--rotate")');
  });
});
