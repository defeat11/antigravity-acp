#!/usr/bin/env node
/**
 * capacity — how many Antigravity sub-agents can this machine run at once?
 *
 * Quick mode (default): reports CPU/RAM, measures one real agy run's memory
 * footprint, and recommends ACP_AGY_MAX_CONCURRENT.
 *
 * Stress mode (`--stress [maxN]`): launches escalating batches of parallel agy
 * probes and finds the largest batch that stays healthy (no failures, RAM above
 * a safety floor, latency not collapsing).
 *
 * Usage:
 *   node dist/capacity.js               # quick check
 *   node dist/capacity.js --stress 8    # escalate up to 8 parallel agents
 */

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as os from "node:os";
import { join } from "node:path";

import { loadConfig } from "./config.js";
import { resolveExecutable } from "./bin-resolver.js";

const PROBE_PROMPT =
  "Reply with the single word READY and nothing else. Do not create, read, or modify any files.";
const GB = 1024 ** 3;
const MB = 1024 ** 2;
const RAM_SAFETY_FLOOR = 1.2 * GB; // keep at least this much free
const RAM_BUDGET_FRACTION = 0.7; // only plan to use 70% of currently-free RAM

const config = loadConfig();
const bin = resolveExecutable(config.agyBin);
const model = config.model || "";

function fmtGB(bytes: number): string {
  return (bytes / GB).toFixed(1) + " GB";
}

/** Run one agy probe in a throwaway dir; sample system free-RAM low-water-mark. */
function probe(): Promise<{ ok: boolean; ms: number; freeMinBytes: number }> {
  return new Promise((resolve) => {
    if (!bin) {
      resolve({ ok: false, ms: 0, freeMinBytes: os.freemem() });
      return;
    }
    const dir = mkdtempSync(join(tmpdir(), "agy-cap-"));
    const args: string[] = [];
    if (model) args.push("--model", model);
    args.push("--dangerously-skip-permissions", "--print-timeout", "60s", `--print=${PROBE_PROMPT}`);

    const start = Date.now();
    let freeMin = os.freemem();
    const sampler = setInterval(() => {
      const f = os.freemem();
      if (f < freeMin) freeMin = f;
    }, 250);

    const child = spawn(bin, args, { cwd: dir, env: process.env, windowsHide: true, stdio: "ignore" });
    child.on("error", () => finish(false));
    child.on("close", (code) => finish(code === 0));

    function finish(ok: boolean): void {
      clearInterval(sampler);
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
      resolve({ ok, ms: Date.now() - start, freeMinBytes: freeMin });
    }
  });
}

/** Run N probes in parallel; return batch health metrics. */
async function batch(n: number): Promise<{
  n: number;
  ok: number;
  failed: number;
  wallMs: number;
  ramUsedBytes: number;
  freeMinBytes: number;
}> {
  const baselineFree = os.freemem();
  const start = Date.now();
  const results = await Promise.all(Array.from({ length: n }, () => probe()));
  const wallMs = Date.now() - start;
  const freeMin = Math.min(...results.map((r) => r.freeMinBytes), os.freemem());
  return {
    n,
    ok: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    wallMs,
    ramUsedBytes: Math.max(0, baselineFree - freeMin),
    freeMinBytes: freeMin,
  };
}

function recommend(perAgentBytes: number, logical: number): { rec: number; cpuBound: number; ramBound: number } {
  // agy's Go language server uses several cores, so ~2 logical cores per agent.
  const cpuBound = Math.max(1, Math.floor(logical / 2));
  const ramBudget = os.freemem() * RAM_BUDGET_FRACTION;
  const ramBound = Math.max(1, Math.floor(ramBudget / Math.max(perAgentBytes, 64 * MB)));
  return { rec: Math.max(1, Math.min(cpuBound, ramBound)), cpuBound, ramBound };
}

function printMachine(): { logical: number } {
  const cpus = os.cpus();
  const logical = cpus.length;
  console.log("=== Antigravity sub-agent capacity ===");
  console.log(`machine:  ${cpus[0]?.model?.trim() ?? "unknown CPU"}`);
  console.log(`cpu:      ${logical} logical cores`);
  console.log(`ram:      ${fmtGB(os.totalmem())} total, ${fmtGB(os.freemem())} free`);
  console.log(`platform: ${process.platform} ${os.release()}`);
  console.log(`agy:      ${bin ?? "NOT FOUND (set ACP_AGY_BIN)"}  model=${model || "(default)"}`);
  console.log("");
  return { logical };
}

async function main(): Promise<void> {
  const { logical } = printMachine();
  if (!bin) {
    console.log("Cannot measure: agy not found. Install it or set ACP_AGY_BIN.");
    process.exit(2);
  }

  const stressIdx = process.argv.indexOf("--stress");
  const doStress = stressIdx !== -1;
  const maxN = doStress ? Number.parseInt(process.argv[stressIdx + 1] ?? "", 10) || logical : 0;

  console.log("measuring one agy run (≈10–15s)…");
  const one = await probe();
  if (!one.ok) {
    console.log("  probe failed — is agy logged in? run `agy` once interactively.");
    process.exit(1);
  }
  // RAM is freed once the probe exits, so free-now ≈ pre-probe baseline; the
  // drop to the low-water-mark during the run estimates one agent's footprint.
  const perAgent = Math.max(0, os.freemem() - one.freeMinBytes);
  // free-RAM delta is noisy (OS caching); floor to a sane minimum.
  const perAgentEst = Math.max(perAgent, 300 * MB);
  console.log(`  startup: ${(one.ms / 1000).toFixed(1)}s, footprint ≈ ${(perAgentEst / MB).toFixed(0)} MB (free-RAM estimate)`);
  console.log("");

  const { rec, cpuBound, ramBound } = recommend(perAgentEst, logical);
  console.log("recommendation (quick estimate):");
  console.log(`  ACP_AGY_MAX_CONCURRENT = ${rec}`);
  console.log(`  cpu-bound ≈ ${cpuBound} (logical/2)   ram-bound ≈ ${ramBound} (70% free / footprint)`);
  console.log(`  comfortable: ${Math.max(1, Math.floor(rec * 0.7))}   ·   burst: ${rec}`);

  if (!doStress) {
    console.log("");
    console.log("run an empirical stress test with:  node dist/capacity.js --stress " + Math.max(rec + 2, 4));
    process.exit(0);
  }

  console.log("");
  console.log(`stress test: escalating parallel agents up to ${maxN} (this spawns real agy runs)…`);
  const seq = buildSequence(maxN);
  let baselineWall = one.ms;
  let lastHealthy = 1;
  for (const n of seq) {
    const b = await batch(n);
    const perAgentWall = b.wallMs;
    const healthy =
      b.failed === 0 && b.freeMinBytes > RAM_SAFETY_FLOOR && perAgentWall < baselineWall * 2.8;
    if (n === 1) baselineWall = b.wallMs;
    console.log(
      `  n=${String(n).padStart(2)}  ok=${b.ok}/${n}  wall=${(b.wallMs / 1000).toFixed(1)}s  ` +
        `ram≈${(b.ramUsedBytes / MB).toFixed(0)}MB  freeMin=${fmtGB(b.freeMinBytes)}  ` +
        `${healthy ? "OK" : "DEGRADED"}`,
    );
    if (!healthy) break;
    lastHealthy = n;
  }
  const cappedOut = lastHealthy === maxN ? " (test ceiling — try a higher --stress N)" : "";
  console.log("");
  console.log(`empirical max (healthy): ${lastHealthy} concurrent sub-agent(s)${cappedOut}`);
  console.log(`  → set ACP_AGY_MAX_CONCURRENT=${lastHealthy}`);
  console.log(
    "  note: these probes are network-bound (waiting on Gemini), so they pack tightly. Real coding",
  );
  console.log(
    "  tasks that run commands / install deps are heavier — for those, prefer a value near logical/2.",
  );
  process.exit(0);
}

function buildSequence(maxN: number): number[] {
  const seq: number[] = [];
  for (let n = 1; n <= maxN; n += n < 4 ? 1 : 2) seq.push(n);
  if (seq[seq.length - 1] !== maxN) seq.push(maxN);
  return seq;
}

void main();
