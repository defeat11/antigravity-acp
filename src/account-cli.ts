#!/usr/bin/env node
/**
 * `acp account` — manage the isolated Antigravity accounts used for failover.
 *
 *   acp account add <name> [email]   register a profile (creates its isolated home)
 *   acp account login <name>         sign that account in (interactive, into its home)
 *   acp account use <name>           set the preferred active account
 *   acp account list | status        show profiles, active, and exhaustion state
 *
 * Each account lives in its own home dir so its `~/.gemini` (OAuth creds +
 * conversation store) is fully isolated from the others.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { loadConfig } from "./config.js";
import { resolveExecutable } from "./bin-resolver.js";
import { addAccount, isExhausted, loadAccounts, setActive } from "./accounts.js";

function usage(): never {
  process.stderr.write(
    "usage:\n" +
      "  acp account add <name> [email]\n" +
      "  acp account login <name>\n" +
      "  acp account use <name>\n" +
      "  acp account list | status\n",
  );
  process.exit(2);
}

function printStatus(): void {
  const cfg = loadAccounts();
  if (cfg.accounts.length === 0) {
    process.stdout.write("no accounts configured. add one:  acp account add <name> [email]\n");
    return;
  }
  process.stdout.write("accounts (failover order):\n");
  for (const a of cfg.accounts) {
    const flags = [
      cfg.active === a.name ? "active" : "",
      isExhausted(a.name) ? "exhausted(cooldown)" : "ready",
      a.apiKey ? "api-key" : "oauth",
    ]
      .filter(Boolean)
      .join(", ");
    process.stdout.write(`  - ${a.name}${a.email ? ` <${a.email}>` : ""} · ${flags}\n    home: ${a.home}\n`);
  }
}

function main(): void {
  const [sub, name, extra, home] = process.argv.slice(2);

  switch (sub) {
    case "add": {
      if (!name) usage();
      // acp account add <name> [email] [home]   (home = existing profile, skips login)
      const a = addAccount(name, extra, undefined, home);
      const next = home ? "(uses existing home — no login needed)" : `next: acp account login ${a.name}`;
      process.stdout.write(`✓ account "${a.name}" registered. home: ${a.home}\n   ${next}\n`);
      return;
    }
    case "use": {
      if (!name) usage();
      process.stdout.write(setActive(name) ? `✓ active account: ${name}\n` : `unknown account: ${name}\n`);
      if (!setActive(name)) process.exit(1);
      return;
    }
    case "list":
    case "status":
    case undefined:
      printStatus();
      return;
    case "login": {
      if (!name) usage();
      const acct = addAccount(name); // ensure it exists + has a home
      const bin = resolveExecutable(loadConfig().agyBin);
      if (!bin) {
        process.stderr.write("agy not found (set ACP_AGY_BIN).\n");
        process.exit(2);
      }
      process.stdout.write(`launching agy to sign in "${name}" into its isolated home…\n`);
      process.stdout.write("→ choose log-in and complete it in the browser with THIS account, then exit agy.\n\n");
      // Interactive: agy uses USERPROFILE/HOME to locate (and write) this account's .gemini.
      const appData = join(acct.home, "AppData", "Roaming");
      const localAppData = join(acct.home, "AppData", "Local");
      mkdirSync(appData, { recursive: true });
      mkdirSync(localAppData, { recursive: true });
      const r = spawnSync(bin, [], {
        stdio: "inherit",
        env: {
          ...process.env,
          USERPROFILE: acct.home,
          HOME: acct.home,
          APPDATA: appData,
          LOCALAPPDATA: localAppData,
        },
      });
      process.stdout.write(
        `\ndone. verify with:  ACP_AGY_ACCOUNT=${name} acp "say hi which account are you" --ephemeral\n`,
      );
      process.exit(r.status ?? 0);
    }
    default:
      usage();
  }
}

main();
