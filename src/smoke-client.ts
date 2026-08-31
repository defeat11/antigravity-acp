#!/usr/bin/env node
/**
 * Smoke-test ACP client.
 *
 * Spawns the antigravity-acp agent as a child process and drives a full ACP
 * round-trip over stdio: initialize -> session/new -> session/prompt, printing
 * every streamed update. This both verifies the wiring and demonstrates how to
 * drive the Antigravity sub-agent programmatically from any ACP client.
 *
 * Defaults to ACP_AGY_DRY_RUN=1 so it runs with no agy login / no network.
 * To exercise the real CLI:  ACP_AGY_DRY_RUN=0 node dist/smoke-client.js "your prompt"
 *
 * Usage: node dist/smoke-client.js [prompt...]
 */

import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as acp from "@agentclientprotocol/sdk";

const here = fileURLToPath(import.meta.url);
const ext = here.endsWith(".ts") ? ".ts" : ".js";
const indexPath = join(dirname(here), `index${ext}`);
const childArgs = ext === ".ts" ? ["--import", "tsx", indexPath] : [indexPath];

const promptText = process.argv.slice(2).join(" ") || "Say hello and list the files you would create for a tiny Node HTTP server.";

const env = { ...process.env };
if (env.ACP_AGY_DRY_RUN === undefined) env.ACP_AGY_DRY_RUN = "1";

function out(line: string): void {
  process.stdout.write(line + "\n");
}

const child = spawn(process.execPath, childArgs, {
  stdio: ["pipe", "pipe", "inherit"], // child stderr (its logs) stream to our terminal
  env,
});

child.on("error", (err) => {
  out(`✖ failed to spawn agent: ${err}`);
  process.exit(1);
});

const writable = Writable.toWeb(child.stdin!) as unknown as WritableStream<Uint8Array>;
const readable = Readable.toWeb(child.stdout!) as unknown as ReadableStream<Uint8Array>;
const stream = acp.ndJsonStream(writable, readable);

const client: acp.Client = {
  async sessionUpdate(params) {
    const u = params.update;
    switch (u.sessionUpdate) {
      case "agent_message_chunk":
        if (u.content.type === "text") process.stdout.write(u.content.text);
        break;
      case "agent_thought_chunk":
        if (u.content.type === "text") out(`\n  ↳ (thought) ${u.content.text}`);
        break;
      case "tool_call":
        out(`\n▶ tool_call [${u.status}] ${u.title}`);
        break;
      case "tool_call_update":
        out(`\n◼ tool_call_update [${u.status}] ${u.toolCallId}`);
        break;
      default:
        out(`\n· update: ${u.sessionUpdate}`);
    }
  },
  async requestPermission(params) {
    const allow =
      params.options.find((o) => o.kind === "allow_always") ??
      params.options.find((o) => o.kind.startsWith("allow")) ??
      params.options[0]!;
    out(`\n🔐 permission requested: "${params.toolCall.title}" → auto-selecting "${allow.name}"`);
    return { outcome: { outcome: "selected", optionId: allow.optionId } };
  },
};

const connection = new acp.ClientSideConnection(() => client, stream);

async function main(): Promise<void> {
  out("→ initialize");
  const init = await connection.initialize({
    protocolVersion: acp.PROTOCOL_VERSION,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    clientInfo: { name: "antigravity-acp-smoke", version: "1.0.0" },
  });
  out(`← protocolVersion=${init.protocolVersion} agent=${init.agentInfo?.name}@${init.agentInfo?.version}`);

  out("→ session/new");
  // Allow targeting another project dir without `cd` (handy when delegating).
  const sessionCwd = process.env.ACP_SMOKE_CWD?.trim() || process.cwd();
  const session = await connection.newSession({ cwd: sessionCwd, mcpServers: [] });
  out(`← sessionId=${session.sessionId} modes=${session.modes?.availableModes.map((m) => m.id).join(",") ?? "none"}`);

  out(`→ session/prompt: ${JSON.stringify(promptText)}\n`);
  const res = await connection.prompt({
    sessionId: session.sessionId,
    prompt: [{ type: "text", text: promptText }],
  });
  out(`\n\n← stopReason=${res.stopReason}`);
}

main()
  .then(() => {
    child.stdin?.end();
    setTimeout(() => process.exit(0), 50).unref();
  })
  .catch((err) => {
    out(`\n✖ error: ${err?.message ?? err}`);
    child.kill();
    process.exit(1);
  });
