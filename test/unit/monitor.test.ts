import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";

// Mock child_process
const mockSpawn = vi.fn(() => ({ unref: vi.fn(), on: vi.fn() }));
const mockExec = vi.fn((cmd, opts, cb) => {
  cb(null, { stdout: "mock stdout", stderr: "" });
});
const mockTerminateNodeProcess = vi.fn(() => ({ ok: true, pid: 4321, message: "ended" }));
const mockRecordNodeProcessAction = vi.fn();

vi.mock("node:child_process", () => {
  return {
    spawn: (cmd: any, args: any, opts: any) => mockSpawn(cmd, args, opts),
    spawnSync: vi.fn(),
    exec: (cmd: any, opts: any, cb: any) => {
      const callback = typeof opts === "function" ? opts : cb;
      mockExec(cmd, opts, callback);
    }
  };
});

// Mock accounts.ts
vi.mock("../../src/accounts.js", () => {
  return {
    exhaustedUntil: vi.fn(() => null),
    isExhausted: vi.fn(() => false),
    loadAccounts: vi.fn(() => ({
      accounts: [
        { name: "test-acc-1", email: "test1@example.com", home: "/home/test1" },
        { name: "test-acc-2", email: "test2@example.com", home: "/home/test2" }
      ],
      active: "test-acc-1"
    })),
    setActive: vi.fn((name) => {
      return name === "test-acc-1" || name === "test-acc-2";
    })
  };
});

// Mock registry.ts
vi.mock("../../src/registry.js", () => {
  return {
    listLiveAgents: vi.fn(() => []),
    summarizeUsage: vi.fn(() => ({
      totalRuns: 10,
      byAccount: {
        "test-acc-1": { runs: 6, lastUsed: "2026-07-08T12:00:00Z" },
        "test-acc-2": { runs: 4, lastUsed: "2026-07-08T11:00:00Z" }
      },
      byProject: {}
    }))
  };
});

vi.mock("../../src/node-processes.js", () => ({
  listNodeProcesses: vi.fn(() => [{
    pid: 4321,
    parentPid: 100,
    name: "node.exe",
    executablePath: "C:\\Program Files\\nodejs\\node.exe",
    commandLine: "node server.js",
    parentName: "cmd.exe",
    parentCommandLine: "cmd /c node server.js",
    parentExited: false,
    ancestry: [],
    requester: { label: "test runner", evidence: "unit test" },
    startedAt: "2026-07-12T07:00:00.000Z",
    uptimeMs: 1000,
    cpuSeconds: 1,
    cpuPercent: 0.5,
    activity: "listening",
    memoryMb: 25,
    threads: 8,
    ports: [3000],
    project: "C:\\test",
    script: "server.js",
    restartManaged: false,
    duplicateGroupId: null,
    duplicateCount: 1,
    duplicateRank: 1,
    canTerminate: true,
    protectionReason: null,
  }]),
  listNodeProcessActions: vi.fn(() => [{
    at: "2026-07-12T07:05:00.000Z",
    action: "end",
    pid: 4000,
    startedAt: "2026-07-12T06:00:00.000Z",
    script: "old-server.js",
    project: "C:\\old",
    requester: "test runner",
    ok: true,
    message: "ended",
  }]),
  recordNodeProcessAction: (input: any) => mockRecordNodeProcessAction(input),
  terminateNodeProcess: (input: any) => mockTerminateNodeProcess(input),
}));

// Mock process.argv before importing monitor
process.argv = ["node", "src/monitor.ts", "--no-open", "--port", "0"];

// Dynamic import of monitor after process.argv is mocked
const { server } = await import("../../src/monitor.js");
import type { AddressInfo } from "node:net";

describe("Monitor Server Endpoint Tests", () => {
  let url: string;

  beforeAll(async () => {
    if (!server.listening) {
      await new Promise<void>((resolve) => server.once("listening", resolve));
    }
    const address = server.address() as AddressInfo;
    url = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("serves HTML page on GET /", async () => {
    const res = await fetch(url);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("<title>acp monitor</title>");
  });

  it("serves JSON on GET /data", async () => {
    const res = await fetch(`${url}/data`);
    expect(res.status).toBe(200);
    const json = await res.json() as any;
    expect(json.accounts).toHaveLength(2);
    expect(json.accounts[0].name).toBe("test-acc-1");
    expect(json.nodeProcesses).toHaveLength(1);
    expect(json.nodeActions).toHaveLength(1);
    expect(json.nodeSummary.count).toBe(1);
    expect(json.nodeSummary.listening).toBe(1);
  });

  it("ends a selected Node PID with its start-time identity", async () => {
    mockTerminateNodeProcess.mockClear();
    const res = await fetch(`${url}/end-node-process`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pid: 4321, startedAt: "2026-07-12T07:00:00.000Z" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, pid: 4321 });
    expect(mockTerminateNodeProcess).toHaveBeenCalledWith({
      pid: 4321,
      startedAt: "2026-07-12T07:00:00.000Z",
    });
    expect(mockRecordNodeProcessAction).toHaveBeenCalledWith(expect.objectContaining({
      pid: 4321,
      ok: true,
      script: "server.js",
      requester: "test runner",
    }));
  });

  it("rejects an end request without a process start time", async () => {
    const res = await fetch(`${url}/end-node-process`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pid: 4321 }),
    });
    expect(res.status).toBe(400);
  });

  it("handles POST /set-active with valid account name", async () => {
    const { setActive } = await import("../../src/accounts.js");
    const res = await fetch(`${url}/set-active`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "test-acc-2" })
    });
    expect(res.status).toBe(200);
    const json = await res.json() as any;
    expect(json.ok).toBe(true);
    expect(setActive).toHaveBeenCalledWith("test-acc-2");
  });

  it("returns 400 on POST /set-active with invalid account name", async () => {
    const res = await fetch(`${url}/set-active`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "non-existent" })
    });
    expect(res.status).toBe(400);
    const json = await res.json() as any;
    expect(json.error).toBeDefined();
  });

  it("handles POST /open-shell with valid account name", async () => {
    mockSpawn.mockClear();
    const res = await fetch(`${url}/open-shell`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "test-acc-1" })
    });
    expect(res.status).toBe(200);
    const json = await res.json() as any;
    expect(json.ok).toBe(true);
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect(mockSpawn.mock.calls[0][0]).toBe("cmd");
  });

  it("returns 400 on POST /open-shell with invalid account name", async () => {
    const res = await fetch(`${url}/open-shell`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "non-existent" })
    });
    expect(res.status).toBe(400);
    const json = await res.json() as any;
    expect(json.error).toBe("Account not found");
  });

  it("handles POST /exec successfully", async () => {
    mockExec.mockImplementationOnce((cmd, opts, cb) => {
      cb(null, { stdout: "hello output", stderr: "some warning" });
    });

    const res = await fetch(`${url}/exec`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "test-acc-1", command: "echo hello" })
    });
    expect(res.status).toBe(200);
    const json = await res.json() as any;
    expect(json.ok).toBe(true);
    expect(json.code).toBe(0);
    expect(json.stdout).toBe("hello output");
    expect(json.stderr).toBe("some warning");
  });

  it("handles POST /exec with non-zero exit code command failure", async () => {
    const mockErr = new Error("Command failed: exit 1") as any;
    mockErr.code = 127;
    mockErr.stdout = "partial stdout";
    mockErr.stderr = "error details";

    mockExec.mockImplementationOnce((cmd, opts, cb) => {
      cb(mockErr);
    });

    const res = await fetch(`${url}/exec`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "test-acc-1", command: "invalid-command" })
    });
    expect(res.status).toBe(200);
    const json = await res.json() as any;
    expect(json.ok).toBe(false);
    expect(json.code).toBe(127);
    expect(json.stdout).toBe("partial stdout");
    expect(json.stderr).toBe("error details");
  });
});
