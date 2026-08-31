import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnSyncMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  spawnSync: spawnSyncMock,
}));

import { listNodeProcesses, terminateNodeProcess } from "../../src/node-processes.js";

const originalPlatform = process.platform;
const startedAt = "2026-07-12T07:00:00.000Z";

function snapshot(pid = 1234, parentPid = 900): string {
  return JSON.stringify({
    processes: [
      { pid: parentPid, parentPid: 10, name: "codex.exe", commandLine: "codex app-server" },
      { pid, parentPid, name: "node.exe", commandLine: '"C:\\Program Files\\nodejs\\node.exe" "C:\\repo\\node_modules\\vite\\bin\\vite.js" --port 3000' },
    ],
    nodes: [{
      pid,
      parentPid,
      name: "node.exe",
      executablePath: "C:\\Program Files\\nodejs\\node.exe",
      commandLine: '"C:\\Program Files\\nodejs\\node.exe" "C:\\repo\\node_modules\\vite\\bin\\vite.js" --port 3000',
      startedAt,
      cpuSeconds: 12.5,
      memoryBytes: 104_857_600,
      threads: 13,
      ports: [3000],
    }],
  });
}

function duplicateSnapshot(): string {
  const parsed = JSON.parse(snapshot()) as any;
  parsed.processes.push({
    ...parsed.processes[1],
    pid: 1235,
  });
  parsed.nodes.push({
    ...parsed.nodes[0],
    pid: 1235,
    startedAt: "2026-07-12T07:01:00.000Z",
  });
  return JSON.stringify(parsed);
}

beforeEach(() => {
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  spawnSyncMock.mockReset();
});

afterEach(() => {
  Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
});

describe("Node process inventory", () => {
  it("returns requester, project, timing, resources, and ports", () => {
    spawnSyncMock.mockReturnValue({ status: 0, stdout: snapshot(), stderr: "" });

    const rows = listNodeProcesses({ fresh: true });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      pid: 1234,
      parentPid: 900,
      parentName: "codex.exe",
      startedAt,
      memoryMb: 100,
      cpuSeconds: 12.5,
      threads: 13,
      ports: [3000],
      project: "C:\\repo",
      canTerminate: true,
    });
    expect(rows[0]?.requester.label).toBe("Codex Desktop");
    expect(rows[0]?.script).toContain("vite.js");
  });

  it("protects the monitor's own Node process", () => {
    spawnSyncMock.mockReturnValue({ status: 0, stdout: snapshot(process.pid), stderr: "" });

    const row = listNodeProcesses({ fresh: true })[0];

    expect(row?.canTerminate).toBe(false);
    expect(row?.protectionReason).toContain("protects its own");
  });

  it("marks exact project/command duplicates and ranks the oldest first", () => {
    spawnSyncMock.mockReturnValue({ status: 0, stdout: duplicateSnapshot(), stderr: "" });

    const rows = listNodeProcesses({ fresh: true });

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ duplicateCount: 2, duplicateRank: 1 });
    expect(rows[1]).toMatchObject({ duplicateCount: 2, duplicateRank: 2 });
    expect(rows[0]?.duplicateGroupId).toMatch(/^dup-/);
    expect(rows[1]?.duplicateGroupId).toBe(rows[0]?.duplicateGroupId);
  });

  it("calculates recent CPU activity from consecutive samples", () => {
    const first = JSON.parse(snapshot()) as any;
    const second = JSON.parse(snapshot()) as any;
    second.nodes[0].cpuSeconds = first.nodes[0].cpuSeconds + 1;
    spawnSyncMock
      .mockReturnValueOnce({ status: 0, stdout: JSON.stringify(first), stderr: "" })
      .mockReturnValueOnce({ status: 0, stdout: JSON.stringify(second), stderr: "" });

    listNodeProcesses({ fresh: true });
    const row = listNodeProcesses({ fresh: true })[0];

    expect(row?.cpuPercent).not.toBeNull();
    expect(row?.cpuPercent).toBeGreaterThan(0);
    expect(row?.activity).toBe("active");
  });

  it("refuses a stale start time so PID reuse cannot end a different process", () => {
    spawnSyncMock.mockReturnValue({ status: 0, stdout: snapshot(), stderr: "" });

    const result = terminateNodeProcess({ pid: 1234, startedAt: "2026-07-12T06:00:00.000Z" });

    expect(result.ok).toBe(false);
    expect(result.message).toContain("PID was reused");
    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
  });

  it("ends only the selected PID after revalidation", () => {
    spawnSyncMock
      .mockReturnValueOnce({ status: 0, stdout: snapshot(), stderr: "" })
      .mockReturnValueOnce({ status: 0, stdout: "SUCCESS", stderr: "" });

    const result = terminateNodeProcess({ pid: 1234, startedAt });

    expect(result.ok).toBe(true);
    expect(spawnSyncMock).toHaveBeenCalledTimes(2);
    expect(spawnSyncMock.mock.calls[1]?.[0]).toBe("taskkill");
    expect(spawnSyncMock.mock.calls[1]?.[1]).toEqual(["/PID", "1234", "/F"]);
    expect(spawnSyncMock.mock.calls[1]?.[1]).not.toContain("/T");
  });
});
