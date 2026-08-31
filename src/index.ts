#!/usr/bin/env node
/**
 * antigravity-acp — entry point.
 *
 * Wires this process's stdio to an ACP AgentSideConnection. The editor (ACP
 * client) speaks newline-delimited JSON-RPC over our stdin/stdout; we drive the
 * Antigravity CLI underneath. stdout is sacred: only JSON-RPC may be written
 * there, so all human output goes to stderr via the logger.
 */

import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

import { loadConfig, findReservedExtraArgs } from "./config.js";
import { createLogger } from "./logger.js";
import { AntigravityAgent } from "./agent.js";

const config = loadConfig();
const log = createLogger(config.logLevel);

log.info("antigravity-acp starting", {
  model: config.model,
  permissionMode: config.permissionMode,
  persist: config.persist,
  consent: config.consent,
  dryRun: config.dryRun,
});

const reservedExtra = findReservedExtraArgs(config.extraArgs);
if (reservedExtra.length > 0) {
  log.warn("ACP_AGY_EXTRA_ARGS contains adapter-managed flags; they may conflict with or override managed behavior", {
    flags: reservedExtra.join(" "),
  });
}

const writable = Writable.toWeb(process.stdout) as unknown as WritableStream<Uint8Array>;
const readable = Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>;
const stream = acp.ndJsonStream(writable, readable);

let agent: AntigravityAgent | undefined;
const connection = new acp.AgentSideConnection((conn) => {
  agent = new AntigravityAgent(conn, config, log);
  return agent;
}, stream);

void connection.closed.then(() => {
  log.info("connection closed; shutting down");
  agent?.shutdown();
  // Give kill signals a tick to flush, then exit cleanly.
  setTimeout(() => process.exit(0), 50).unref();
});

// A crash must never corrupt the JSON-RPC stream — log to stderr and keep going
// where possible; the connection lifecycle handles real teardown.
process.on("uncaughtException", (err) => {
  log.error("uncaughtException", { err: String(err), stack: err instanceof Error ? err.stack : undefined });
});
process.on("unhandledRejection", (reason) => {
  log.error("unhandledRejection", { reason: String(reason) });
});

// Terminate the agy child tree if the host signals us.
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    log.info("received signal; shutting down", { signal: sig });
    agent?.shutdown();
    setTimeout(() => process.exit(0), 50).unref();
  });
}
