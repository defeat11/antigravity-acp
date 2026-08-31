// Scratch: verify LIVE streaming — timestamp each session/update as it arrives.
// If streaming is live, tool_calls for each file appear at increasing offsets
// BEFORE the turn completes (not all at the very end).
import { AntigravityAgent } from "../dist/agent.js";
import { loadConfig } from "../dist/config.js";
import { createLogger } from "../dist/logger.js";

const t0 = Date.now();
const stamp = () => `[+${String(Date.now() - t0).padStart(6)}ms]`;

const connection = {
  sessionUpdate: async (n) => {
    const u = n.update;
    if (u.sessionUpdate === "tool_call") console.log(`${stamp()} tool_call    ${u.title}`);
    else if (u.sessionUpdate === "tool_call_update") console.log(`${stamp()} tool_update  ${u.status}`);
    else if (u.sessionUpdate === "agent_message_chunk") console.log(`${stamp()} message      ${JSON.stringify(u.content.text.slice(0, 60))}`);
    else console.log(`${stamp()} ${u.sessionUpdate}`);
  },
  requestPermission: async () => ({ outcome: { outcome: "selected", optionId: "allow_always" } }),
};

const config = loadConfig({ ACP_AGY_MODEL: "gemini-3.5-flash-high", ACP_LOG_LEVEL: "error" });
const agent = new AntigravityAgent(connection, config, createLogger("error"));

const session = await agent.newSession({ cwd: process.cwd(), mcpServers: [] });
console.log(`${stamp()} session ${session.sessionId}`);
const res = await agent.prompt({
  sessionId: session.sessionId,
  prompt: [{ type: "text", text: "Create four files step by step: one.txt, two.txt, three.txt, four.txt — each containing a different single sentence about space. Create them one at a time, then reply DONE." }],
});
console.log(`${stamp()} stopReason=${res.stopReason}`);
process.exit(0);
