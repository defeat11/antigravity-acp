#!/usr/bin/env node
import { QWEN_FINGERPRINT_MARKERS } from "./web/widgets/qwen-composer.js";
import { createInterface } from "node:readline";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  DEFAULT_PORT,
  profileDir,
  profilesRoot,
  listProfiles,
  ensureChrome,
  isChromeUp,
  FIRST_RUN_NOTICE,
  resolveChromePath,
  ensureDefaultChrome,
} from "./web/chrome.js";
import { BrowserTab, listPages, validateWaitArgs } from "./web/actions.js";
import { classifyAction, looksLikeCaptcha, wrapPageContent, mapActionName, isSubmitLikeKey, normalizeHost } from "./web/guard.js";
import {
  getSession,
  putSession,
  dropSession,
  readSessions,
  readDomains,
  addDomain,
  removeDomain,
  readProfiles,
  getProfileRecord,
  touchProfileRecord,
  isResumableUrl,
  readFingerprints,
  getFingerprint,
  putFingerprint,
  dropFingerprint,
  selectSessionsToClose,
  autoPruneIdleTabs,
} from "./web/state.js";
import {
  DEFAULT_MARKERS,
  computeHash,
  compareFingerprints,
  type Fingerprint,
} from "./web/fingerprint.js";
import { DirectTransport, ExtensionTransport, hubStatus } from "./web/transport.js";
import { pageSignature, evidenceAfterAction, type PageSignature } from "./web/verify-action.js";
import { suggestWaitCommand, blindWaitAdvice, knownBusyHosts } from "./web/busy-selectors.js";
import {
  recordIncident,
  readIncidents,
  summarizeIncidents,
  validateSleep,
  SLEEP_CAP_MS,
} from "./web/blind-wait-log.js";
import { startHub, getOrCreateHubToken, rotateHubToken, ensureHub } from "./web/hub.js";

const argv = process.argv.slice(2);
const sub = argv[0];

let currentTab: BrowserTab | null = null;

export function resolveVia(flag?: string, hubExtensionConnected?: boolean): "direct" | "extension" {
  const mode = flag ?? "auto";
  if (mode === "direct") return "direct";
  if (mode === "extension") {
    if (!hubExtensionConnected) {
      throw new Error(
        "extension not connected — run `acp web hub start` and switch the bridge on in the extension popup"
      );
    }
    return "extension";
  }
  return hubExtensionConnected ? "extension" : "direct";
}

export async function pruneSessions(port?: number): Promise<string[]> {
  const p = port ?? DEFAULT_PORT;
  const up = await isChromeUp(p);
  if (!up) return [];
  const pages = await listPages(p);
  const validTargets = new Set(pages.map((pg) => pg.targetId));
  const sessions = readSessions();
  const dropped: string[] = [];
  for (const [name, rec] of Object.entries(sessions)) {
    if (!validTargets.has(rec.targetId)) {
      dropSession(name);
      dropped.push(name);
    }
  }
  return dropped;
}

function finish(code: number, payload?: object): void {
  if (payload !== undefined) {
    process.stdout.write(JSON.stringify(payload) + "\n");
  }
  if (currentTab) {
    try {
      currentTab.detach();
    } catch {}
    currentTab = null;
  }
  process.exitCode = code;
  // Do NOT call process.exit() synchronously here. Exiting while a socket is
  // mid-close crashes Node on Windows with
  //   Assertion failed: !(handle->flags & UV_HANDLE_CLOSING) ... win\async.c
  // and reports 127 instead of the real exit code — it happened once, was fixed,
  // and came straight back the moment process.exit() was reintroduced.
  // Normally the loop drains on its own; the unref'd timer is only a backstop for
  // a lingering keep-alive socket, and by then the close has completed.
  const bail = setTimeout(() => process.exit(code), 250);
  if (typeof bail.unref === "function") bail.unref();
}

function getFlagValue(flag: string): string | undefined {
  const idx = argv.indexOf(flag);
  if (idx >= 0 && idx + 1 < argv.length) {
    return argv[idx + 1];
  }
  return undefined;
}

function hasFlag(flag: string): boolean {
  return argv.includes(flag);
}

function printUsageAndExit(): void {
  const helpText = [
    "acp web — ACP WebBridge browser control CLI",
    "",
    "Usage:",
    "  acp web open [url] [--profile <name>]         Launch/ensure WebBridge Chrome profile",
    "  acp web profiles [--json]                      List all named Chrome profiles",
    "  acp web status [--json] [--profile <name>]     Show browser status, sessions and allowed domains",
    "  acp web allow <domain>                         Add a domain to the allowlist",
    "  acp web deny <domain>                          Remove a domain from the allowlist",
    "  acp web domains                                List allowed domains",
    "  acp web sessions                               List saved sessions",
    "  acp web close [--session <name>]               Close a browser session tab",
    "  acp web gc [--max-age-min N] [--keep N] [--dry-run] Close idle session browser tabs",
    "  acp web doctor [--profile <name>]              Run an end-to-end self-test of the browser bridge",
    "  acp web install                                Print Chrome extension installation guide and folder path",
    "  acp web hub start [--port N]                   Run the local MV3 extension hub server",
    "  acp web hub token [--rotate]                   Print or rotate the extension hub authentication token",
    "  acp web hub status [--json]                    Show local extension hub status",
    "  acp web fingerprint capture --session <name>   Save page UI structural baseline",
    "  acp web fingerprint check --session <name>     Check current UI against baseline",
    "  acp web fingerprint list                       List stored UI baselines",
    "  acp web fingerprint forget <host>              Delete stored UI baseline",
    "  acp web call <action> [flags]                  Execute a browser action for sub-agent",
    "  acp web waits [--json] [--limit N]             Blind waits recorded so far (dead conditions, sleeps)",
    "",
    "Actions for 'acp web call':",
    "  navigate   --url <u>",
    "  snapshot",
    "  click      --ref <@eN> | --selector <css>",
    "  fill       (--ref|--selector) --value <text>",
    "  press      --key <Enter|Escape|Tab|Backspace>",
    "  evaluate   --code <js>",
    "  screenshot [--format png|jpeg] [--quality N] [--path <file>]",
    "  wait       (--until <js> | --selector <css> | --text <str> | --gone <css>) [--timeout <ms>] [--interval <ms>]",
    "  wait       --stable <css> --busy <css|none> [--window <ms>]   انتظر حتى يثبت المحتوى ويتوقف مؤشر الانشغال",
    "  sleep      --ms <n> --reason \"<لماذا لا يصلح شرط>\"          توقّف زمني صريح (بحد أقصى 10 ثوانٍ)",
    "  list_tabs",
    "  handover   --session <name>",
    "  close",
    "",
    "Call Flags:",
    "  --session <name>                               Session name (default: 'default')",
    "  --profile <name>                               Chrome profile to target (default: 'default')",
    "  --write                                        Upgrade session to allow mutating actions",
    "  --allow-submit                                 Allow form submission / Enter in text fields",
    "  --via <auto|extension|direct>                  Transport selection (default: 'auto')",
  ].join("\n");
  process.stdout.write(helpText + "\n");
  process.exitCode = 0;
}

async function main(): Promise<void> {
  if (!sub || sub === "--help" || sub === "-h") {
    printUsageAndExit();
    return;
  }

  // `acp web waits` — the log nobody had.
  //
  // The 120-second incident was already visible in the data the day it happened;
  // what was missing was anyone asking the data a question. This is the question,
  // in a form a person can read in five seconds.
  if (sub === "waits") {
    const limitArg = getFlagValue("--limit");
    const incidents = readIncidents(limitArg ? Number(limitArg) : 200);
    const sum = summarizeIncidents(incidents);

    if (hasFlag("--json")) {
      process.stdout.write(JSON.stringify({ ...sum, incidents }, null, 2) + "\n");
      process.exitCode = 0;
      return;
    }

    if (sum.total === 0) {
      process.stdout.write("لا انتظار أعمى مسجَّل.\n");
      process.exitCode = 0;
      return;
    }

    const kinds = Object.entries(sum.byKind)
      .map(([k, v]) => `${k}: ${v}`)
      .join(" · ");
    process.stdout.write(`حوادث: ${sum.total} (${kinds})\n`);
    process.stdout.write(`وقت ضائع بلا مراقبة: ${(sum.wastedMs / 1000).toFixed(1)}s\n\n`);
    for (const s2 of sum.worstSessions) {
      process.stdout.write(`  ${s2.session.padEnd(28)} ${(s2.ms / 1000).toFixed(1)}s · ${s2.count} حادثة\n`);
    }
    process.stdout.write("\nآخر الحوادث:\n");
    for (const i of incidents.slice(-8)) {
      const when = i.at.slice(0, 16).replace("T", " ");
      const detail = (i.detail ?? "").slice(0, 60);
      process.stdout.write(
        `  ${when} | ${i.kind.padEnd(14)} | ${i.session} | ${(i.ms / 1000).toFixed(1)}s${detail ? ` | ${detail}` : ""}\n`,
      );
    }
    // A finding, not a failure: scripts that gate on this should notice.
    process.exitCode = sum.byKind["dead-condition"] ? 1 : 0;
    return;
  }

  if (sub === "install") {
    const extFolder = join(process.cwd(), "extension");
    const guide = [
      "دليل تثبيت المكون الإضافي ACP WebBridge لمتصفح Chrome:",
      "",
      `1. مسار مجلد المكون الإضافي الفعلي على جهازك:`,
      `   ${extFolder}`,
      "",
      "2. افتح الصفحة التالية في متصفح Chrome الخاص بك:",
      "   chrome://extensions",
      "",
      "3. قم بتفعيل «وضع المطورين» (Developer mode) في أعلى الصفحة.",
      "",
      "4. اضغط على «تحميل غلاف غير محزوم» (Load unpacked) واختر مجلد المكون الإضافي المذكور أعلاه.",
      "",
      "5. قم بتشغيل خادم الموزع المحلي في التبويب/الشل:",
      "   acp web hub start",
      "",
      "6. رمز التوثيق الخاص بك (Hub Token):",
      "   اطبع التوكن بالأمر: acp web hub token",
      "",
      "7. انقر على أيقونة المكون الإضافي ACP WebBridge في المتصفح، والصق الرمز، واضغط حفظ وحوّل المفتاح إلى ON.",
    ].join("\n");
    process.stdout.write(guide + "\n");
    process.exitCode = 0;
    return;
  }

  if (sub === "hub") {
    const hubSub = argv[1];
    if (hubSub === "token") {
      if (hasFlag("--rotate")) {
        const newToken = rotateHubToken();
        process.stdout.write(newToken + "\n");
        process.stdout.write("تنبيه: تم تدوير التوكن. يجب تحديث الإضافة بالتوكن الجديد في نافذة البوب آب.\n");
      } else {
        process.stdout.write(getOrCreateHubToken() + "\n");
      }
      process.exitCode = 0;
      return;
    }

    if (hubSub === "status") {
      const isJson = hasFlag("--json");
      const portArg = getFlagValue("--port");
      const port = portArg ? Number(portArg) : undefined;
      const status = await hubStatus(port);

      if (isJson) {
        process.stdout.write(JSON.stringify(status) + "\n");
      } else {
        process.stdout.write(`Hub status: ${status.up ? "UP" : "DOWN"}\n`);
        process.stdout.write(`Port: ${status.port}\n`);
        process.stdout.write(`Extension connected: ${status.extension ? "YES" : "NO"}\n`);
      }
      process.exitCode = 0;
      return;
    }

    if (hubSub === "start") {
      const portArg = getFlagValue("--port");
      const port = portArg ? Number(portArg) : undefined;
      try {
        const hub = await startHub({ port });
        process.stdout.write(`Hub server listening at ${hub.url}\n`);
        process.stdout.write("Hub token command: acp web hub token\n");
        process.stdout.write("Paste the token into the extension popup and switch the bridge ON.\n");
        process.stdout.write("Press Ctrl+C to stop the hub server.\n");

        process.on("SIGINT", async () => {
          await hub.close();
          process.exit(0);
        });
        process.on("SIGTERM", async () => {
          await hub.close();
          process.exit(0);
        });

        // Keep process running foreground
        return;
      } catch (err: any) {
        process.stderr.write(`failed to start hub: ${String(err?.message || err)}\n`);
        process.exitCode = 4;
        return;
      }
    }

    process.stderr.write("usage: acp web hub <start|token|status>\n");
    process.exitCode = 2;
    return;
  }

  if (sub === "profiles") {
    const profiles = listProfiles();
    const isJson = hasFlag("--json");
    const hStatus = await hubStatus();

    if (isJson) {
      const items = await Promise.all(
        profiles.map(async (p) => ({
          ...p,
          up: await isChromeUp(p.port),
        }))
      );
      process.stdout.write(JSON.stringify(items, null, 2) + "\n");
    } else {
      process.stdout.write("WebBridge Chrome Profiles:\n");
      for (const p of profiles) {
        const up = await isChromeUp(p.port);
        const note = p.reallocatedFrom ? ` (reallocated from ${p.reallocatedFrom} — reserved port)` : "";
        process.stdout.write(
          `  - ${p.name}: port ${p.port} (${up ? "UP" : "DOWN"})${note}, dir: ${p.path}${p.lastUsed ? `, lastUsed: ${p.lastUsed}` : ""}\n`
        );
      }
      if (hStatus.up) {
        process.stdout.write(`Note: Hub server is running on port ${hStatus.port} (reserved for extension bridge).\n`);
      } else {
        process.stdout.write(`Note: Port 9334 is reserved for MV3 Extension Hub server.\n`);
      }
    }
    process.exitCode = 0;
    return;
  }

  if (sub === "open") {
    const url = argv[1] && !argv[1].startsWith("-") ? argv[1] : undefined;
    let chosenProfile = getFlagValue("--profile");

    if (!chosenProfile) {
      const profs = listProfiles();
      if (profs.length > 1 && process.stdin.isTTY) {
        process.stdout.write("Select a WebBridge Chrome profile:\n");
        profs.forEach((p, idx) => {
          process.stdout.write(`  ${idx + 1}) ${p.name} (port ${p.port})\n`);
        });
        process.stdout.write("Enter number or a new profile name [default 1]: ");

        chosenProfile = await new Promise<string>((resolve) => {
          const rl = createInterface({ input: process.stdin, output: process.stdout });
          rl.question("", (ans) => {
            rl.close();
            const trimmed = ans.trim();
            if (!trimmed || trimmed === "1") {
              resolve(profs[0]?.name ?? "default");
            } else {
              const num = parseInt(trimmed, 10);
              if (!isNaN(num) && num >= 1 && num <= profs.length) {
                resolve(profs[num - 1]?.name ?? trimmed);
              } else {
                resolve(trimmed);
              }
            }
          });
        });
      } else {
        chosenProfile = "default";
        if (!process.stdin.isTTY) {
          process.stdout.write('Using default profile "default" on port 9333.\n');
        }
      }
    }

    try {
      const res = await ensureChrome({ profile: chosenProfile, startUrl: url });
      process.stdout.write(`Profile: ${res.profile}\n`);
      process.stdout.write(res.profileDir + "\n");
      process.stdout.write(String(res.port) + "\n");
      if (res.launched) {
        process.stdout.write(FIRST_RUN_NOTICE + "\n");
      }
      process.exitCode = 0;
    } catch (err: any) {
      process.stderr.write(`failed to open chrome: ${String(err?.message || err)}\n`);
      process.exitCode = 4;
    }
    return;
  }

  if (sub === "status") {
    const isJson = hasFlag("--json");
    const profName = getFlagValue("--profile") ?? "default";
    const profRec = touchProfileRecord(profName);
    const port = profRec.port;
    const pruned = await pruneSessions(port);
    const up = await isChromeUp(port);
    const sessions = readSessions();
    const domains = readDomains();
    const pDir = profileDir(profName);

    if (isJson) {
      process.stdout.write(
        JSON.stringify({ up, profile: profName, port, profileDir: pDir, sessions, domains, pruned }) + "\n"
      );
    } else {
      if (pruned.length > 0) {
        process.stdout.write(`Pruned stale sessions: ${pruned.join(", ")}\n`);
      }
      process.stdout.write(`Profile: ${profName}\n`);
      process.stdout.write(`Chrome status: ${up ? "UP" : "DOWN"}\n`);
      process.stdout.write(`DevTools port: ${port}\n`);
      process.stdout.write(`Profile dir: ${pDir}\n`);
      process.stdout.write(`Allowed domains: ${domains.length > 0 ? domains.join(", ") : "(none)"}\n`);
      process.stdout.write(`Saved sessions: ${Object.keys(sessions).length}\n`);
      for (const [name, rec] of Object.entries(sessions)) {
        process.stdout.write(
          `  - ${name}: target ${rec.targetId} (readOnly: ${rec.readOnly}, profile: ${rec.profile ?? "default"})${rec.lastUrl ? " - " + rec.lastUrl : ""}\n`
        );
      }
    }
    process.exitCode = 0;
    return;
  }

  if (sub === "allow") {
    const domain = argv[1];
    if (!domain) {
      process.stderr.write("usage: acp web allow <domain>\n");
      process.exitCode = 2;
      return;
    }
    const list = addDomain(domain);
    process.stdout.write(`allowed domains: ${list.join(", ")}\n`);
    process.exitCode = 0;
    return;
  }

  if (sub === "deny") {
    const domain = argv[1];
    if (!domain) {
      process.stderr.write("usage: acp web deny <domain>\n");
      process.exitCode = 2;
      return;
    }
    const list = removeDomain(domain);
    process.stdout.write(`allowed domains: ${list.join(", ")}\n`);
    process.exitCode = 0;
    return;
  }

  if (sub === "domains") {
    const list = readDomains();
    process.stdout.write(`allowed domains: ${list.join(", ")}\n`);
    process.exitCode = 0;
    return;
  }

  if (sub === "sessions") {
    const profName = getFlagValue("--profile") ?? "default";
    const profRec = touchProfileRecord(profName);
    await pruneSessions(profRec.port);
    const sessions = readSessions();
    process.stdout.write(JSON.stringify(sessions, null, 2) + "\n");
    process.exitCode = 0;
    return;
  }

  if (sub === "close") {
    const sessionName = getFlagValue("--session") ?? "default";
    const rec = getSession(sessionName);
    if (rec) {
      try {
        const profName = rec.profile ?? getFlagValue("--profile") ?? "default";
        const profRec = touchProfileRecord(profName);
        const tab = await BrowserTab.attach({ port: profRec.port, targetId: rec.targetId });
        await tab.close();
      } catch {}
      dropSession(sessionName);
      process.stdout.write(`session closed: ${sessionName}\n`);
    } else {
      process.stdout.write(`session not found: ${sessionName}\n`);
    }
    process.exitCode = 0;
    return;
  }

  if (sub === "gc") {
    const isDryRun = hasFlag("--dry-run");
    const maxAgeArg = getFlagValue("--max-age-min");
    const keepArg = getFlagValue("--keep");
    const maxAgeMin = maxAgeArg ? Number(maxAgeArg) : 60;
    const keep = keepArg ? Number(keepArg) : 3;

    const sessions = readSessions();
    const selected = selectSessionsToClose(sessions, { maxAgeMin, keep });

    if (isDryRun) {
      if (selected.length === 0) {
        process.stdout.write("[dry-run] No idle session tabs to close.\n");
      } else {
        process.stdout.write(`[dry-run] Would close ${selected.length} idle session tabs: ${selected.join(", ")}\n`);
      }
      process.exitCode = 0;
      return;
    }

    const closed: string[] = [];
    for (const name of selected) {
      const rec = sessions[name];
      if (!rec || !rec.targetId) continue;
      try {
        if (rec.via === "extension") {
          const transport = await ExtensionTransport.attachTab({ tabId: Number(rec.targetId) });
          await transport.closeTab();
        } else {
          const profRec = touchProfileRecord(rec.profile || "default");
          const tab = await BrowserTab.attach({ port: profRec.port, targetId: rec.targetId });
          await tab.close();
        }
      } catch {}
      putSession(name, { ...rec, targetId: "" });
      closed.push(name);
    }

    if (closed.length === 0) {
      process.stdout.write("No idle session tabs closed.\n");
    } else {
      process.stdout.write(`Closed ${closed.length} idle session tabs: ${closed.join(", ")}\n`);
    }
    process.exitCode = 0;
    return;
  }

  if (sub === "doctor") {
    const profName = getFlagValue("--profile") ?? "default";
    const profRec = touchProfileRecord(profName);
    const doctorPort = profRec.port;

    let allPassed = true;
    const logStep = (step: number, name: string, pass: boolean, detail?: string) => {
      if (!pass) allPassed = false;
      const mark = pass ? "PASS" : "FAIL";
      process.stdout.write(`Step ${step}: ${name} ... [${mark}]${detail ? " - " + detail : ""}\n`);
    };

    // 1. chrome resolved
    const chromePath = resolveChromePath();
    logStep(1, "chrome resolved", chromePath !== null, chromePath ?? "not found");

    // 2. chrome up
    let chromeRes: { launched: boolean; profile: string; port: number; profileDir: string } | null = null;
    try {
      chromeRes = await ensureChrome({ profile: profName, port: doctorPort });
      logStep(2, "chrome up", true, `launched: ${chromeRes.launched}, profile: ${chromeRes.profile}, dir: ${chromeRes.profileDir}`);
    } catch (err: any) {
      logStep(2, "chrome up", false, String(err?.message || err));
    }

    if (!chromeRes) {
      process.stdout.write("\nDoctor summary: FAIL (Chrome not available)\n");
      process.exitCode = 1;
      return;
    }

    // 3. page opened
    const tmpHtmlPath = join(tmpdir(), `acp-doctor-${Date.now()}.html`);
    const htmlContent = `<!DOCTYPE html>
<html>
<head><title>ACP WebDoctor</title></head>
<body>
  <input id="q" type="text" />
  <button id="go" onclick="window.__acpDoctor = { trusted: event.isTrusted, val: document.getElementById('q').value }">Submit</button>
  <a id="link" href="#test">Link</a>
</body>
</html>`;
    writeFileSync(tmpHtmlPath, htmlContent, "utf8");

    let tab: BrowserTab | null = null;
    try {
      const docUrl = pathToFileURL(tmpHtmlPath).href;
      tab = await BrowserTab.open({ profile: profName, port: doctorPort, startUrl: docUrl });
      await tab.navigate(docUrl);
      logStep(3, "page opened", true, `temp HTML: ${tmpHtmlPath}`);
    } catch (err: any) {
      logStep(3, "page opened", false, String(err?.message || err));
    }

    if (tab) {
      try {
        // 4. snapshot
        const snap = await tab.snapshot();
        const inputNode = snap.nodes.find((n) => n.tag === "input");
        const buttonNode = snap.nodes.find((n) => n.tag === "button");
        const linkNode = snap.nodes.find((n) => n.tag === "a");
        const snapPass = snap.nodes.length >= 3 && Boolean(inputNode) && Boolean(buttonNode) && Boolean(linkNode);
        logStep(4, "snapshot", snapPass, `nodes: ${snap.nodes.length}, inputRef: ${inputNode?.ref}`);

        // 5. trusted typing
        if (inputNode && buttonNode) {
          const fillRes = await tab.fill(inputNode.ref, "acp-doctor-test");
          const clickRes = await tab.click(buttonNode.ref);
          const evalRes = await tab.evaluate("window.__acpDoctor");
          const doctorVal = evalRes.value as { trusted?: boolean; val?: string } | undefined;
          const typePass = fillRes.ok && clickRes.ok && doctorVal?.trusted === true && doctorVal?.val === "acp-doctor-test";
          logStep(
            5,
            "trusted typing",
            typePass,
            `trusted: ${doctorVal?.trusted}, val: "${doctorVal?.val}"`
          );
        } else {
          logStep(5, "trusted typing", false, "input or button ref missing from snapshot");
        }

        // 6. not detected as a bot
        const webdriverEval = await tab.evaluate("navigator.webdriver");
        const uaEval = await tab.evaluate("navigator.userAgent");
        const webdriverVal = webdriverEval.value;
        const uaVal = String(uaEval.value || "");
        const botPass = webdriverVal === false && !uaVal.includes("HeadlessChrome");
        logStep(
          6,
          "not detected as a bot",
          botPass,
          `navigator.webdriver: ${webdriverVal}, userAgent: ${uaVal.slice(0, 60)}...`
        );

        // 7. fill guard
        if (linkNode) {
          const linkFill = await tab.fill(linkNode.ref, "test");
          const fillGuardPass = linkFill.ok === false;
          logStep(
            7,
            "fill guard",
            fillGuardPass,
            `fill on link returned ok: ${linkFill.ok} (${linkFill.error})`
          );
        } else {
          logStep(7, "fill guard", false, "link ref missing from snapshot");
        }

        // 8. screenshot
        const shotRes = await tab.screenshot();
        const shotPass = shotRes.ok && shotRes.sizeBytes > 1000;
        logStep(
          8,
          "screenshot",
          shotPass,
          `path: ${shotRes.path}, size: ${shotRes.sizeBytes} bytes`
        );
      } catch (err: any) {
        logStep(4, "browser actions", false, String(err?.message || err));
      } finally {
        await tab.close();
        try {
          rmSync(tmpHtmlPath, { force: true });
        } catch {}
      }
    }

    // 9. guard rules (pure checks)
    const denyCheck = classifyAction({
      action: "navigate",
      readOnly: false,
      url: "https://unallowed-domain-test-123.com",
      allowlist: [],
    });
    const clickReadOnlyCheck = classifyAction({
      action: "click",
      readOnly: true,
      allowlist: [],
    });
    const evalReadOnlyCheck = classifyAction({
      action: "evaluate",
      readOnly: true,
      allowlist: [],
    });
    const allowStarCheck = classifyAction({
      action: "navigate",
      readOnly: false,
      url: "https://example.com",
      allowlist: ["*"],
    });

    const guardRulesPass =
      denyCheck.decision === "deny" &&
      clickReadOnlyCheck.decision === "needs_user" &&
      evalReadOnlyCheck.decision === "needs_user" &&
      allowStarCheck.decision === "allow";

    logStep(9, "guard rules", guardRulesPass, "pure policy checks passed");

    // 10. cleanup
    logStep(10, "cleanup", true, "tab closed, temp files removed, state untouched");

    // 11. extension mode check
    const status = await hubStatus();
    let extStatusText = "SKIPPED";
    if (!status.extension) {
      const extDir = join(process.cwd(), "extension");
      process.stdout.write(
        `Step 11: extension mode ... [SKIP] - extension not connected — run \`acp web hub start\`, load unpacked extension folder (${extDir}) in chrome://extensions (Developer mode ON), paste token (اطبع التوكن بالأمر: acp web hub token), and switch bridge ON\n`
      );
    } else {
      let extPass = false;
      let extDetail = "";
      const tmpHtmlPathExt = join(tmpdir(), `acp-doctor-ext-${Date.now()}.html`);
      const htmlContentExt = `<!DOCTYPE html>
<html>
<head><title>ACP WebDoctor Ext</title></head>
<body>
  <input id="q" type="text" />
  <button id="go" onclick="window.__acpDoctor = { trusted: event.isTrusted, val: document.getElementById('q').value }">Submit</button>
</body>
</html>`;
      writeFileSync(tmpHtmlPathExt, htmlContentExt, "utf8");
      try {
        const extTransport = await ExtensionTransport.createTab({ url: pathToFileURL(tmpHtmlPathExt).href });
        const extTab = BrowserTab.fromTransport(extTransport);
        const snap = await extTab.snapshot();
        const inputNode = snap.nodes.find((n) => n.tag === "input");
        const buttonNode = snap.nodes.find((n) => n.tag === "button");
        if (inputNode && buttonNode) {
          await extTab.fill(inputNode.ref, "acp-doctor-ext-test");
          await extTab.click(buttonNode.ref);
          const evalRes = await extTab.evaluate("window.__acpDoctor");
          const doctorVal = evalRes.value as { trusted?: boolean; val?: string } | undefined;
          extPass = doctorVal?.trusted === true && doctorVal?.val === "acp-doctor-ext-test";
          extDetail = `trusted: ${doctorVal?.trusted}, val: "${doctorVal?.val}"`;
        } else {
          extDetail = "input or button missing from snapshot";
        }
        await extTab.close();
      } catch (err: any) {
        extDetail = String(err?.message || err);
      } finally {
        try {
          rmSync(tmpHtmlPathExt, { force: true });
        } catch {}
      }
      if (!extPass) allPassed = false;
      extStatusText = extPass ? "PASS" : "FAIL";
      logStep(11, "extension mode", extPass, extDetail);
    }

    const directStatus = allPassed ? "PASS" : "FAIL";
    process.stdout.write(`\nDoctor summary: ${allPassed ? "PASS" : "FAIL"} (direct: ${directStatus}, extension: ${extStatusText})\n`);
    process.exitCode = allPassed ? 0 : 1;
    return;
  }

  if (sub === "fingerprint") {
    const fpSub = argv[1];
    if (fpSub === "list") {
      const fps = readFingerprints();
      const list = Object.values(fps).map((f) => ({
        host: f.host,
        capturedAt: f.capturedAt,
        hash: f.hash,
        markersCount: f.markers.length,
      }));
      process.stdout.write(JSON.stringify(list, null, 2) + "\n");
      process.exitCode = 0;
      return;
    }

    if (fpSub === "forget") {
      const host = argv[2];
      if (!host) {
        process.stderr.write("usage: acp web fingerprint forget <host>\n");
        finish(2);
        return;
      }
      dropFingerprint(host);
      finish(0, { ok: true, host });
      return;
    }

    if (fpSub === "capture" || fpSub === "check") {
      const sessionName = getFlagValue("--session") ?? "default";
      const rec = getSession(sessionName);
      if (!rec) {
        finish(4, {
          ok: false,
          error: `session "${sessionName}" not found — call navigate or open first`,
        });
        return;
      }
      const profileFlag = getFlagValue("--profile");
      const chosenProfile = rec.profile ?? profileFlag ?? "default";
      const profRec = touchProfileRecord(chosenProfile);
      let tab: BrowserTab;
      try {
        if (rec.via === "extension") {
          const transport = await ExtensionTransport.attachTab({
            tabId: Number(rec.targetId),
          });
          tab = BrowserTab.fromTransport(transport);
        } else {
          tab = await BrowserTab.attach({ port: profRec.port, targetId: rec.targetId });
        }
      } catch (err: any) {
        finish(4, { ok: false, error: String(err?.message || err) });
        return;
      }

      const pageUrlEval = await tab.evaluate("document.location.href");
      const pageUrl =
        pageUrlEval.ok && typeof pageUrlEval.value === "string"
          ? pageUrlEval.value
          : rec.lastUrl;
      const host = pageUrl ? normalizeHost(pageUrl) : null;

      if (!host) {
        finish(4, { ok: false, error: "cannot identify host for fingerprint operation" });
        return;
      }

      if (fpSub === "capture") {
        const selectorsArg = getFlagValue("--selectors");
        // A generic marker set cannot notice that a site's own load-bearing
        // widget disappeared. The site contributes the selectors it depends on,
        // so a UI change trips the fingerprint instead of surfacing later as a
        // consultation that ran in the wrong mode.
        const selectors = selectorsArg
          ? selectorsArg.split(",").map((s) => s.trim()).filter(Boolean)
          : [
              ...DEFAULT_MARKERS,
              ...(/(^|\.)chat\.qwen\.ai$/i.test(host) ? QWEN_FINGERPRINT_MARKERS : []),
            ];
        const markers = await tab.observeMarkers(selectors);
        const hash = computeHash(markers);
        const fp: Fingerprint = {
          host,
          hash,
          capturedAt: new Date().toISOString(),
          markers,
        };
        putFingerprint(host, fp);
        finish(0, { ok: true, host, hash, markersCount: markers.length });
        return;
      }

      if (fpSub === "check") {
        // WARNING, NOT A GATE: fingerprint check returns exit code 0 in both match and mismatch cases so site redesigns do not block agent execution.
        const baseline = getFingerprint(host);
        if (!baseline) {
          finish(0, { ok: false, error: `no baseline stored for host: ${host}` });
          return;
        }
        const selectors = baseline.markers.map((m) => m.selector);
        const currentMarkers = await tab.observeMarkers(selectors);
        const currentFp: Fingerprint = {
          host,
          hash: computeHash(currentMarkers),
          capturedAt: new Date().toISOString(),
          markers: currentMarkers,
        };
        const cmp = compareFingerprints(baseline, currentFp);
        if (cmp.match) {
          finish(0, { ok: true, match: true, host });
        } else {
          finish(0, { ok: true, match: false, host, changed: cmp.changed });
        }
        return;
      }
    }

    process.stderr.write(
      "usage: acp web fingerprint <capture|check|list|forget> [flags]\n"
    );
    finish(2);
    return;
  }

  if (sub === "call") {
    const action = argv[1];
    const sessionName = getFlagValue("--session") ?? "default";

    // Auto-prune idle session tabs on invocation
    await autoPruneIdleTabs(sessionName);
    const SUPPORTED_CALL_ACTIONS = [
      "navigate",
      "snapshot",
      "click",
      "fill",
      "press",
      "evaluate",
      "screenshot",
      "list_tabs",
      "handover",
      "close",
      "wait",
      "sleep",
    ];

    if (!action) {
      process.stderr.write("usage: acp web call <action> [flags]\n");
      finish(2);
      return;
    }

    const writeFlag = hasFlag("--write");
    const viaFlag = getFlagValue("--via");
    const profileFlag = getFlagValue("--profile");
    const allowSubmitFlag = hasFlag("--allow-submit");

    if (action === "handover") {
      try {
        const transport = await ExtensionTransport.handover();
        if (!transport) {
          finish(3, {
            ok: false,
            decision: "needs_user",
            reason: "no tab handed over — press «استخدم هذا التبويب» in the extension popup",
          });
          return;
        }
        const tab = BrowserTab.fromTransport(transport);
        const rec = {
          targetId: tab.targetId,
          readOnly: false,
          createdAt: new Date().toISOString(),
          via: "extension" as const,
          profile: profileFlag ?? "default",
        };
        putSession(sessionName, rec);
        finish(0, { ok: true, session: sessionName, targetId: tab.targetId, via: "extension" });
        return;
      } catch (err: any) {
        finish(4, { ok: false, error: String(err?.message || err) });
        return;
      }
    }

    const mappedAction = mapActionName(action);
    const validCallActions = new Set([
      "navigate",
      "snapshot",
      "click",
      "fill",
      "press",
      "evaluate",
      "screenshot",
      "list_tabs",
      "handover",
      "close",
      "close_tab",
      "wait",
      "sleep",
    ]);

    if (!validCallActions.has(mappedAction)) {
      finish(2, { ok: false, error: `unknown action: ${action}`, actions: SUPPORTED_CALL_ACTIONS });
      return;
    }

    const urlArg = getFlagValue("--url");
    const refArg = getFlagValue("--ref");
    const selectorArg = getFlagValue("--selector");
    const valueArg = getFlagValue("--value");
    const keyArg = getFlagValue("--key");
    const codeArg = getFlagValue("--code");
    const formatArg = getFlagValue("--format");
    const qualityArg = getFlagValue("--quality");
    const pathArg = getFlagValue("--path");
    const untilArg = getFlagValue("--until");
    const textArg = getFlagValue("--text");
    const goneArg = getFlagValue("--gone");
    const stableArg = getFlagValue("--stable");
    const busyArg = getFlagValue("--busy");
    const windowArg = getFlagValue("--window");
    const timeoutArg = getFlagValue("--timeout");
    const intervalArg = getFlagValue("--interval");

    if (mappedAction === "wait") {
      const invalid = validateWaitArgs({
        untilJs: untilArg,
        selector: selectorArg,
        text: textArg,
        gone: goneArg,
        stable: stableArg,
        busy: busyArg,
      });
      if (invalid) {
        process.stderr.write(
          "usage: acp web call wait (--until <js> | --selector <css> | --text <str> | --gone <css> | --stable <css> --busy <css|none>) [--window <ms>] [--timeout <ms>] [--interval <ms>]\n"
        );
        // Point at the signal, do not merely name the rule.
        //
        // An agent that cannot express "wait until the reply is finished" writes
        // a sleep instead — that is what produced `--until "false" --timeout
        // 120000`. The cheapest cure is a line it can copy, so the honest path
        // becomes less work than the workaround rather than more.
        const known = getSession(sessionName);
        const hostHint = known?.lastUrl ? normalizeHost(known.lastUrl) : "";
        const hint = hostHint ? suggestWaitCommand(hostHint, sessionName) : null;
        process.stderr.write(
          hint
            ? `للانتظار حتى يكتمل الرد هنا:\n  ${hint}\n`
            : `مواقع لها وصفة جاهزة: ${knownBusyHosts().join(", ") || "(لا شيء بعد)"}\n`,
        );
        finish(2, invalid);
        return;
      }
    }

    // ACP looks after its own plumbing: bring the hub up on demand instead of
    // making the user remember to start it (and instead of reporting its absence
    // as "extension not connected", which sends people fixing the wrong thing).
    let selfHealNote: string | undefined = undefined;
    try {
      const hub = await ensureHub();
      if (hub.started) selfHealNote = "started the hub";
    } catch {
      // Fall through: hubStatus() below reports it and direct mode still works.
    }

    let status = await hubStatus();

    // Extension mode with no extension: the usual cause is that Chrome is simply
    // closed, or its service worker was evicted. Open Chrome and wait rather than
    // failing with an instruction the user would have to carry out by hand.
    const wantsExtension =
      viaFlag === "extension" || (getSession(sessionName)?.via ?? null) === "extension";
    if (!status.extension && status.up && wantsExtension) {
      try {
        const ch = await ensureDefaultChrome();
        if (ch.launched) selfHealNote = selfHealNote ? `${selfHealNote}, opened Chrome` : "opened Chrome";
        const waitUntil = Date.now() + 95000;
        while (Date.now() < waitUntil && !status.extension) {
          await new Promise((r) => setTimeout(r, 2000));
          status = await hubStatus();
        }
      } catch {
        // Reported through the normal via/extension error paths below.
      }
    }

    let chosenVia: "direct" | "extension";

    let rec = getSession(sessionName);
    if (rec) {
      const sessionProfile = rec.profile ?? "default";
      if (profileFlag && profileFlag !== sessionProfile) {
        finish(4, {
          ok: false,
          error: `session "${sessionName}" belongs to profile "${sessionProfile}" — cannot reattach using profile "${profileFlag}"`,
        });
        return;
      }
    }

    const chosenProfile = rec?.profile ?? profileFlag ?? "default";
    const profRec = touchProfileRecord(chosenProfile);

    try {
      chosenVia = rec?.via ?? resolveVia(viaFlag, status.extension);
    } catch (err: any) {
      finish(4, { ok: false, error: String(err?.message || err) });
      return;
    }

    // "auto" silently choosing the dedicated profile is a trap: that profile is
    // logged out, so the caller believes it is in the user's account and quietly
    // gets a guest session instead. Say so out loud. (Seen for real: the MV3
    // service worker was briefly evicted, and the run landed on chat.qwen.ai/c/guest.)
    const autoFellBack =
      !rec && chosenVia === "direct" && (viaFlag === "auto" || viaFlag === undefined);

    let upgradedNotice: string | undefined = undefined;
    // Carries a dead session's conversation URL over to the cold start below.
    let resumeUrl: string | undefined = undefined;
    let resumedNotice: string | undefined = undefined;

    if (rec) {
      if (writeFlag && rec.readOnly) {
        rec.readOnly = false;
        rec.via = chosenVia;
        rec.profile = chosenProfile;
        putSession(sessionName, rec);
        upgradedNotice = "session is now writable";
      }
      try {
        if (chosenVia === "extension") {
          const transport = await ExtensionTransport.attachTab({ tabId: Number(rec.targetId) });
          currentTab = BrowserTab.fromTransport(transport);
        } else {
          currentTab = await BrowserTab.attach({ port: profRec.port, targetId: rec.targetId });
        }
        // attachTab() in extension mode builds the transport without talking to
        // the browser, so a tab the user closed only fails later, mid-action.
        // Probe it here instead, while we can still recover cleanly.
        const probe = await currentTab.evaluate("1");
        if (!probe.ok) throw new Error(probe.error || "tab probe failed");
      } catch {
        currentTab = null;
        resumeUrl = rec.resumeUrl;
        dropSession(sessionName);
        rec = null;
      }
    }

    if (!currentTab) {
      // COLD START
      try {
        if (chosenVia === "extension") {
          const transport = await ExtensionTransport.createTab({ url: "about:blank" });
          currentTab = BrowserTab.fromTransport(transport);
        } else {
          const transport = await DirectTransport.openNewTab({ profile: chosenProfile, port: profRec.port, startUrl: "about:blank" });
          currentTab = BrowserTab.fromTransport(transport);
        }
        // The tab this session used to live in is gone, but the conversation it
        // was in is not: reopen it at its own URL so the session keeps its thread.
        if (resumeUrl) {
          const back = await currentTab.navigate(resumeUrl);
          resumedNotice = back.url;
        }
        const readOnly = !writeFlag;
        rec = {
          targetId: currentTab.targetId,
          readOnly,
          createdAt: new Date().toISOString(),
          via: chosenVia,
          profile: chosenProfile,
          resumeUrl,
        };
        putSession(sessionName, rec);
      } catch (err: any) {
        finish(4, { ok: false, error: String(err?.message || err) });
        return;
      }
    }

    const tab = currentTab;
    const sessionReadOnly = rec ? rec.readOnly : !writeFlag;

    /**
     * Remember where this session is, so the next call can come back here even if
     * the tab is gone. A conversation URL only exists AFTER the first message is
     * sent, so this runs after every action rather than only on navigate.
     */
    const rememberResumeUrl = async (): Promise<void> => {
      try {
        const cur = await tab.evaluate("document.location.href");
        if (!cur.ok || typeof cur.value !== "string") return;
        if (!isResumableUrl(cur.value)) return;
        const latest = getSession(sessionName);
        if (!latest || latest.resumeUrl === cur.value) return;
        putSession(sessionName, { ...latest, resumeUrl: cur.value, lastUrl: cur.value });
      } catch {
        // Never let bookkeeping fail the user's action.
      }
    };

    const respond = async (code: number, resObj: Record<string, any>): Promise<void> => {
      if (upgradedNotice) {
        resObj.upgraded = upgradedNotice;
      }
      if (resumedNotice) {
        resObj.resumed = resumedNotice;
      }
      if (code === 0) {
        resObj.via = chosenVia;
      }
      if (selfHealNote) {
        resObj.selfHeal = selfHealNote;
      }
      if (autoFellBack) {
        resObj.note =
          "extension not connected — fell back to the dedicated profile, which is NOT logged in; pass --via extension to require the real browser session";
      }
      if (allowSubmitFlag && code === 0 && (mappedAction === "press" || mappedAction === "click")) {
        resObj.submitted = true;
      }

      // Feature 2: UI fingerprint early warning check (skip if no baseline stored)
      try {
        const curLocation = await tab.evaluate("document.location.href");
        if (curLocation.ok && typeof curLocation.value === "string") {
          const host = normalizeHost(curLocation.value);
          if (host) {
            const baseline = getFingerprint(host);
            if (baseline) {
              const currentMarkers = await tab.observeMarkers(
                baseline.markers.map((m) => m.selector)
              );
              const currentFp: Fingerprint = {
                host,
                hash: computeHash(currentMarkers),
                capturedAt: new Date().toISOString(),
                markers: currentMarkers,
              };
              const cmp = compareFingerprints(baseline, currentFp);
              if (!cmp.match) {
                resObj.uiChanged = true;
                const changedSelectors = cmp.changed.map((c) => c.selector).join(", ");
                resObj.uiChangedHint = `selectors changed: ${changedSelectors}`;
              }
            }
          }
        }
      } catch {
        // Fingerprint check is a best-effort warning — never let it break action execution
      }

      finish(code, resObj);
    };

    // Safety check before acting
    try {
      let pageUrl: string | null = null;
      if (mappedAction === "navigate") {
        pageUrl = urlArg ?? null;
      } else {
        const evalRes = await tab.evaluate("document.location.href");
        if (evalRes.ok && typeof evalRes.value === "string") {
          pageUrl = evalRes.value;
          // Free resume point: the URL is already in hand. This is what catches
          // the conversation id that the site only assigns after the first reply.
          if (isResumableUrl(pageUrl)) {
            const latest = getSession(sessionName);
            if (latest && latest.resumeUrl !== pageUrl) {
              putSession(sessionName, { ...latest, resumeUrl: pageUrl, lastUrl: pageUrl });
            }
          }
        } else if (rec?.lastUrl) {
          pageUrl = rec.lastUrl;
        }
      }

      let label: string | null = null;
      const selector = refArg ? refArg : selectorArg;
      if ((mappedAction === "click" || mappedAction === "fill") && selector) {
        const resolveLabelScript = `(() => {
          const sel = ${JSON.stringify(selector)};
          let el = null;
          if (sel.startsWith('@e')) {
            const idx = parseInt(sel.slice(2), 10);
            if (window.__acpRefs && window.__acpRefs[idx]) el = window.__acpRefs[idx];
          } else {
            el = document.querySelector(sel);
          }
          if (!el) return null;
          return (
            (el.innerText || el.textContent || '').trim().slice(0, 120) ||
            el.getAttribute('aria-label') ||
            el.getAttribute('placeholder') ||
            el.value ||
            el.getAttribute('title') ||
            ''
          ).trim();
        })()`;
        const labelEval = await tab.evaluate(resolveLabelScript);
        if (labelEval.ok && typeof labelEval.value === "string") {
          label = labelEval.value;
        }
      }

      let inEditable = false;
      if (mappedAction === "press" && isSubmitLikeKey(keyArg)) {
        const evalInEditable = await tab.evaluate(`(() => {
          const el = document.activeElement;
          if (!el || el === document.body) return false;
          const tag = el.tagName.toLowerCase();
          if (tag === 'textarea') return true;
          if (el.isContentEditable) return true;
          if (tag === 'input') {
            const type = (el.getAttribute('type') || 'text').toLowerCase();
            const nonText = new Set(['button', 'submit', 'reset', 'checkbox', 'radio', 'file', 'image']);
            if (!nonText.has(type)) return true;
          }
          if (el.closest('form')) return true;
          return false;
        })()`);
        if (evalInEditable.ok && evalInEditable.value === true) {
          inEditable = true;
        }
      }

      let isSubmitControl = false;
      if (mappedAction === "click" && selector) {
        const evalSubmit = await tab.evaluate(`(() => {
          const sel = ${JSON.stringify(selector)};
          let el = null;
          if (sel.startsWith('@e')) {
            const idx = parseInt(sel.slice(2), 10);
            if (window.__acpRefs && window.__acpRefs[idx]) el = window.__acpRefs[idx];
          } else {
            el = document.querySelector(sel);
          }
          if (!el) return false;
          const tag = el.tagName.toLowerCase();
          const type = (el.getAttribute('type') || '').toLowerCase();
          if (tag === 'button' && (type === 'submit' || (!type && el.closest('form')))) return true;
          if (tag === 'input' && type === 'submit') return true;
          return false;
        })()`);
        if (evalSubmit.ok && evalSubmit.value === true) {
          isSubmitControl = true;
        }
      }

      const check = classifyAction({
        action: mappedAction,
        readOnly: sessionReadOnly,
        label,
        url: pageUrl,
        allowlist: readDomains(),
        key: keyArg,
        inEditable,
        isSubmitControl,
        allowSubmit: allowSubmitFlag,
      });

      if (check.decision === "deny" || check.decision === "needs_user") {
        await respond(3, { ok: false, decision: check.decision, reason: check.reason });
        return;
      }

      // Execute requested action
      if (mappedAction === "navigate") {
        if (!urlArg) {
          process.stderr.write("usage: acp web call navigate --url <url>\n");
          finish(2);
          return;
        }
        const navRes = await tab.navigate(urlArg);
        rec = getSession(sessionName);
        if (rec) {
          putSession(sessionName, { ...rec, lastUrl: navRes.url });
        }
        await rememberResumeUrl();
        await respond(0, { ok: true, url: navRes.url });
        return;
      }

      if (mappedAction === "snapshot") {
        const snap = await tab.snapshot();
        const wrappedText = wrapPageContent(snap.text);
        const captcha = looksLikeCaptcha(snap.text);
        let text = wrappedText;
        let nodes = snap.nodes;
        let truncated = false;

        if (text.length > 4000) {
          text = text.slice(0, 4000);
          truncated = true;
        }
        if (nodes.length > 150) {
          nodes = nodes.slice(0, 150);
          truncated = true;
        }

        const out: Record<string, any> = {
          ok: true,
          url: snap.url,
          title: snap.title,
          nodes,
          text,
          captcha,
        };
        if (truncated) {
          out.truncated = true;
        }
        await respond(0, out);
        return;
      }


      // Evidence for actions whose expectations only the caller knows.
      //
      // `acp web call` drives arbitrary sites for a sub-agent, so it cannot say
      // what SHOULD change after a click. It can say whether anything changed at
      // all and whether the site put up a notice — and that is precisely the gap
      // that let a click on a non-existent button be reported as success for
      // weeks. `{"ok":true}` with nothing behind it is the failure this closes.
      const withEvidence = async (
        before: PageSignature | null,
        res: Record<string, any>,
      ): Promise<Record<string, any>> => {
        if (!res.ok) return res;
        const ev = await evidenceAfterAction(tab, before);
        res.changed = ev.changed;
        if (ev.after?.url) res.url = ev.after.url;
        if (ev.after?.notice) res.notice = ev.after.notice;
        if (ev.siteError) {
          res.siteError = ev.siteError;
          process.stderr.write(`site notice (${ev.siteError.kind}): ${ev.after?.notice ?? ""}
`);
        }
        if (ev.changed.length === 0) {
          // Not an error — the caller may have clicked something inert — but it
          // must never look like proof that the action worked.
          res.changed = ["لم يتغيّر شيء ظاهر في الصفحة"];
        }
        return res;
      };

      if (mappedAction === "click") {
        if (!selector) {
          process.stderr.write("usage: acp web call click (--ref <@eN> | --selector <css>)\n");
          finish(2);
          return;
        }
        const before = await pageSignature(tab);
        const res = await tab.click(selector);
        // A click is what turns a blank chat into a real conversation with its
        // own URL, so this is the moment worth recording.
        if (res.ok) {
          await rememberResumeUrl();
          res.visible = true;
        }
        await respond(res.ok ? 0 : 4, await withEvidence(before, res));
        return;
      }

      if (mappedAction === "fill") {
        if (!selector || valueArg === undefined) {
          process.stderr.write(
            "usage: acp web call fill (--ref <@eN> | --selector <css>) --value <text>\n"
          );
          finish(2);
          return;
        }
        const before = await pageSignature(tab);
        const res = await tab.fill(selector, valueArg);
        if (res.ok) {
          res.visible = true;
        }
        await respond(res.ok ? 0 : 4, await withEvidence(before, res));
        return;
      }

      if (mappedAction === "press") {
        if (!keyArg) {
          process.stderr.write("usage: acp web call press --key <key>\n");
          finish(2);
          return;
        }
        const before = await pageSignature(tab);
        const res = await tab.press(keyArg);
        if (res.ok) {
          await rememberResumeUrl();
          res.visible = true;
        }
        await respond(res.ok ? 0 : 4, await withEvidence(before, res));
        return;
      }

      if (mappedAction === "evaluate") {
        if (!codeArg) {
          process.stderr.write("usage: acp web call evaluate --code <js>\n");
          finish(2);
          return;
        }
        const res = await tab.evaluate(codeArg);
        await respond(res.ok ? 0 : 4, res);
        return;
      }

      if (mappedAction === "screenshot") {
        const res = await tab.screenshot({
          format: formatArg as any,
          quality: qualityArg ? Number(qualityArg) : undefined,
          path: pathArg,
        });
        await respond(res.ok ? 0 : 4, res);
        return;
      }

      if (mappedAction === "sleep") {
        // An honest pause: short, reasoned, and written down.
        //
        // Naming it does not by itself stop blind waiting — an agent reaching for
        // a sleep usually does not know a signal exists — but it stops a pause
        // from wearing the costume of a condition, and it puts every one of them
        // in a log somebody can read.
        const ms = Number(getFlagValue("--ms"));
        const reason = getFlagValue("--reason");
        const bad = validateSleep({ ms, reason: reason ?? "" });
        if (bad) {
          process.stderr.write(bad + "\n");
          const hintHost = (await tab.evaluate("location.host")).value;
          const hint =
            typeof hintHost === "string" ? suggestWaitCommand(hintHost, sessionName) : null;
          if (hint) process.stderr.write(`بديل جاهز:\n  ${hint}\n`);
          finish(2, { ok: false, error: bad, cap: SLEEP_CAP_MS });
          return;
        }
        const hostNow = (await tab.evaluate("location.host")).value;
        recordIncident({
          at: new Date().toISOString(),
          kind: "sleep",
          session: sessionName,
          host: typeof hostNow === "string" ? hostNow : "",
          ms,
          detail: reason,
        });
        await new Promise((r) => setTimeout(r, ms));
        await respond(0, { ok: true, slept: ms, reason });
        return;
      }

      if (mappedAction === "wait") {
        // The SECOND gate. There are two, and updating only the first meant a
        // valid `--stable --busy` command was accepted at the door and rejected
        // at the desk — with the old usage line, which is what gave it away.
        const invalid = validateWaitArgs({
          untilJs: untilArg,
          selector: selectorArg,
          text: textArg,
          gone: goneArg,
          stable: stableArg,
          busy: busyArg,
        });
        if (invalid) {
          process.stderr.write(
            "usage: acp web call wait (--until <js> | --selector <css> | --text <str> | --gone <css> | --stable <css> --busy <css|none>) [--window <ms>] [--timeout <ms>] [--interval <ms>]\n"
          );
          finish(2, invalid);
          return;
        }
        const timeoutMs = timeoutArg ? Number(timeoutArg) : undefined;
        const intervalMs = intervalArg ? Number(intervalArg) : undefined;

        const res = await tab.waitFor({
          untilJs: untilArg,
          selector: selectorArg,
          text: textArg,
          gone: goneArg,
          stable: stableArg,
          busy: busyArg,
          ...(windowArg ? { windowMs: Number(windowArg) } : {}),
          timeoutMs,
          intervalMs,
        });

        // Trusting stability with no busy indicator is allowed and noted. It is
        // the first thing to re-examine when a false completion appears.
        if (stableArg && (busyArg ?? "").trim().toLowerCase() === "none") {
          const h = (await tab.evaluate("location.host")).value;
          recordIncident({
            at: new Date().toISOString(),
            kind: "no-busy",
            session: sessionName,
            host: typeof h === "string" ? h : "",
            ms: 0,
            detail: stableArg,
          });
        }

        // A wait that burned its whole budget without the condition ever coming
        // true is not a slow page — it is a condition that could not be satisfied.
        // The fingerprint was already in this payload and nobody was reading it,
        // so it now says so out loud and prints the command that would have
        // worked.
        if (!res.ok && untilArg) {
          // The fingerprint, stated rather than inferred: it timed out AND the
          // condition was false at every single poll. A slow page makes the
          // condition true late; a dead condition never makes it true at all.
          const neverTrue = (res as { neverTrue?: boolean }).neverTrue === true;
          const timedOut = /^wait timeout/.test(String(res.error ?? ""));
          if (neverTrue && timedOut) {
            const cur = await tab.evaluate("location.href");
            const host =
              cur.ok && typeof cur.value === "string" ? (normalizeHost(cur.value) ?? "") : "";
            process.stderr.write(blindWaitAdvice(host, sessionName) + "\n");
            (res as Record<string, unknown>).blindWait = true;
            // Write it down. The evidence for the original incident existed on
            // the day it happened and went unread because nothing collected it.
            recordIncident({
              at: new Date().toISOString(),
              kind: "dead-condition",
              session: sessionName,
              host,
              ms: (res as { waitedMs?: number }).waitedMs ?? 0,
              polls: (res as { polls?: number }).polls ?? 0,
              detail: untilArg,
            });
          }
        }

        await respond(res.ok ? 0 : 4, res);
        return;
      }

      if (mappedAction === "list_tabs") {
        let tabs: any[];
        if (chosenVia === "extension") {
          tabs = await ExtensionTransport.listTabs();
        } else {
          tabs = await listPages(profRec.port);
        }
        await respond(0, { ok: true, tabs });
        return;
      }

      if (mappedAction === "close_tab") {
        await tab.close();
        dropSession(sessionName);
        currentTab = null;
        respond(0, { ok: true });
        return;
      }

      finish(2, { ok: false, error: `unknown action: ${action}`, actions: SUPPORTED_CALL_ACTIONS });
      return;
    } catch (err: any) {
      finish(4, { ok: false, error: String(err?.message || err) });
      return;
    }
  }

  printUsageAndExit();
}

void main();
