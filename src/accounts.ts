/**
 * Multi-account support — the user owns several paid Antigravity accounts and
 * wants work to continue on the next one when the current account's quota runs
 * out, with full isolation (each account gets its own USERPROFILE/HOME, hence
 * its own `~/.gemini` creds + conversation store). Conversations can't be
 * resumed across accounts, so sessions are namespaced per account elsewhere.
 *
 * Config:  ~/.acp/accounts.json   (ordered profiles = failover priority)
 * State:   ~/.acp/account-state.json   (exhausted-until timestamps)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { countRecentRunsByAccount } from "./ledger.js";

export interface Account {
  name: string;
  email?: string;
  /** Isolated USERPROFILE/HOME dir holding this account's `.gemini`. */
  home: string;
  /** Optional ANTIGRAVITY_API_KEY for clean, keyring-free auth. */
  apiKey?: string;
}

interface AccountsConfig {
  accounts: Account[];
  active?: string;
}

type AccountState = Record<string, { exhaustedUntil?: string }>;

const DIR = join(homedir(), ".acp");
const CONFIG = join(DIR, "accounts.json");
const STATE = join(DIR, "account-state.json");

export const DEFAULT_COOLDOWN_MS = 5 * 60 * 60 * 1000; // 5h

export function defaultHome(name: string): string {
  return join(DIR, "accounts", name);
}

function readJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(DIR, { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2), "utf8");
}

export function loadAccounts(): AccountsConfig {
  const cfg = readJson<AccountsConfig>(CONFIG, { accounts: [] });
  if (!Array.isArray(cfg.accounts)) cfg.accounts = [];
  return cfg;
}

export function saveAccounts(cfg: AccountsConfig): void {
  writeJson(CONFIG, cfg);
}

/** Register a profile (idempotent); creates its isolated home directory.
 *  `explicitHome` lets you point at an existing profile (e.g. the current
 *  ~/.gemini account by passing its real USERPROFILE) so no re-login is needed. */
export function addAccount(name: string, email?: string, apiKey?: string, explicitHome?: string): Account {
  const cfg = loadAccounts();
  let acct = cfg.accounts.find((a) => a.name === name);
  const home = explicitHome ?? acct?.home ?? defaultHome(name);
  mkdirSync(home, { recursive: true });
  if (acct) {
    if (email) acct.email = email;
    if (apiKey) acct.apiKey = apiKey;
  } else {
    acct = { name, email, home, apiKey };
    cfg.accounts.push(acct);
  }
  if (!cfg.active) cfg.active = name;
  saveAccounts(cfg);
  return acct;
}

export function setActive(name: string): boolean {
  const cfg = loadAccounts();
  if (!cfg.accounts.some((a) => a.name === name)) return false;
  cfg.active = name;
  saveAccounts(cfg);
  return true;
}

// ---- exhaustion state ----------------------------------------------------

function loadState(): AccountState {
  return readJson<AccountState>(STATE, {});
}

export function markExhausted(name: string, cooldownMs = DEFAULT_COOLDOWN_MS): void {
  const st = loadState();
  st[name] = { exhaustedUntil: new Date(Date.now() + cooldownMs).toISOString() };
  writeJson(STATE, st);
}

export function clearExhausted(name: string): void {
  const st = loadState();
  delete st[name];
  writeJson(STATE, st);
}

export function isExhausted(name: string): boolean {
  const until = loadState()[name]?.exhaustedUntil;
  return until ? Date.parse(until) > Date.now() : false;
}

/** The cooldown end timestamp if currently exhausted, else null. */
export function exhaustedUntil(name: string): string | null {
  const until = loadState()[name]?.exhaustedUntil;
  return until && Date.parse(until) > Date.now() ? until : null;
}

// ---- selection -----------------------------------------------------------

/**
 * Resolve which account to use: an explicit override wins, else the configured
 * active account, else the first non-exhausted profile. Returns null when no
 * profiles are configured (caller falls back to the default ~/.gemini account).
 */
export function resolveActive(override?: string): Account | null {
  const cfg = loadAccounts();
  if (cfg.accounts.length === 0) return null;

  if (override) {
    const a = cfg.accounts.find((x) => x.name === override);
    if (a) return a;
  }
  const active = cfg.active && cfg.accounts.find((x) => x.name === cfg.active);
  if (active && !isExhausted(active.name)) return active;

  return cfg.accounts.find((a) => !isExhausted(a.name)) ?? cfg.accounts[0] ?? null;
}

/** Next non-exhausted account after `afterName` (failover order); null if none. */
export function nextAccount(afterName: string): Account | null {
  const cfg = loadAccounts();
  const idx = cfg.accounts.findIndex((a) => a.name === afterName);
  const ordered = idx >= 0 ? [...cfg.accounts.slice(idx + 1), ...cfg.accounts.slice(0, idx)] : cfg.accounts;
  return ordered.find((a) => !isExhausted(a.name)) ?? null;
}

/** Default quota-exhaustion signature (configurable via ACP_AGY_QUOTA_REGEX). */
export function quotaRegex(): RegExp {
  const raw = process.env.ACP_AGY_QUOTA_REGEX?.trim();
  if (raw) {
    try {
      return new RegExp(raw, "i");
    } catch {
      /* fall through to default */
    }
  }
  return /quota|resource[_ ]?exhausted|rate.?limit|out of (credit|quota)|insufficient|\b429\b|exceeded your/i;
}

export function resolveActiveBalanced(override?: string): Account | null {
  try {
    if (override) {
      return resolveActive(override);
    }
    if (process.env.ACP_AGY_AUTO_BALANCE !== "1") {
      return resolveActive(override);
    }

    const cfg = loadAccounts();
    if (cfg.accounts.length === 0) {
      return null;
    }

    const nonExhausted = cfg.accounts.filter((a) => !isExhausted(a.name));
    if (nonExhausted.length === 0) {
      return resolveActive(override);
    }
    if (nonExhausted.length === 1) {
      return nonExhausted[0]!;
    }

    const counts = countRecentRunsByAccount(Date.now() - 24 * 60 * 60 * 1000);
    const chosen = nonExhausted.reduce((minAcct, currentAcct) => {
      const minVal = counts[minAcct.name] ?? 0;
      const currentVal = counts[currentAcct.name] ?? 0;
      return currentVal < minVal ? currentAcct : minAcct;
    });

    return chosen;
  } catch {
    return resolveActive(override);
  }
}
