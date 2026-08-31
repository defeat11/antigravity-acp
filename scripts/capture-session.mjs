// Capture a real ACP session (timeline of protocol messages + live updates)
// to JSON, so it can be replayed in a visual viewer.
// Usage: node scripts/capture-session.mjs > session.json   (run from a temp cwd)
import { AntigravityAgent } from "../dist/agent.js";
import { loadConfig } from "../dist/config.js";
import { createLogger } from "../dist/logger.js";
import * as acp from "@agentclientprotocol/sdk";

const t0 = Date.now();
const events = [];
const at = () => Date.now() - t0;
const rec = (e) => events.push({ t: at(), ...e });

const connection = {
  sessionUpdate: async (n) => {
    const u = n.update;
    if (u.sessionUpdate === "tool_call")
      rec({ kind: "tool_call", title: u.title, toolKind: u.kind, status: u.status });
    else if (u.sessionUpdate === "tool_call_update")
      rec({ kind: "tool_call_update", status: u.status });
    else if (u.sessionUpdate === "agent_message_chunk")
      rec({ kind: "message", text: u.content.text });
    else if (u.sessionUpdate === "agent_thought_chunk")
      rec({ kind: "thought", text: u.content.text });
    else rec({ kind: u.sessionUpdate });
  },
  requestPermission: async () => ({ outcome: { outcome: "selected", optionId: "allow_always" } }),
};

const config = loadConfig({ ACP_AGY_MODEL: "gemini-3.5-flash-high", ACP_LOG_LEVEL: "error" });
const agent = new AntigravityAgent(connection, config, createLogger("error"));

const task =
  process.argv.slice(2).join(" ") ||
  "Create a small Node module math.js exporting add(a,b) and mul(a,b), and a README.md documenting them. Then briefly summarize what you did.";

rec({ kind: "rpc", dir: "out", method: "initialize" });
const init = await agent.initialize({ protocolVersion: acp.PROTOCOL_VERSION });
rec({ kind: "rpc", dir: "in", method: "initialize", info: `${init.agentInfo?.name}@${init.agentInfo?.version} · protocol v${init.protocolVersion}` });

rec({ kind: "rpc", dir: "out", method: "session/new", info: `cwd=${process.cwd()}` });
const session = await agent.newSession({ cwd: process.cwd(), mcpServers: [] });
rec({ kind: "rpc", dir: "in", method: "session/new", info: `modes: ${session.modes?.availableModes.map((m) => m.id).join(", ")}` });

rec({ kind: "rpc", dir: "out", method: "session/prompt", info: task });
const res = await agent.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: task }] });
rec({ kind: "rpc", dir: "in", method: "session/prompt", info: `stopReason=${res.stopReason}` });

process.stdout.write(
  JSON.stringify(
    { model: "gemini-3.5-flash-high (→ Flash 3.5 Medium fallback)", task, totalMs: at(), events },
    null,
    2,
  ),
);
process.exit(0);
