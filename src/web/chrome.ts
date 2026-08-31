import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { readProfiles, touchProfileRecord } from "./state.js";

export const DEFAULT_PORT = 9333;
export const DEFAULT_HUB_PORT = 9334;
export const DEFAULT_API_PORT = 4771;

export function reservedPorts(env = process.env): number[] {
  const hubPortStr = env.ACP_WEB_HUB_PORT;
  const hubPort = hubPortStr ? Number(hubPortStr) : DEFAULT_HUB_PORT;
  const apiPortStr = env.ACP_API_PORT;
  const apiPort = apiPortStr ? Number(apiPortStr) : DEFAULT_API_PORT;

  const set = new Set<number>();
  if (!isNaN(hubPort) && hubPort > 0) set.add(hubPort);
  if (!isNaN(apiPort) && apiPort > 0) set.add(apiPort);
  return Array.from(set);
}

export async function isPortInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => {
      resolve(true);
    });
    server.once("listening", () => {
      server.close(() => resolve(false));
    });
    try {
      server.listen(port, "127.0.0.1");
    } catch {
      resolve(true);
    }
  });
}

export async function isPortFree(port: number): Promise<boolean> {
  return !(await isPortInUse(port));
}

export function allocateProfilePortSync(
  profileName: string,
  existingProfiles: Record<string, { port: number }>,
  o?: {
    env?: Record<string, string | undefined>;
    isPortFree?: (port: number) => boolean;
  }
): number {
  const env = o?.env ?? process.env;
  const resPorts = new Set(reservedPorts(env));
  const checkFree = o?.isPortFree ?? (() => true);

  const usedByOthers = new Set<number>();
  for (const [name, rec] of Object.entries(existingProfiles)) {
    if (name !== profileName && rec && rec.port && !resPorts.has(rec.port)) {
      usedByOthers.add(rec.port);
    }
  }

  if (profileName === "default") {
    if (!resPorts.has(DEFAULT_PORT) && !usedByOthers.has(DEFAULT_PORT)) {
      if (checkFree(DEFAULT_PORT)) {
        return DEFAULT_PORT;
      }
    }
  } else {
    // DEFAULT_PORT belongs to the "default" profile even when it has not been
    // recorded yet — otherwise the first named profile steals it and "default"
    // silently moves to another port on its next launch.
    usedByOthers.add(DEFAULT_PORT);
  }

  let cand = DEFAULT_PORT;
  while (true) {
    if (!resPorts.has(cand) && !usedByOthers.has(cand)) {
      if (checkFree(cand)) {
        return cand;
      }
    }
    cand++;
  }
}

export async function allocateProfilePort(
  profileName: string,
  existingProfiles: Record<string, { port: number }>,
  o?: {
    env?: Record<string, string | undefined>;
    isPortFree?: (port: number) => Promise<boolean> | boolean;
  }
): Promise<number> {
  const env = o?.env ?? process.env;
  const resPorts = new Set(reservedPorts(env));
  const checkFree = o?.isPortFree ?? isPortFree;

  const usedByOthers = new Set<number>();
  for (const [name, rec] of Object.entries(existingProfiles)) {
    if (name !== profileName && rec && rec.port && !resPorts.has(rec.port)) {
      usedByOthers.add(rec.port);
    }
  }

  if (profileName === "default") {
    if (!resPorts.has(DEFAULT_PORT) && !usedByOthers.has(DEFAULT_PORT)) {
      if (await checkFree(DEFAULT_PORT)) {
        return DEFAULT_PORT;
      }
    }
  } else {
    // See allocateProfilePortSync: DEFAULT_PORT stays with the "default" profile.
    usedByOthers.add(DEFAULT_PORT);
  }

  let cand = DEFAULT_PORT;
  while (true) {
    if (!resPorts.has(cand) && !usedByOthers.has(cand)) {
      if (await checkFree(cand)) {
        return cand;
      }
    }
    cand++;
  }
}

export function profilesRoot(): string {
  return join(homedir(), ".acp", "browser-profiles");
}

export function profileDir(name = "default"): string {
  if (name === "default") {
    const legacyPath = join(homedir(), ".acp", "browser-profile");
    if (existsSync(legacyPath)) {
      return legacyPath;
    }
  }
  return join(profilesRoot(), name);
}

export function listProfiles(): {
  name: string;
  path: string;
  port: number;
  lastUsed?: string;
  reallocatedFrom?: number;
}[] {
  // Ensure default profile record exists
  touchProfileRecord("default", DEFAULT_PORT);

  const recorded = readProfiles();
  const names = new Set(Object.keys(recorded));

  // Check on-disk directories under profilesRoot()
  const root = profilesRoot();
  if (existsSync(root)) {
    try {
      const entries = readdirSync(root, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          names.add(entry.name);
        }
      }
    } catch {}
  }

  const result: {
    name: string;
    path: string;
    port: number;
    lastUsed?: string;
    reallocatedFrom?: number;
  }[] = [];
  for (const name of names) {
    const rec = touchProfileRecord(name);
    result.push({
      name,
      path: profileDir(name),
      port: rec.port,
      lastUsed: rec.lastUsed,
      reallocatedFrom: rec.reallocatedFrom,
    });
  }

  result.sort((a, b) => a.name.localeCompare(b.name));
  return result;
}

export function chromeCandidates(platform: string, env: Record<string, string | undefined>): string[] {
  const candidates: string[] = [];
  if (env.ACP_CHROME_PATH) {
    candidates.push(env.ACP_CHROME_PATH);
  }

  if (platform === "win32") {
    candidates.push(
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
      join(env.LOCALAPPDATA ?? "", "Google", "Chrome", "Application", "chrome.exe")
    );
  } else if (platform === "darwin") {
    candidates.push("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
  } else {
    candidates.push("/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser");
  }

  return candidates;
}

export function resolveChromePath(env = process.env): string | null {
  const candidates = chromeCandidates(process.platform, env);
  for (const cand of candidates) {
    if (existsSync(cand)) {
      return cand;
    }
  }
  return null;
}

export function buildChromeArgs(o: { port: number; profileDir: string; startUrl?: string }): string[] {
  /*
  WHY:
  (1) Chrome 136+ refuses --remote-debugging-port when --user-data-dir points at the user's default profile,
      so WebBridge uses its own persistent profile that the user logs into once;
  (2) we pass no automation flags at all, so navigator.webdriver stays false and the browser is
      fingerprint-identical to an ordinary hand-launched Chrome.
  */
  const args = [
    `--remote-debugging-port=${o.port}`,
    `--user-data-dir=${o.profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
  ];
  if (o.startUrl) {
    args.push(o.startUrl);
  }
  return args;
}

export async function isChromeUp(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(800),
    });
    return res.status === 200;
  } catch {
    return false;
  }
}

export async function ensureChrome(o?: {
  profile?: string;
  port?: number;
  timeoutMs?: number;
  startUrl?: string;
}): Promise<{ launched: boolean; profile: string; port: number; profileDir: string; chromePath: string | null }> {
  const profName = o?.profile ?? "default";
  const rec = touchProfileRecord(profName, o?.port);
  const port = o?.port ?? rec.port;
  const timeoutMs = o?.timeoutMs ?? 20000;
  const dir = profileDir(profName);

  if (await isChromeUp(port)) {
    return {
      launched: false,
      profile: profName,
      port,
      profileDir: dir,
      chromePath: resolveChromePath(),
    };
  }

  const chromePath = resolveChromePath();
  if (!chromePath) {
    throw new Error("chrome not found — set ACP_CHROME_PATH to chrome.exe");
  }

  mkdirSync(dir, { recursive: true });
  const child = spawn(chromePath, buildChromeArgs({ port, profileDir: dir, startUrl: o?.startUrl }), {
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    await new Promise((r) => setTimeout(r, 250));
    if (await isChromeUp(port)) {
      return {
        launched: true,
        profile: profName,
        port,
        profileDir: dir,
        chromePath,
      };
    }
  }

  throw new Error(`chrome did not expose the devtools port ${port} for profile "${profName}" within ${timeoutMs}ms`);
}

/**
 * Is the user's ORDINARY Chrome running (any instance that is not our dedicated
 * WebBridge profile)? Extension mode needs it: the MV3 bridge lives in that
 * browser, so with Chrome closed there is nothing for the hub to talk to.
 */
export async function isDefaultChromeRunning(): Promise<boolean> {
  const { execFile } = await import("node:child_process");
  return await new Promise<boolean>((resolve) => {
    const done = (v: boolean) => resolve(v);
    if (process.platform === "win32") {
      execFile(
        "tasklist",
        ["/FI", "IMAGENAME eq chrome.exe", "/NH"],
        { timeout: 5000, windowsHide: true },
        (err, stdout) => done(!err && /chrome\.exe/i.test(stdout || "")),
      );
    } else {
      execFile("pgrep", ["-f", "chrome"], { timeout: 5000 }, (err, stdout) =>
        done(!err && Boolean((stdout || "").trim())),
      );
    }
  });
}

export function chromeUserDataDir(env = process.env): string | null {
  if (process.platform === "win32") {
    const local = env.LOCALAPPDATA;
    return local ? join(local, "Google", "Chrome", "User Data") : null;
  }
  return null;
}

/**
 * Which Chrome profile directory holds the WebBridge extension?
 *
 * This matters more than it looks: launching chrome.exe with no arguments on a
 * machine with several profiles opens the PROFILE PICKER and waits there — no
 * profile loads, so no extension loads, and the bridge never connects. Observed
 * live with five profiles on this machine. An unpacked extension is recorded by
 * its path inside the profile's (Secure) Preferences, so we can find it.
 *
 * Override with ACP_CHROME_PROFILE_DIRECTORY when auto-detection is not wanted.
 */
export function findExtensionProfileDirectory(env = process.env): string | null {
  const override = env.ACP_CHROME_PROFILE_DIRECTORY;
  if (override) return override;

  const userData = chromeUserDataDir(env);
  if (!userData || !existsSync(userData)) return null;

  const marker = "antigravity-acp";
  let candidates: string[];
  try {
    candidates = readdirSync(userData, { withFileTypes: true })
      .filter((e) => e.isDirectory() && (e.name === "Default" || e.name.startsWith("Profile")))
      .map((e) => e.name);
  } catch {
    return null;
  }

  for (const profile of candidates) {
    for (const file of ["Secure Preferences", "Preferences"]) {
      const p = join(userData, profile, file);
      try {
        if (!existsSync(p)) continue;
        if (readFileSync(p, "utf8").includes(marker)) return profile;
      } catch {
        // unreadable profile file — keep looking
      }
    }
  }
  return null;
}

/**
 * Launch the user's ordinary Chrome when it is closed, so the WebBridge extension
 * can load and reconnect on its own. Never launched when Chrome is already
 * running — a second launch would pop an unwanted window in the user's face.
 */
export async function ensureDefaultChrome(o?: { timeoutMs?: number }): Promise<{
  launched: boolean;
  chromePath: string | null;
  profileDirectory: string | null;
}> {
  const timeoutMs = o?.timeoutMs ?? 15000;
  const profileDirectory = findExtensionProfileDirectory();
  if (await isDefaultChromeRunning()) return { launched: false, chromePath: null, profileDirectory };

  const chromePath = resolveChromePath();
  if (!chromePath) throw new Error("chrome not found — set ACP_CHROME_PATH to chrome.exe");

  // Always name the profile: without it Chrome may sit on the picker forever.
  const args = profileDirectory ? [`--profile-directory=${profileDirectory}`] : [];
  const child = spawn(chromePath, args, { detached: true, stdio: "ignore" });
  child.unref();

  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    await new Promise((r) => setTimeout(r, 500));
    if (await isDefaultChromeRunning()) return { launched: true, chromePath, profileDirectory };
  }
  return { launched: true, chromePath, profileDirectory };
}

/**
 * Un-minimise Chrome without going through the extension.
 *
 * The in-browser path (Page.bringToFront, then chrome.windows.update via the
 * extension) is the clean one, but it dies exactly when it is needed most: a
 * minimised window often coincides with an evicted service worker, so the
 * extension is disconnected and cannot restore anything. This is the OS-level
 * last resort — it only ever restores an already-running Chrome window, never
 * opens or closes anything.
 */
export async function restoreChromeWindowOS(): Promise<boolean> {
  if (process.platform !== "win32") return false;
  const { execFile } = await import("node:child_process");
  const script = [
    "Add-Type -Namespace AcpWin -Name U -MemberDefinition '[DllImport(\"user32.dll\")] public static extern bool ShowWindow(IntPtr h,int c); [DllImport(\"user32.dll\")] public static extern bool SetForegroundWindow(IntPtr h);';",
    "$p = Get-Process chrome -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1;",
    "if ($p) { [AcpWin.U]::ShowWindow($p.MainWindowHandle,9) | Out-Null; [AcpWin.U]::SetForegroundWindow($p.MainWindowHandle) | Out-Null; 'ok' } else { 'none' }",
  ].join(" ");

  return await new Promise<boolean>((resolve) => {
    execFile(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { timeout: 8000, windowsHide: true },
      (err, stdout) => resolve(!err && /ok/.test(stdout || "")),
    );
  });
}

export const FIRST_RUN_NOTICE =
  "Notice: ACP WebBridge launches a dedicated Chrome profile that starts logged out. Please log in manually once to any sites you want the agent to use; your sessions and cookies will persist for future runs.";
