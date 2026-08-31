// Scratch: verify multi-turn memory within one session (Phase 2).
// Turn 1 asks agy to remember a codeword; turn 2 (same session, resumed via
// --conversation) must recall it. Run: node scripts/two-turn-check.mjs
import { AntigravityAgent } from "../dist/agent.js";
import { loadConfig } from "../dist/config.js";
import { createLogger } from "../dist/logger.js";

const texts = [];
const connection = {
  sessionUpdate: async (n) => {
    const u = n.update;
    if (u.sessionUpdate === "agent_message_chunk" && u.content?.type === "text") {
      texts.push(u.content.text);
    }
  },
  requestPermission: async () => ({ outcome: { outcome: "selected", optionId: "allow_always" } }),
};

const config = loadConfig({ ACP_AGY_MODEL: "gemini-3.5-flash-high", ACP_LOG_LEVEL: "debug" });
const agent = new AntigravityAgent(connection, config, createLogger("debug"));

const session = await agent.newSession({ cwd: process.cwd(), mcpServers: [] });
console.log("session:", session.sessionId);

texts.length = 0;
const r1 = await agent.prompt({
  sessionId: session.sessionId,
  prompt: [{ type: "text", text: "Remember this codeword: ORCA-7731. Reply only 'memorized'. Do not create any files." }],
});
console.log("turn1 stopReason:", r1.stopReason, "| convId:", session.conversationId);

texts.length = 0;
const r2 = await agent.prompt({
  sessionId: session.sessionId,
  prompt: [{ type: "text", text: "What was the codeword I gave you? Reply with only the codeword. Do not create any files." }],
});
const turn2 = texts.join("");
console.log("turn2 stopReason:", r2.stopReason);
console.log("turn2 text:", JSON.stringify(turn2.slice(0, 300)));
console.log(turn2.includes("ORCA-7731") ? "RESULT: PASS — memory recalled across turns" : "RESULT: FAIL — codeword not recalled");
process.exit(0);
