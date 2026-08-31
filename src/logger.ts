/**
 * Structured logger that writes ONLY to stderr.
 *
 * This is load-bearing: stdout is the ACP JSON-RPC channel. A single stray
 * byte written to stdout corrupts the newline-delimited JSON stream and breaks
 * the connection. Never use console.log anywhere in this project — use this.
 */

import type { LogLevel } from "./config.js";

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

function format(
  level: LogLevel,
  msg: string,
  base: Record<string, unknown>,
  fields?: Record<string, unknown>,
): string {
  const merged = { ...base, ...fields };
  const ts = new Date().toISOString();
  const parts = Object.entries(merged)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${stringifyField(v)}`);
  const suffix = parts.length ? " " + parts.join(" ") : "";
  return `${ts} ${level.toUpperCase().padEnd(5)} ${msg}${suffix}\n`;
}

function stringifyField(v: unknown): string {
  if (typeof v === "string") return v.includes(" ") ? JSON.stringify(v) : v;
  if (typeof v === "number" || typeof v === "boolean" || v === null) return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function make(minWeight: number, base: Record<string, unknown>): Logger {
  const write = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => {
    if (LEVEL_WEIGHT[level] < minWeight) return;
    process.stderr.write(format(level, msg, base, fields));
  };
  return {
    debug: (msg, fields) => write("debug", msg, fields),
    info: (msg, fields) => write("info", msg, fields),
    warn: (msg, fields) => write("warn", msg, fields),
    error: (msg, fields) => write("error", msg, fields),
    child: (fields) => make(minWeight, { ...base, ...fields }),
  };
}

export function createLogger(level: LogLevel): Logger {
  return make(LEVEL_WEIGHT[level], {});
}
