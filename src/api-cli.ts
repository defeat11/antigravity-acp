#!/usr/bin/env node
import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { startApiServer, getOrCreateToken, loadAllowlist, ALLOWLIST_PATH } from "./server.js";

const argv = process.argv.slice(2);
const sub = argv[0];

async function main() {
  if (sub === "token") {
    process.stdout.write("احتفظ بهذا التوكن سرياً — أي عملية تملكه تستطيع تفويض مهام كتابة كود بصلاحياتك:\n");
    process.stdout.write(getOrCreateToken() + "\n");
    process.exit(0);
  }

  if (sub === "allow") {
    const dirArg = argv[1];
    if (!dirArg) {
      process.stderr.write("usage: acp api allow <dir>\n");
      process.exit(1);
    }
    const resolvedDir = resolve(dirArg);
    if (!existsSync(resolvedDir)) {
      process.stderr.write(`directory does not exist: ${resolvedDir}\n`);
      process.exit(1);
    }
    const list = loadAllowlist();
    if (list.includes(resolvedDir)) {
      process.stdout.write(`already allowed: ${resolvedDir}\n`);
      process.exit(0);
    }
    list.push(resolvedDir);
    writeFileSync(ALLOWLIST_PATH, JSON.stringify(list, null, 2), "utf8");
    process.stdout.write(`✓ allowed: ${resolvedDir}\n`);
    process.exit(0);
  }

  if (sub === "list") {
    const list = loadAllowlist();
    if (list.length === 0) {
      process.stdout.write("(no projects allowed yet)\n");
    } else {
      for (const p of list) {
        process.stdout.write(`${p}\n`);
      }
    }
    process.exit(0);
  }

  if (!sub || sub === "start") {
    let port: number | undefined;
    const portIdx = argv.indexOf("--port");
    if (portIdx >= 0 && argv[portIdx + 1]) {
      port = Number(argv[portIdx + 1]) || undefined;
    }

    try {
      const serverInfo = await startApiServer({ port });
      process.stdout.write(`✓ acp API listening on ${serverInfo.url}\n`);
      process.stdout.write("token: acp api token   (keep it secret)\n");
      process.stdout.write(`example: curl -H "Authorization: Bearer <TOKEN>" ${serverInfo.url}/v1/health\n`);
    } catch (err) {
      process.stderr.write(`failed to start API server: ${String(err)}\n`);
      process.exit(1);
    }
    return; // Keep running
  }

  // Help or unknown
  const helpText = [
    "acp api — local HTTP API server management",
    "",
    "Usage:",
    "  acp api start [--port <n>]   Start the API server (default port 4771)",
    "  acp api token                Show the API Bearer auth token",
    "  acp api allow <dir>          Add a directory to the project allowlist",
    "  acp api list                 List all allowed project directories",
    "",
    "Flags:",
    "  --port <n>                   Specify port for start command",
  ].join("\n") + "\n";

  process.stdout.write(helpText);
  process.exit(0);
}

void main();
