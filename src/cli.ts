#!/usr/bin/env node
/**
 * acp — unified global CLI for the Antigravity sub-agent toolkit.
 *
 * After `npm link` (or a global install) this runs from any directory:
 *   acp init [dir]                 prepare a project (.acp-sessions + launcher)
 *   acp "<task>" [--session name]  delegate one task (live viewer + summary)
 *   acp fanout [opts] --task ...   run several sub-agents in parallel
 *   acp capacity [--stress N]      measure how many sub-agents this machine runs
 *   acp sessions                   list saved sessions in the current project
 *
 * It simply dispatches to the matching dist/*.js entry, inheriting the current
 * directory (so the project is wherever you run it).
 */

import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DIST = dirname(fileURLToPath(import.meta.url)); // <ACP_HOME>/dist
const argv = process.argv.slice(2);
const sub = argv[0];

const HELP = `acp — Antigravity sub-agent CLI

  acp init [dir]                    prepare a project (.acp-sessions + acp launcher)
  acp "<task>" [flags]              delegate one task — live viewer + compact summary
       flags: --session <name> · --verify "<cmd>" · --read-only · --model <id> · --json --ephemeral
  acp fanout [opts] --task A --task B   run several sub-agents in parallel (--worktree, --concurrency N)
  acp swarm "<goal>" [--verify "<cmd>"]  split ONE goal across many agents (sized to machine), then verify
  acp pro "<task>" [--verify "<cmd>"] [--session name] [--model id] [--max-critic-rounds N] [--json]   architect -> build -> independent critic -> verify, with one escalation fix pass
  acp capacity [--stress N]         measure how many sub-agents this machine can run
  acp sessions                      list saved sessions for the current project
  acp feedback [up|down|1-5] [note] rate the agent (or show the report) — helps improve it
  acp stats                         show ledger summary (success rate, last 20 runs, slowest 3)
  acp rollback [id|last]            undo the last (or a specific) acp checkpoint commit via git revert
  acp account <add|login|use|status> manage isolated accounts (failover when one runs out)
  acp api <start|token|allow|list>  local HTTP API for other agents (e.g. Hermes) — token-authed, project allowlist
  acp web <open|status|allow|call>  drive a real Chrome (dedicated profile) — the sub-agent's browser
  acp qwen "<question>" --session <name> --json   consult Qwen (backed by local SQLite archive)
  acp advise "<goal>" [--rounds N]  Qwen advises, agy coordinates and executes
  acp monitor                       live dashboard: accounts, running/idle agents, usage
  acp refresh                       rebuild the toolkit after code changes (no relink needed)
  acp --help

The agent writes the code (Gemini 3.6 Flash); you watch live in the browser.`;

if (sub === "refresh" || sub === "rebuild") {
  // Rebuild the toolkit in place; the link points at dist/, so the next `acp`
  // invocation immediately uses the fresh build (no relink, no restart).
  const home = dirname(DIST);
  const tsc = join(home, "node_modules", "typescript", "bin", "tsc");
  process.stdout.write("rebuilding acp…\n");
  const c = spawn(process.execPath, [tsc, "-p", join(home, "tsconfig.json")], { cwd: home, stdio: "inherit" });
  c.on("exit", (code) => {
    if (code === 0) process.stdout.write("✓ acp refreshed — the next command uses the latest build.\n");
    process.exit(code ?? 0);
  });
  c.on("error", (err) => {
    process.stderr.write(`acp refresh failed: ${String(err)}\n`);
    process.exit(1);
  });
} else {
  let target: string;
  let rest: string[];
  switch (sub) {
    case "init":
      target = "init.js";
      rest = argv.slice(1);
      break;
    case "fanout":
      target = "fanout.js";
      rest = argv.slice(1);
      break;
    case "swarm":
      target = "swarm.js";
      rest = argv.slice(1);
      break;
    case "pro":
      target = "pro.js";
      rest = argv.slice(1);
      break;
    case "capacity":
      target = "capacity.js";
      rest = argv.slice(1);
      break;
    case "sessions":
      target = "delegate.js";
      rest = ["--list-sessions"];
      break;
    case "feedback":
      target = "feedback-cli.js";
      rest = argv.slice(1);
      break;
    case "stats":
      target = "stats-cli.js";
      rest = argv.slice(1);
      break;
    case "rollback":
      target = "rollback-cli.js";
      rest = argv.slice(1);
      break;
    case "account":
      target = "account-cli.js";
      rest = argv.slice(1);
      break;
    case "api":
      target = "api-cli.js";
      rest = argv.slice(1);
      break;
    case "web":
      target = "web-cli.js";
      rest = argv.slice(1);
      break;
    case "qwen":
      target = "qwen-cli.js";
      rest = argv.slice(1);
      break;
    case "advise":
      target = "advise-cli.js";
      rest = argv.slice(1);
      break;
    case "monitor":
    case "dashboard":
      target = "monitor.js";
      rest = argv.slice(1);
      break;
    case undefined:
    case "--help":
    case "-h":
      process.stdout.write(HELP + "\n");
      process.exit(0);
    // eslint-disable-next-line no-fallthrough
    default:
      // Anything else is treated as a delegate task (plus any delegate flags).
      target = "delegate.js";
      rest = argv;
  }

  const child = spawn(process.execPath, [join(DIST, target), ...rest], {
    stdio: "inherit",
    env: process.env,
  });
  child.on("exit", (code) => process.exit(code ?? 0));
  child.on("error", (err) => {
    process.stderr.write(`acp: failed to run ${target}: ${String(err)}\n`);
    process.exit(1);
  });
}
