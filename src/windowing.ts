/**
 * windowing.ts — the ONLY module allowed to open a browser tab or spawn a
 * visible console window.
 *
 * Before this module existed, `delegate.ts`, `fanout.ts`, `swarm.ts`, and
 * `monitor.ts` each grew their own copy-pasted `openBrowser()` helper over
 * about a year of incremental features. They drifted out of sync — three of
 * the four defaulted to auto-opening a tab on every run, one didn't — which
 * is exactly the "a new window pops up every time" complaint this file exists
 * to make structurally impossible to reintroduce. Every window/tab-opening
 * call site must import from here; see test/unit/windowing-guard.test.ts,
 * which fails CI if a second independent implementation reappears anywhere.
 */

import { spawn } from "node:child_process";

/** Open `url` in the OS default browser — but only when explicitly requested. */
export function openBrowserTab(url: string, requested: boolean): void {
  if (!requested) return;
  try {
    const [cmd, args] =
      process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : process.platform === "darwin"
          ? ["open", [url]]
          : ["xdg-open", [url]];
    spawn(cmd as string, args as string[], { stdio: "ignore", detached: true }).unref();
  } catch {
    /* best-effort */
  }
}

/**
 * Spawn a real, visible interactive console window (Windows `cmd.exe /k`)
 * running `command`. Only meaningful on win32; no-op elsewhere.
 *
 * NOTE: plain `detached: true` alone sets the `DETACHED_PROCESS` creation flag
 * on Windows, which suppresses console allocation entirely — the process runs
 * with zero visible window. Routing through `cmd /c start "" cmd /k ...`
 * makes `start` explicitly allocate a new console instead — verified
 * empirically (MainWindowHandle went from 0 to non-zero after this fix). The
 * empty `""` title avoids a title/command quoting ambiguity in `start`'s argv
 * parsing (a non-empty title containing spaces was previously misparsed as
 * the target command, producing "Windows cannot find '<title>'").
 */
export function openConsoleWindow(command: string): void {
  if (process.platform !== "win32") return;
  try {
    const proc = spawn("cmd", ["/c", "start", "", "cmd", "/k", command], {
      detached: true,
      stdio: "ignore",
      windowsHide: false,
    });
    proc.on("error", () => {
      /* best-effort — nothing to recover, caller already replied by then */
    });
    proc.unref();
  } catch {
    /* best-effort */
  }
}
