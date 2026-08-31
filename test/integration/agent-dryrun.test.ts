import { describe, it, expect } from "vitest";
import * as acp from "@agentclientprotocol/sdk";
import { AntigravityAgent } from "../../src/agent.js";
import { loadConfig } from "../../src/config.js";
import { createLogger } from "../../src/logger.js";

/**
 * Full agent-logic integration in dry-run: exercises the ACP method surface
 * (initialize/newSession/setSessionMode/prompt/cancel) without spawning agy.
 * A fake connection records the session/update notifications the agent emits.
 */
function makeAgent() {
  const updates: acp.SessionNotification[] = [];
  const permissions: acp.RequestPermissionRequest[] = [];
  const connection = {
    sessionUpdate: async (n: acp.SessionNotification) => {
      updates.push(n);
    },
    requestPermission: async (p: acp.RequestPermissionRequest) => {
      permissions.push(p);
      return { outcome: { outcome: "selected", optionId: "allow_always" } } as acp.RequestPermissionResponse;
    },
  } as unknown as acp.AgentSideConnection;

  const config = loadConfig({ ACP_AGY_DRY_RUN: "1", ACP_LOG_LEVEL: "error" });
  const agent = new AntigravityAgent(connection, config, createLogger("error"));
  return { agent, updates, permissions };
}

const newSessionReq = (cwd: string): acp.NewSessionRequest =>
  ({ cwd, mcpServers: [] }) as acp.NewSessionRequest;

describe("AntigravityAgent — dry-run", () => {
  it("advertises protocol version and capabilities on initialize", async () => {
    const { agent } = makeAgent();
    const res = await agent.initialize({ protocolVersion: acp.PROTOCOL_VERSION } as acp.InitializeRequest);
    expect(res.protocolVersion).toBe(acp.PROTOCOL_VERSION);
    expect(res.agentCapabilities?.promptCapabilities?.embeddedContext).toBe(true);
    expect(res.authMethods?.length).toBeGreaterThan(0);
  });

  it("creates a session with modes and runs a full prompt turn", async () => {
    const { agent, updates } = makeAgent();
    const session = await agent.newSession(newSessionReq(process.cwd()));
    expect(session.sessionId).toBeTruthy();
    expect(session.modes?.availableModes.map((m) => m.id)).toContain("auto");

    const res = await agent.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "make something" }],
    } as acp.PromptRequest);

    expect(res.stopReason).toBe("end_turn");
    const kinds = updates.map((u) => u.update.sessionUpdate);
    expect(kinds).toContain("tool_call");
    expect(kinds).toContain("agent_message_chunk");
    expect(kinds).toContain("tool_call_update");
  });

  it("rejects an empty prompt and an unknown session", async () => {
    const { agent } = makeAgent();
    const session = await agent.newSession(newSessionReq(process.cwd()));
    await expect(
      agent.prompt({ sessionId: session.sessionId, prompt: [] } as acp.PromptRequest),
    ).rejects.toThrow();
    await expect(
      agent.prompt({ sessionId: "no-such-session", prompt: [{ type: "text", text: "x" }] } as acp.PromptRequest),
    ).rejects.toThrow();
  });

  it("requires an absolute cwd", async () => {
    const { agent } = makeAgent();
    await expect(agent.newSession(newSessionReq("relative/path"))).rejects.toThrow();
  });

  it("accepts a valid session mode change", async () => {
    const { agent } = makeAgent();
    const session = await agent.newSession(newSessionReq(process.cwd()));
    await expect(
      agent.setSessionMode({ sessionId: session.sessionId, modeId: "sandbox" } as acp.SetSessionModeRequest),
    ).resolves.toBeDefined();
    await expect(
      agent.setSessionMode({ sessionId: session.sessionId, modeId: "bogus" } as acp.SetSessionModeRequest),
    ).rejects.toThrow();
  });

  it("asks for consent when ACP_AGY_CONSENT=session", async () => {
    const updates: acp.SessionNotification[] = [];
    const permissions: acp.RequestPermissionRequest[] = [];
    const connection = {
      sessionUpdate: async (n: acp.SessionNotification) => {
        updates.push(n);
      },
      requestPermission: async (p: acp.RequestPermissionRequest) => {
        permissions.push(p);
        return { outcome: { outcome: "selected", optionId: "allow_always" } } as acp.RequestPermissionResponse;
      },
    } as unknown as acp.AgentSideConnection;
    const config = loadConfig({ ACP_AGY_DRY_RUN: "1", ACP_AGY_CONSENT: "session", ACP_LOG_LEVEL: "error" });
    const agent = new AntigravityAgent(connection, config, createLogger("error"));

    const session = await agent.newSession(newSessionReq(process.cwd()));
    await agent.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "x" }] } as acp.PromptRequest);
    expect(permissions.length).toBe(1);
  });
});
