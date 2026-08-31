/**
 * Runtime configuration for the Antigravity ACP adapter.
 *
 * Everything is driven by environment variables so the same binary can be
 * registered in any ACP client (Zed, JetBrains, neovim, ...) and tuned without
 * a rebuild. All values have safe defaults; nothing here is required for a
 * first run except a working `agy` install (or ACP_AGY_DRY_RUN=1 for testing).
 */

export type PermissionMode = "auto" | "sandbox" | "default";
export type PersistMode = "continue" | "transcript" | "off";
export type ConsentMode = "off" | "session" | "always";
export type LogLevel = "debug" | "info" | "warn" | "error";

export interface AppConfig {
  /** Path or bare name of the Antigravity CLI binary. */
  readonly agyBin: string;
  /** Model id passed to `agy --model`. */
  readonly model: string;
  /** How agy's tool-permission gate is handled in non-interactive print mode. */
  readonly permissionMode: PermissionMode;
  /** Value for `agy --print-timeout` (Go duration, e.g. "10m"). */
  readonly printTimeout: string;
  /** How conversation continuity across prompts in one session is preserved. */
  readonly persist: PersistMode;
  /** Whether to ask the ACP client for consent before running agy. */
  readonly consent: ConsentMode;
  /** Extra raw args appended to every agy invocation. */
  readonly extraArgs: readonly string[];
  /** Max characters of prior-turn transcript injected when persist=transcript. */
  readonly maxContextChars: number;
  /** Max number of agy processes allowed to run concurrently (across sessions). */
  readonly maxConcurrent: number;
  /** Override for agy's conversations directory (where per-conversation .db files live). */
  readonly convDir: string | undefined;
  /** When true, agy is never spawned; a canned response is streamed instead. */
  readonly dryRun: boolean;
  readonly logLevel: LogLevel;
  /** Isolated USERPROFILE/HOME for the chosen account (set by the CLI per run). */
  readonly accountHome?: string;
  /** ANTIGRAVITY_API_KEY for the chosen account (set by the CLI per run). */
  readonly apiKey?: string;
  /** Account name + run label for the monitor registry/usage log. */
  readonly accountName?: string;
  readonly runLabel?: string;
  readonly viewerUrl?: string;
}

// Gemini 3.6 Flash, High tier. Note: some agy installs only recognize the
// `-low` id and silently fall back to the Medium default for other tiers; the
// adapter logs a one-time warning when that fallback happens.
const DEFAULT_MODEL = "gemini-3.6-flash-high";

function pickEnum<T extends string>(
  raw: string | undefined,
  allowed: readonly T[],
  fallback: T,
): T {
  if (raw === undefined) return fallback;
  const v = raw.trim().toLowerCase();
  return (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}

function pickBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) return fallback;
  const v = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  return fallback;
}

function pickInt(raw: string | undefined, fallback: number, min: number): number {
  if (raw === undefined) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= min ? n : fallback;
}

/**
 * Split a raw string into argv tokens, honoring simple single/double quoting.
 * Used for ACP_AGY_EXTRA_ARGS. Intentionally minimal — advanced users only.
 */
function tokenizeArgs(raw: string | undefined): string[] {
  if (!raw) return [];
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    out.push(m[1] ?? m[2] ?? m[3] ?? "");
  }
  return out;
}

// Flags the adapter sets itself; if a user puts these in ACP_AGY_EXTRA_ARGS they
// may override or conflict with managed behavior, so we surface a warning.
const RESERVED_AGY_FLAGS = [
  "--print", "--prompt", "-p", "--conversation", "--continue", "-c", "--model",
  "--dangerously-skip-permissions", "--sandbox", "--log-file", "--print-timeout",
  "--prompt-interactive", "-i",
];

/** Returns any reserved/managed flags present in the extra-args list. */
export function findReservedExtraArgs(extraArgs: readonly string[]): string[] {
  const hits = new Set<string>();
  for (const arg of extraArgs) {
    const name = arg.split("=", 1)[0]!;
    if (RESERVED_AGY_FLAGS.includes(name)) hits.add(name);
  }
  return [...hits];
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return Object.freeze({
    agyBin: env.ACP_AGY_BIN?.trim() || "agy",
    // Unset -> default High id. Explicitly empty ("") -> no --model flag
    // (use agy's own default cleanly), as documented in .env.example.
    model: env.ACP_AGY_MODEL === undefined ? DEFAULT_MODEL : env.ACP_AGY_MODEL.trim(),
    permissionMode: pickEnum<PermissionMode>(
      env.ACP_AGY_PERMISSION_MODE,
      ["auto", "sandbox", "default"],
      "auto",
    ),
    printTimeout: env.ACP_AGY_PRINT_TIMEOUT?.trim() || "10m",
    persist: pickEnum<PersistMode>(
      env.ACP_AGY_PERSIST,
      ["continue", "transcript", "off"],
      "continue",
    ),
    consent: pickEnum<ConsentMode>(
      env.ACP_AGY_CONSENT,
      ["off", "session", "always"],
      "off",
    ),
    extraArgs: Object.freeze(tokenizeArgs(env.ACP_AGY_EXTRA_ARGS)),
    maxContextChars: pickInt(env.ACP_MAX_CONTEXT_CHARS, 24000, 1000),
    maxConcurrent: pickInt(env.ACP_AGY_MAX_CONCURRENT, 3, 1),
    convDir: env.ACP_AGY_CONV_DIR?.trim() || undefined,
    dryRun: pickBool(env.ACP_AGY_DRY_RUN, false),
    logLevel: pickEnum<LogLevel>(
      env.ACP_LOG_LEVEL,
      ["debug", "info", "warn", "error"],
      "info",
    ),
  });
}
