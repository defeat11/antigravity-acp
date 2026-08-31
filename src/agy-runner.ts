/**
 * AgyRunner — spawns and streams the Antigravity CLI (`agy`).
 *
 * This is the "sub-agent": every ACP prompt turn becomes one non-interactive
 * `agy --print` invocation. Its stdout is streamed back to the caller chunk by
 * chunk; its lifecycle is bound to an AbortSignal so the ACP `session/cancel`
 * notification can kill it (and its whole process tree on Windows).
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppConfig, PermissionMode } from "./config.js";
import type { Logger } from "./logger.js";
import { resolveExecutable } from "./bin-resolver.js";
import { registerAgent, deregisterAgent, appendUsage } from "./registry.js";
import type { EngineAdapter } from "./engine.js";

export interface AgyRunOptions {
  readonly prompt: string;
  readonly cwd: string;
  readonly additionalDirectories: readonly string[];
  /** Resume a specific agy conversation by id; null/absent starts a new one. */
  readonly conversationId?: string | null;
  readonly signal: AbortSignal;
  /** Called with decoded UTF-8 text as it streams from agy stdout. */
  readonly onStdout: (text: string) => void;
  /** Called with decoded UTF-8 text from agy stderr (progress/diagnostics). */
  readonly onStderr?: (text: string) => void;
  /**
   * Fired once, as soon as the conversation id appears in the run log (while agy
   * is still running). Enables live streaming of the conversation store.
   */
  readonly onConversationId?: (conversationId: string, appDataDir: string | null) => void;
}

export interface AgyRunResult {
  readonly exitCode: number | null;
  readonly termSignal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly aborted: boolean;
  /** agy conversation id parsed from the run log, if found. */
  readonly conversationId: string | null;
  /** agy CLI app-data directory parsed from the run log, if found. */
  readonly appDataDir: string | null;
  /** True if agy reported the requested --model as unrecognized (fell back). */
  readonly modelFallback: boolean;
  /** True if the run failed because agy is not authenticated. */
  readonly notLoggedIn: boolean;
}

export class AgyNotFoundError extends Error {
  constructor(bin: string) {
    super(
      `Could not find the Antigravity CLI executable "${bin}" on PATH. ` +
        `Install it (https://antigravity.google) or set ACP_AGY_BIN to its full path. ` +
        `For a no-CLI test run, set ACP_AGY_DRY_RUN=1.`,
    );
    this.name = "AgyNotFoundError";
  }
}

export class AgyRunner implements EngineAdapter {
  private resolvedBin: string | null = null;

  constructor(
    private readonly config: AppConfig,
    private readonly log: Logger,
  ) {
    this.sweepStaleLogs();
  }

  /** Best-effort cleanup of run logs orphaned by a previous crash. */
  private sweepStaleLogs(): void {
    const cutoff = Date.now() - 60 * 60 * 1000; // 1 hour
    try {
      const dir = tmpdir();
      for (const name of readdirSync(dir)) {
        if (!/^agy-acp-.*\.log$/.test(name)) continue;
        const full = join(dir, name);
        try {
          if (statSync(full).mtimeMs < cutoff) rmSync(full, { force: true });
        } catch {
          /* file vanished or in use — ignore */
        }
      }
    } catch {
      /* tmpdir unreadable — ignore */
    }
  }

  /**
   * Windows caps a whole command line at 32,767 chars. The prompt used to ride
   * there as `--print=<prompt>`, so a large prompt failed the spawn outright
   * with ENAMETOOLONG and killed the session. agy also accepts the prompt on
   * stdin (`--input-format stream-json`), which has no such limit — measured:
   * 120,059 chars answered fine, 3.7x the command-line ceiling.
   *
   * Prompts under this size keep the proven `--print=` path untouched; only
   * the ones that would risk the ceiling switch to stdin. One code path stays
   * hot and unchanged, and the other only runs where the old one could not.
   *
   * Two guards make the stdin path safe against the replay that broke it once
   * (a resumed session returned the whole conversation as one 280,901-char
   * "response" and wedged the agent): this path never passes --conversation,
   * and the answer is taken from the per-turn deltas after the last user_input
   * step rather than from result.response.
   */
  private static readonly STDIN_PROMPT_THRESHOLD = Number(
    process.env.ACP_STDIN_PROMPT_THRESHOLD ?? 20_000,
  );

  private useStdinPrompt(prompt: string): boolean {
    return prompt.length > AgyRunner.STDIN_PROMPT_THRESHOLD;
  }

  /** Build the agy argument vector for a run. Pure + unit-testable. */
  buildArgs(opts: AgyRunOptions, logFile?: string): string[] {
    const args: string[] = [];

    // Only pass --model when set; an empty model lets agy use its configured
    // default (Gemini Flash, Medium tier) and avoids "not recognized" noise.
    if (this.config.model) args.push("--model", this.config.model);

    pushPermissionFlags(args, this.config.permissionMode);

    // A known id resumes that exact conversation (full server-side memory);
    // otherwise agy starts a fresh conversation whose id we capture from the log.
    //
    // Without an explicit project flag, agy does NOT simply operate in `cwd`:
    // it resolves its own "active project" (by git-repo identity, not the raw
    // path), so a brand-new directory that shares a repo with an
    // already-known project (e.g. a git worktree under that project) silently
    // resolves back to the KNOWN project's root instead — and a directory it
    // has never seen at all falls back to its internal scratch folder.
    // Verified by reproduction: without --new-project, a fresh unrelated
    // directory got a file written to ~/.gemini/antigravity-cli/scratch
    // instead of cwd; with --new-project, it wrote to cwd correctly. So a
    // fresh (non-resumed) run must force agy to treat `cwd` itself as the
    // project; a resumed conversation already carries its own project.
    // A resumed conversation replays its whole history in stream-json mode
    // (measured: a 280,901-char "response" that wedged the session), and the
    // caller already carries the full history inside the prompt text. So the
    // stdin path never resumes — it always starts a fresh agy conversation.
    if (opts.conversationId && !this.useStdinPrompt(opts.prompt)) {
      args.push("--conversation", opts.conversationId);
    } else {
      args.push("--new-project");
    }

    for (const dir of opts.additionalDirectories) {
      args.push("--add-dir", dir);
    }

    args.push("--print-timeout", this.config.printTimeout);
    if (logFile) args.push("--log-file", logFile);
    args.push(...this.config.extraArgs);

    // Prompt last, via the `--flag=value` form so a prompt starting with "-"
    // is never mistaken for another flag by Go's flag parser.
    // Oversized prompts go on stdin instead (see STDIN_PROMPT_THRESHOLD); agy
    // requires stream-json on BOTH ends for that mode, and `--print=` must keep
    // its empty attached value or it swallows the next flag as the prompt.
    if (this.useStdinPrompt(opts.prompt)) {
      args.push("--input-format", "stream-json");
      args.push("--output-format", "stream-json");
      args.push("--print=");
    } else {
      args.push(`--print=${opts.prompt}`);
    }
    return args;
  }

  /** One NDJSON line carrying the prompt, in the shape agy's stream reader wants. */
  private static stdinPayload(prompt: string): string {
    return (
      JSON.stringify({
        event: "user",
        message: { role: "user", content: [{ type: "text", text: prompt }] },
      }) + "\n"
    );
  }

  async run(opts: AgyRunOptions): Promise<AgyRunResult> {
    if (this.config.dryRun) {
      return this.runDry(opts);
    }

    const bin = (this.resolvedBin ??= resolveExecutable(this.config.agyBin));
    if (!bin) throw new AgyNotFoundError(this.config.agyBin);

    const logFile = join(tmpdir(), `agy-acp-${randomUUID()}.log`);
    const args = this.buildArgs(opts, logFile);
    this.log.debug("spawning agy", {
      bin,
      cwd: opts.cwd,
      argsPreview: redactPrompt(args),
    });

    // Per-account isolation: point agy at this account's home (its own ~/.gemini)
    // and/or supply its API key, so accounts never share creds or conversations.
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (this.config.accountHome) {
      const appData = join(this.config.accountHome, "AppData", "Roaming");
      const localAppData = join(this.config.accountHome, "AppData", "Local");
      mkdirSync(appData, { recursive: true });
      mkdirSync(localAppData, { recursive: true });
      env.USERPROFILE = this.config.accountHome;
      env.HOME = this.config.accountHome;
      env.APPDATA = appData;
      env.LOCALAPPDATA = localAppData;
    }
    if (this.config.apiKey) env.ANTIGRAVITY_API_KEY = this.config.apiKey;

    const viaStdin = this.useStdinPrompt(opts.prompt);

    return new Promise<AgyRunResult>((resolve, reject) => {
      const child = spawn(bin, args, {
        cwd: opts.cwd,
        env,
        windowsHide: true,
        stdio: [viaStdin ? "pipe" : "ignore", "pipe", "pipe"],
      });

      if (viaStdin && child.stdin) {
        child.stdin.setDefaultEncoding("utf8");
        child.stdin.on("error", () => {
          /* agy may exit before we finish writing; the close handler reports it */
        });
        child.stdin.end(AgyRunner.stdinPayload(opts.prompt));
      }

      let stdout = "";
      let stderr = "";
      let aborted = false;
      let settled = false;
      // stream-json bookkeeping (only used when viaStdin)
      let ndjsonBuffer = "";
      let streamedText = "";
      let finalResponse: string | null = null;
      let streamError: string | null = null;

      // Register this agent in the live monitor registry; deregister + log on end.
      const startedAt = new Date().toISOString();
      const startMs = Date.now();
      const acctName = this.config.accountName ?? "default";
      const runLabel = this.config.runLabel ?? "agy";
      if (child.pid !== undefined) {
        registerAgent({ pid: child.pid, account: acctName, project: opts.cwd, command: runLabel, startedAt, viewerUrl: this.config.viewerUrl });
      }
      const finishRegistry = (ok: boolean) => {
        if (child.pid !== undefined) deregisterAgent(child.pid);
        appendUsage({
          account: acctName,
          project: opts.cwd,
          command: runLabel,
          durationSec: Number(((Date.now() - startMs) / 1000).toFixed(1)),
          ok,
        });
      };

      // Surface the conversation id early so the agent can stream the store live.
      const stopWatch = opts.onConversationId
        ? this.watchLogForConversationId(logFile, opts.onConversationId)
        : () => {};

      const onAbort = () => {
        aborted = true;
        this.killTree(child.pid, opts.cwd);
      };
      if (opts.signal.aborted) {
        onAbort();
      } else {
        opts.signal.addEventListener("abort", onAbort, { once: true });
      }

      // stdio[1] and stdio[2] are always "pipe", so both streams exist; the
      // dynamic stdin entry is what stops TS from narrowing them on its own.
      const childOut = child.stdout!;
      const childErr = child.stderr!;
      childOut.setEncoding("utf8");
      childErr.setEncoding("utf8");

      childOut.on("data", (chunk: string) => {
        if (!viaStdin) {
          stdout += chunk;
          opts.onStdout(chunk);
          return;
        }
        // stream-json: one JSON object per line. Forward only assistant text so
        // the caller still sees a live stream, and keep the final response text.
        ndjsonBuffer += chunk;
        let nl: number;
        while ((nl = ndjsonBuffer.indexOf("\n")) >= 0) {
          const line = ndjsonBuffer.slice(0, nl).trim();
          ndjsonBuffer = ndjsonBuffer.slice(nl + 1);
          if (!line) continue;
          let evt: any;
          try {
            evt = JSON.parse(line);
          } catch {
            continue; // a partial or non-JSON line is not fatal
          }
          const step = evt?.step_update;
          // Each turn opens with a `user_input` step. Resetting on it keeps only
          // the assistant text that belongs to the LAST prompt, so any replayed
          // history in the stream cannot leak into this turn's answer.
          if (step?.step_type === "user_input") {
            streamedText = "";
          }
          const delta = step?.text_delta;
          if (typeof delta === "string" && delta && step?.step_type === "agent_response") {
            streamedText += delta;
          }
          if (evt?.event === "result") {
            const r = evt.result ?? {};
            if (typeof r.response === "string") finalResponse = r.response;
            if (r.status && r.status !== "SUCCESS" && r.error) streamError = String(r.error);
          }
        }
      });
      childErr.on("data", (chunk: string) => {
        stderr += chunk;
        opts.onStderr?.(chunk);
      });

      child.on("error", (err) => {
        if (settled) return;
        settled = true;
        stopWatch();
        finishRegistry(false);
        opts.signal.removeEventListener("abort", onAbort);
        this.consumeLog(logFile); // best-effort cleanup
        reject(err);
      });

      child.on("close", (code, signalName) => {
        if (settled) return;
        settled = true;
        stopWatch();
        finishRegistry(code === 0 && !aborted);
        opts.signal.removeEventListener("abort", onAbort);
        const { conversationId, appDataDir, modelFallback, notLoggedIn } = this.consumeLog(logFile);
        if (viaStdin) {
          // Hand the caller plain text, exactly as the `--print=` path does, so
          // nothing downstream needs to know which transport carried the prompt.
          // The per-turn deltas win over result.response: the latter has been
          // observed carrying the entire conversation on a resumed session.
          stdout = streamedText || finalResponse || "";
          if (stdout) opts.onStdout(stdout);
          if (streamError) stderr += (stderr ? "\n" : "") + streamError;
        }
        resolve({
          exitCode: code,
          termSignal: signalName,
          stdout,
          stderr,
          aborted,
          conversationId,
          appDataDir,
          modelFallback,
          notLoggedIn,
        });
      });
    });
  }

  /** Read the run log to recover the conversation id + app-data dir, then delete it. */
  private consumeLog(logFile: string): {
    conversationId: string | null;
    appDataDir: string | null;
    modelFallback: boolean;
    notLoggedIn: boolean;
  } {
    let parsed = {
      conversationId: null as string | null,
      appDataDir: null as string | null,
      modelFallback: false,
      notLoggedIn: false,
    };
    try {
      parsed = parseLog(readFileSync(logFile, "utf8"));
    } catch {
      /* log may not exist (e.g. agy failed before writing) */
    }
    try {
      rmSync(logFile, { force: true });
    } catch {
      /* ignore */
    }
    return parsed;
  }

  /**
   * Poll the run log while agy is still running and fire `onConversationId`
   * once the id appears (within a few seconds of start). Returns a stop fn.
   */
  private watchLogForConversationId(
    logFile: string,
    onFound: (id: string, appDataDir: string | null) => void,
  ): () => void {
    let done = false;
    const timer = setInterval(() => {
      if (done) return;
      try {
        const parsed = parseLog(readFileSync(logFile, "utf8"));
        if (parsed.conversationId) {
          done = true;
          clearInterval(timer);
          onFound(parsed.conversationId, parsed.appDataDir);
        }
      } catch {
        /* log not written yet */
      }
    }, 400);
    timer.unref();
    return () => {
      done = true;
      clearInterval(timer);
    };
  }

  /** Kill the child and its descendants. agy may spawn tool subprocesses. */
  private killTree(pid: number | undefined, cwd: string): void {
    if (pid === undefined) return;
    try {
      if (process.platform === "win32") {
        // SIGTERM is unreliable for Windows console trees; use taskkill /T.
        spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
          windowsHide: true,
          stdio: "ignore",
          cwd,
        });
      } else {
        process.kill(pid, "SIGTERM");
        // Escalate if it lingers.
        setTimeout(() => {
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            /* already gone */
          }
        }, 2000).unref();
      }
    } catch (err) {
      this.log.warn("failed to kill agy process", { pid, err: String(err) });
    }
  }

  /** Simulate an agy run without spawning anything. Used for tests/CI. */
  private async runDry(opts: AgyRunOptions): Promise<AgyRunResult> {
    const lines = [
      `[dry-run] Antigravity (${this.config.model}) received your prompt.`,
      `[dry-run] cwd: ${opts.cwd}`,
      `[dry-run] prompt: ${opts.prompt.slice(0, 200)}`,
      `[dry-run] No files were changed (ACP_AGY_DRY_RUN=1).`,
    ];
    let stdout = "";
    for (const line of lines) {
      if (opts.signal.aborted) {
        return {
          exitCode: null,
          termSignal: null,
          stdout,
          stderr: "",
          aborted: true,
          conversationId: null,
          appDataDir: null,
          modelFallback: false,
          notLoggedIn: false,
        };
      }
      const text = line + "\n";
      stdout += text;
      opts.onStdout(text);
      await delay(40, opts.signal);
    }
    return {
      exitCode: 0,
      termSignal: null,
      stdout,
      stderr: "",
      aborted: false,
      conversationId: null,
      appDataDir: null,
      modelFallback: false,
      notLoggedIn: false,
    };
  }
}

/** Parse a run-log's text for the conversation id, app-data dir, and run health. */
function parseLog(text: string): {
  conversationId: string | null;
  appDataDir: string | null;
  modelFallback: boolean;
  notLoggedIn: boolean;
} {
  let conversationId: string | null = null;
  let appDataDir: string | null = null;
  // Match ONLY the authoritative "Print mode: conversation=<uuid>, sending
  // message" line. agy may also create an abandoned conversation during its
  // silent-auth restart, but that one is only ever logged as "conversation
  // <uuid>" (space) — never with "=", so requiring "=" selects the real one.
  const convMatches = [
    ...text.matchAll(
      /conversation=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi,
    ),
  ];
  const last = convMatches[convMatches.length - 1];
  if (last) conversationId = last[1] ?? null;
  // "CLI app data directory: <path>"
  const dirMatch = text.match(/CLI app data directory:\s*(.+?)\s*$/m);
  if (dirMatch?.[1]) appDataDir = dirMatch[1].trim();
  const modelFallback = /is not recognized as a known model/i.test(text);
  // "not logged into Antigravity" appears transiently before silent keyring/
  // OAuth auth succeeds, so only treat it as a real failure when no successful
  // authentication is ever logged.
  const authenticated = /authenticated successfully|authenticated via keyring|OAuth: authenticated/i.test(text);
  const notLoggedIn = /not logged into Antigravity/i.test(text) && !authenticated;
  return { conversationId, appDataDir, modelFallback, notLoggedIn };
}

function pushPermissionFlags(args: string[], mode: PermissionMode): void {
  switch (mode) {
    case "auto":
      // Non-interactive print mode cannot prompt; auto-approve so it can work.
      args.push("--dangerously-skip-permissions");
      break;
    case "sandbox":
      // Restrict the terminal, but still skip prompts (no TTY to prompt on).
      args.push("--sandbox", "--dangerously-skip-permissions");
      break;
    case "default":
      // Neither flag: agy may refuse or wait for permission until --print-timeout.
      break;
  }
}

/** Replace the long prompt arg with a short placeholder for log output. */
function redactPrompt(args: string[]): string[] {
  return args.map((a) =>
    a.startsWith("--print=") ? `--print=<${a.length - 8} chars>` : a,
  );
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(t);
      resolve();
    }, { once: true });
  });
}
