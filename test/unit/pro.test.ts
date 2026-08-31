import { describe, it, expect, vi, beforeEach } from "vitest";
import { runPro, collectFullDiff } from "../../src/pro.js";
import { extractJsonObject } from "../../src/swarm.js";
import { runDelegate } from "../../src/delegate.js";

let mockArchitectResponseText = "";
let mockCriticResponseText = "";

vi.mock("../../src/agent.js", () => {
  return {
    AntigravityAgent: class {
      connection: any;
      constructor(connection: any) {
        this.connection = connection;
      }
      async initialize() {}
      async newSession() {
        return { sessionId: "sess-1" };
      }
      async prompt(args: any) {
        const text = args.prompt[0].text;
        const responseText = text.includes("independent critic")
          ? mockCriticResponseText
          : mockArchitectResponseText;
        if (this.connection && this.connection.sessionUpdate) {
          await this.connection.sessionUpdate({
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { text: responseText },
            },
          });
        }
        return { stopReason: "end_turn" };
      }
      shutdown() {}
    },
  };
});

vi.mock("../../src/delegate.js", () => {
  return {
    runDelegate: vi.fn(),
  };
});

vi.mock("../../src/run-extras.js", () => {
  return {
    snapshotTree: vi.fn().mockReturnValue({}),
    restoreTree: vi.fn().mockReturnValue(0),
    runVerify: vi.fn().mockResolvedValue({ ok: true, exitCode: 0, output: "ok" }),
  };
});

vi.mock("node:child_process", () => {
  return {
    spawnSync: vi.fn().mockImplementation((cmd, args) => {
      if (cmd === "git") {
        if (args.includes("rev-parse")) {
          return { status: 0, stdout: "true" };
        }
        if (args.includes("diff")) {
          return { status: 0, stdout: "some mock diff" };
        }
      }
      return { status: 0, stdout: "" };
    }),
  };
});

describe("acp pro pipeline unit tests", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("extractJsonObject smoke test - should parse valid JSON object", () => {
    const result = extractJsonObject('hello {"approach": "test"} world');
    expect(result).toEqual({ approach: "test" });
  });

  it("collectFullDiff should retrieve git diff", () => {
    const diff = collectFullDiff("/mock-cwd");
    expect(diff).toBe("some mock diff");
  });

  it("should run at most 2 builder rounds when critic always rejects and maxCriticRounds is 2", async () => {
    mockArchitectResponseText = JSON.stringify({
      approach: "always reject approach",
      files: ["src/foo.ts"],
      risks: [],
      verifyCmd: "npm run test",
    });
    mockCriticResponseText = JSON.stringify({
      verdict: "reject",
      issues: ["some issue"],
    });

    let delegateCallCount = 0;
    vi.mocked(runDelegate).mockImplementation(async () => {
      delegateCallCount++;
      return {
        status: "ok",
        error: null,
        files: ["src/foo.ts"],
        verify: { ok: true, exitCode: 0, output: "all green" },
      } as any;
    });

    const result = await runPro({
      task: "do something",
      cwd: "/mock-cwd",
      maxCriticRounds: 2,
    });

    expect(delegateCallCount).toBe(2);
    expect(result.rounds).toBe(2);
    expect(result.status).toBe("ok");
    expect(result.criticVerdicts).toHaveLength(2);
    expect(result.criticVerdicts[0]?.verdict).toBe("reject");
    expect(result.criticVerdicts[1]?.verdict).toBe("reject");
  });

  it("should run exactly 1 builder round when critic approves", async () => {
    mockArchitectResponseText = JSON.stringify({
      approach: "always approve approach",
      files: ["src/foo.ts"],
      risks: [],
      verifyCmd: "npm run test",
    });
    mockCriticResponseText = JSON.stringify({
      verdict: "approve",
      issues: [],
    });

    let delegateCallCount = 0;
    vi.mocked(runDelegate).mockImplementation(async () => {
      delegateCallCount++;
      return {
        status: "ok",
        error: null,
        files: ["src/foo.ts"],
        verify: { ok: true, exitCode: 0, output: "all green" },
      } as any;
    });

    const result = await runPro({
      task: "do something",
      cwd: "/mock-cwd",
      maxCriticRounds: 2,
    });

    expect(delegateCallCount).toBe(1);
    expect(result.rounds).toBe(1);
    expect(result.status).toBe("ok");
    expect(result.criticVerdicts).toHaveLength(1);
    expect(result.criticVerdicts[0]?.verdict).toBe("approve");
  });

  it("should run escalation fix pass when verify fails", async () => {
    mockArchitectResponseText = JSON.stringify({
      approach: "test approach",
      files: ["src/foo.ts"],
      risks: [],
      verifyCmd: "npm run test",
    });
    mockCriticResponseText = JSON.stringify({
      verdict: "approve",
      issues: [],
    });

    let delegateCallCount = 0;
    vi.mocked(runDelegate).mockImplementation(async () => {
      delegateCallCount++;
      if (delegateCallCount === 1) {
        return {
          status: "ok",
          error: null,
          files: ["src/foo.ts"],
          verify: { ok: false, exitCode: 1, output: "test failure output" },
        } as any;
      } else {
        return {
          status: "ok",
          error: null,
          files: ["src/foo.ts"],
          verify: { ok: true, exitCode: 0, output: "test fixed" },
        } as any;
      }
    });

    const result = await runPro({
      task: "do something",
      cwd: "/mock-cwd",
      maxCriticRounds: 2,
    });

    expect(delegateCallCount).toBe(2);
    expect(result.rounds).toBe(1);
    expect(result.escalated).toBe(true);
    expect(result.status).toBe("ok");
    expect((result.verify as any).ok).toBe(true);
  });
});
