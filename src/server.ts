import { createServer } from "node:http";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { homedir, cpus } from "node:os";
import { join, resolve, dirname } from "node:path";
import { runDelegate, type DelegateOptions, type DelegateResult } from "./delegate.js";

export const TOKEN_PATH = join(homedir(), ".acp", "api-token");
export const ALLOWLIST_PATH = join(homedir(), ".acp", "api-projects.json");

export function getOrCreateToken(): string {
  if (existsSync(TOKEN_PATH)) {
    return readFileSync(TOKEN_PATH, "utf8").trim();
  }
  const tokenDir = dirname(TOKEN_PATH);
  mkdirSync(tokenDir, { recursive: true });
  const token = randomBytes(32).toString("hex");
  writeFileSync(TOKEN_PATH, token, "utf8");
  try {
    chmodSync(TOKEN_PATH, 0o600);
  } catch {
    // Ignore chmod failure (e.g. on Windows)
  }
  return token;
}

export function loadAllowlist(): string[] {
  if (!existsSync(ALLOWLIST_PATH)) {
    const parentDir = dirname(ALLOWLIST_PATH);
    mkdirSync(parentDir, { recursive: true });
    writeFileSync(ALLOWLIST_PATH, JSON.stringify([]), "utf8");
    return [];
  }
  try {
    const data = JSON.parse(readFileSync(ALLOWLIST_PATH, "utf8"));
    if (Array.isArray(data)) {
      return data as string[];
    }
    return [];
  } catch {
    return [];
  }
}

export function isProjectAllowed(project: string): boolean {
  try {
    const resolvedProject = resolve(project);
    const allowlist = loadAllowlist().map((p) => resolve(p));
    return allowlist.includes(resolvedProject);
  } catch {
    return false;
  }
}

function checkAuth(req: import("node:http").IncomingMessage): boolean {
  try {
    let header = req.headers["authorization"];
    if (Array.isArray(header)) {
      header = header[0];
    }
    if (!header || !header.startsWith("Bearer ")) {
      return false;
    }
    const supplied = header.slice(7);
    const token = getOrCreateToken();
    if (supplied.length !== token.length) {
      return false;
    }
    return timingSafeEqual(Buffer.from(supplied), Buffer.from(token));
  } catch {
    return false;
  }
}

export interface JobRecord {
  id: string;
  state: "queued" | "running" | "done" | "error" | "cancelled";
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  opts: DelegateOptions;
  result?: DelegateResult;
  errorMessage?: string;
  /** Live only while running. Cancelling aborts the agent, which kills the tree. */
  controller?: AbortController;
}

const jobs = new Map<string, JobRecord>();
let activeCount = 0;
const queue: string[] = [];

function getConcurrency(): number {
  const envVal = Number(process.env.ACP_API_CONCURRENCY);
  if (!isNaN(envVal) && envVal > 0) {
    return envVal;
  }
  return Math.max(1, Math.floor(cpus().length / 2));
}

function tryProcessQueue(): void {
  while (activeCount < getConcurrency() && queue.length > 0) {
    const id = queue.shift();
    if (!id) continue;
    const job = jobs.get(id);
    if (!job) continue;

    activeCount++;
    job.state = "running";
    job.startedAt = new Date().toISOString();

    // The handle that was missing. Without it the server launched a job and
    // forgot how to hold it: the client could stop waiting, and nothing could
    // stop the work. Every piece below already supported cancellation.
    const controller = new AbortController();
    job.controller = controller;

    runDelegate({ ...job.opts, signal: controller.signal })
      .then((result) => {
        job.state = "done";
        job.result = result;
        job.finishedAt = new Date().toISOString();
        activeCount--;
        tryProcessQueue();
      })
      .catch((err) => {
        job.state = "error";
        job.errorMessage = String(err);
        job.finishedAt = new Date().toISOString();
        activeCount--;
        tryProcessQueue();
      });
  }
}

function enqueueJob(opts: DelegateOptions): string {
  const id = randomUUID();
  jobs.set(id, {
    id,
    state: "queued",
    createdAt: new Date().toISOString(),
    opts,
  });
  queue.push(id);
  tryProcessQueue();
  return id;
}

export function startApiServer(opts?: { port?: number }): Promise<{ url: string; close: () => Promise<void> }> {
  const port = opts?.port ?? (Number(process.env.ACP_API_PORT) || 4771);

  const server = createServer(async (req, res) => {
    const sendJson = (status: number, body: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };

    try {
      const url = req.url || "/";
      const method = req.method || "GET";

      if (method === "GET" && url === "/v1/health") {
        sendJson(200, { ok: true, time: new Date().toISOString() });
        return;
      }

      if (!checkAuth(req)) {
        sendJson(401, { error: "unauthorized — missing or invalid Bearer token" });
        return;
      }

      if (method === "GET" && url === "/v1/capacity") {
        sendJson(200, {
          concurrency: getConcurrency(),
          queued: queue.length,
          running: activeCount,
        });
        return;
      }

      if (method === "POST" && url === "/v1/delegate") {
        let bodyStr = "";
        req.setEncoding("utf8");
        for await (const chunk of req) {
          bodyStr += chunk;
          if (bodyStr.length > 200000) {
            sendJson(413, { error: "payload too large" });
            return;
          }
        }

        let body: any;
        try {
          body = JSON.parse(bodyStr);
        } catch {
          sendJson(400, { error: "invalid JSON body" });
          return;
        }

        if (typeof body.task !== "string" || !body.task.trim()) {
          sendJson(400, { error: "task is required" });
          return;
        }

        if (typeof body.project !== "string" || !body.project.trim()) {
          sendJson(400, { error: "project is required" });
          return;
        }

        if (!isProjectAllowed(body.project)) {
          sendJson(403, { error: "project not in allowlist — run: acp api allow <dir>" });
          return;
        }

        const jobOpts: DelegateOptions = {
          task: body.task,
          cwd: body.project,
          session: body.session,
          ephemeral: body.ephemeral,
          verifyCmd: body.verify,
          readOnly: body.readOnly,
          modelOverride: body.model,
          maxFiles: body.maxFiles,
          web: body.web,
        };

        const jobId = enqueueJob(jobOpts);
        sendJson(202, { jobId });
        return;
      }

      // The trigger. Everything it needs already existed: the agent aborts its
      // session, and the runner kills the agy process tree. This is the only
      // way to reach them from outside the process.
      const cancelMatch = url.match(/^\/v1\/jobs\/([^/]+)\/cancel$/);
      if (method === "POST" && cancelMatch) {
        const jobId = cancelMatch[1]!;
        const job = jobs.get(jobId);
        if (!job) {
          sendJson(404, { error: "job not found" });
          return;
        }
        if (job.state === "done" || job.state === "error" || job.state === "cancelled") {
          // Not an error, and deliberately not silent: the caller asked for a
          // guarantee and deserves to know it was already over.
          sendJson(200, { id: job.id, state: job.state, cancelled: false, note: "the job had already finished" });
          return;
        }
        if (job.state === "queued") {
          const at = queue.indexOf(jobId);
          if (at !== -1) queue.splice(at, 1);
          job.state = "cancelled";
          job.finishedAt = new Date().toISOString();
          sendJson(200, { id: job.id, state: job.state, cancelled: true, note: "removed before it started" });
          return;
        }
        job.controller?.abort();
        job.state = "cancelled";
        job.finishedAt = new Date().toISOString();
        sendJson(200, { id: job.id, state: job.state, cancelled: true, note: "abort sent; the agy process tree is killed" });
        return;
      }

      const jobMatch = url.match(/^\/v1\/jobs\/([^/]+)$/);
      if (method === "GET" && jobMatch) {
        const jobId = jobMatch[1]!;
        const job = jobs.get(jobId);
        if (!job) {
          sendJson(404, { error: "job not found" });
          return;
        }
        sendJson(200, {
          id: job.id,
          state: job.state,
          createdAt: job.createdAt,
          startedAt: job.startedAt,
          finishedAt: job.finishedAt,
          result: job.result,
          errorMessage: job.errorMessage,
        });
        return;
      }

      sendJson(404, { error: "not found" });
    } catch {
      sendJson(500, { error: "internal error" });
    }
  });

  return new Promise((resolveListening, rejectListening) => {
    server.on("error", (err) => {
      rejectListening(err);
    });

    server.listen(port, "127.0.0.1", () => {
      const addressInfo = server.address() as import("node:net").AddressInfo;
      const actualPort = addressInfo.port;
      resolveListening({
        url: `http://127.0.0.1:${actualPort}`,
        close: () =>
          new Promise<void>((resolveClose) => {
            server.close(() => resolveClose());
          }),
      });
    });
  });
}
