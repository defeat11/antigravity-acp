/**
 * AntigravityAgent — the ACP Agent implementation.
 *
 * Bridges the Agent Client Protocol (spoken to an editor over stdio) to the
 * Antigravity CLI (`agy`), which acts as the code-writing sub-agent on
 * Gemini 3.6 Flash. Each ACP prompt turn becomes one streamed `agy --print`
 * run wrapped as an ACP tool call, with cancellation, session modes, optional
 * consent gating, and best-effort conversation continuity.
 */

import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import * as acp from "@agentclientprotocol/sdk";
import type { SessionMode } from "@agentclientprotocol/sdk";

import type { AppConfig, PermissionMode } from "./config.js";
import type { Logger } from "./logger.js";
import { AgyRunner, AgyNotFoundError } from "./agy-runner.js";
import { SessionStore, type Session } from "./session.js";
import { renderPrompt, buildContextPreamble } from "./prompt.js";
import { readConversationSteps, resolveConversationsDir } from "./conversation-store.js";

const AGENT_NAME = "antigravity-acp";
const AGENT_VERSION = "1.0.0";

const MODES: readonly SessionMode[] = [
  {
    id: "auto",
    name: "Autonomous",
    description: "agy edits files and runs tools without prompting (--dangerously-skip-permissions).",
  },
  {
    id: "sandbox",
    name: "Sandboxed",
    description: "agy runs with terminal sandbox restrictions and auto-approves remaining prompts.",
  },
  {
    id: "default",
    name: "Strict",
    description: "No auto-approve; agy may refuse or stall on actions that need permission.",
  },
];

export class AntigravityAgent implements acp.Agent {
  private readonly sessions = new SessionStore();
  private readonly runner: AgyRunner;
  /** Caps concurrent agy processes across all sessions. */
  private readonly limiter: Semaphore;
  /** Whether we've already warned that the requested model fell back. */
  private warnedModelFallback = false;

  constructor(
    private readonly connection: acp.AgentSideConnection,
    private readonly config: AppConfig,
    private readonly log: Logger,
  ) {
    this.runner = new AgyRunner(config, log);
    this.limiter = new Semaphore(config.maxConcurrent);
  }

  async initialize(_params: acp.InitializeRequest): Promise<acp.InitializeResponse> {
    this.log.info("initialize", {
      model: this.config.model,
      permissionMode: this.config.permissionMode,
      persist: this.config.persist,
      dryRun: this.config.dryRun,
    });
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentInfo: { name: AGENT_NAME, version: AGENT_VERSION },
      agentCapabilities: {
        loadSession: false,
        promptCapabilities: { image: false, audio: false, embeddedContext: true },
      },
      authMethods: [
        {
          id: "antigravity",
          name: "Antigravity (Google)",
          description:
            "Authentication is handled by the agy CLI itself (run `agy` once to log in, " +
            "or set ANTIGRAVITY_API_KEY).",
        },
      ],
    };
  }

  async authenticate(_params: acp.AuthenticateRequest): Promise<acp.AuthenticateResponse> {
    // agy owns its own credential store / OAuth flow; nothing to do here.
    return {};
  }

  async newSession(params: acp.NewSessionRequest): Promise<acp.NewSessionResponse> {
    if (!params.cwd || !isAbsolute(params.cwd)) {
      throw acp.RequestError.invalidParams(
        { cwd: params.cwd },
        "session/new requires an absolute `cwd`.",
      );
    }
    if (params.mcpServers && params.mcpServers.length > 0) {
      this.log.warn("ignoring mcpServers; configure MCP via agy plugins instead", {
        count: params.mcpServers.length,
      });
    }
    const extra = (params.additionalDirectories ?? []).filter((d) => isAbsolute(d));
    const session = this.sessions.create(params.cwd, extra);
    this.log.info("session created", { sessionId: session.id, cwd: params.cwd, extraDirs: extra.length });
    return {
      sessionId: session.id,
      modes: { availableModes: [...MODES], currentModeId: this.config.permissionMode },
    };
  }

  async setSessionMode(params: acp.SetSessionModeRequest): Promise<acp.SetSessionModeResponse> {
    const session = this.requireSession(params.sessionId);
    if (!MODES.some((m) => m.id === params.modeId)) {
      throw acp.RequestError.invalidParams({ modeId: params.modeId }, `Unknown session mode: ${params.modeId}`);
    }
    session.permissionMode = params.modeId as PermissionMode;
    this.log.info("session mode changed", { sessionId: session.id, mode: params.modeId });
    return {};
  }

  async prompt(params: acp.PromptRequest): Promise<acp.PromptResponse> {
    const session = this.requireSession(params.sessionId);

    const rendered = renderPrompt(params.prompt);
    if (!rendered.text.trim()) {
      throw acp.RequestError.invalidParams(undefined, "Prompt contained no usable text content.");
    }

    // A new prompt supersedes any in-flight turn for this session.
    session.abort?.abort();
    const abort = new AbortController();
    session.abort = abort;

    // Freeze the effective permission mode at consent time so a later
    // session/set_mode cannot escalate this already-approved turn's privileges.
    const mode = session.permissionMode ?? this.config.permissionMode;

    const consented = await this.ensureConsent(session, params.sessionId, mode);
    if (!consented) {
      this.clearAbort(session, abort);
      return { stopReason: "refusal" };
    }
    if (abort.signal.aborted) {
      this.clearAbort(session, abort);
      return { stopReason: "cancelled" };
    }

    // Turns within a single session run strictly in order (so turn N+1 can
    // resume the conversation id captured from turn N). Different sessions run
    // independently and in parallel, capped by the global concurrency limiter.
    const run = session.queue.then(() => this.runTurn(session, params.sessionId, rendered, abort, mode));
    session.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async cancel(params: acp.CancelNotification): Promise<void> {
    const session = this.sessions.get(params.sessionId);
    session?.abort?.abort();
    this.log.info("cancel requested", { sessionId: params.sessionId });
  }

  /** Abort all running turns; called when the connection or process is torn down. */
  shutdown(): void {
    this.sessions.abortAll();
  }

  /**
   * Seed a session with a previously-captured agy conversation so the next
   * prompt RESUMES it (full server-side memory) instead of starting fresh.
   * Used by programmatic drivers (delegate/fanout) for persistent sessions.
   */
  seedConversation(sessionId: string, conversationId: string, lastStepIdx: number): void {
    const session = this.requireSession(sessionId);
    session.conversationId = conversationId;
    session.lastStepIdx = lastStepIdx;
    session.hasRun = true;
  }

  /** Read the session's current agy conversation id + step cursor (to persist). */
  getConversation(sessionId: string): { conversationId: string | null; lastStepIdx: number } | null {
    const session = this.sessions.get(sessionId);
    return session ? { conversationId: session.conversationId, lastStepIdx: session.lastStepIdx } : null;
  }

  /**
   * Clear the session's abort controller, but only if it is still the one we
   * own. A newer prompt may have already installed its own controller; clearing
   * unconditionally would silently disarm cancellation for that newer turn.
   */
  private clearAbort(session: Session, abort: AbortController): void {
    if (session.abort === abort) session.abort = null;
  }

  // ---- internals ----------------------------------------------------------

  private async runTurn(
    session: Session,
    sessionId: string,
    rendered: { text: string; warnings: readonly string[] },
    abort: AbortController,
    mode: PermissionMode,
  ): Promise<acp.PromptResponse> {
    const signal = abort.signal;
    if (signal.aborted) {
      this.clearAbort(session, abort);
      return { stopReason: "cancelled" };
    }

    // Decide continuity and record the user turn now that we hold the session's
    // queue slot (consistent ordering with how agy actually runs).
    const promptText = this.composePrompt(session, rendered.text);
    this.sessions.recordTurn(session, "user", rendered.text);

    const modelLabel = this.config.model || "Gemini 3.6 Flash (default)";
    const toolCallId = `agy-${randomUUID()}`;

    await this.safeUpdate(sessionId, {
      sessionUpdate: "tool_call",
      toolCallId,
      title: `Antigravity CLI · ${modelLabel}`,
      kind: "other",
      status: "in_progress",
      rawInput: { model: modelLabel, cwd: session.cwd, permissionMode: mode },
    });

    if (rendered.warnings.length > 0) {
      await this.safeUpdate(sessionId, {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: rendered.warnings.join("\n") },
      });
    }

    // Live streamer: emits the conversation store's tool calls + assistant text
    // as they complete, both during the run (polling once the id surfaces) and
    // in a final drain afterwards. The store is the single emission path.
    const live = new LiveStreamer(
      session.lastStepIdx,
      (appDataDir) => resolveConversationsDir(this.config.convDir, appDataDir ?? undefined),
      (update) => this.safeUpdate(sessionId, update),
      this.log,
    );

    let result;
    await this.limiter.acquire();
    try {
      result = await this.runner.run({
        prompt: promptText,
        cwd: session.cwd,
        additionalDirectories: session.additionalDirectories,
        conversationId: session.conversationId,
        signal,
        // stdout is accumulated by the runner (result.stdout) for the fallback;
        // the conversation store is the structured emission path.
        onStdout: () => {},
        onStderr: (text) => this.log.debug("agy stderr", { text: text.trimEnd() }),
        onConversationId: (id, appDataDir) => live.begin(id, appDataDir, true),
      });
    } catch (err) {
      live.stopPolling();
      this.clearAbort(session, abort);
      await this.safeUpdate(sessionId, {
        sessionUpdate: "tool_call_update",
        toolCallId,
        status: "failed",
        rawOutput: { error: String(err) },
      });
      if (err instanceof AgyNotFoundError) {
        throw acp.RequestError.internalError(undefined, err.message);
      }
      throw acp.RequestError.internalError({ detail: String(err) }, "Failed to launch the Antigravity CLI.");
    } finally {
      this.limiter.release();
    }

    live.stopPolling();
    this.clearAbort(session, abort);
    session.hasRun = true;

    if (result.notLoggedIn) {
      await this.safeUpdate(sessionId, {
        sessionUpdate: "tool_call_update",
        toolCallId,
        status: "failed",
        rawOutput: { error: "not authenticated" },
      });
      throw acp.RequestError.authRequired(
        undefined,
        "agy is not logged into Antigravity. Run `agy` once interactively to sign in, or set ANTIGRAVITY_API_KEY.",
      );
    }

    if (result.modelFallback && !this.warnedModelFallback) {
      this.warnedModelFallback = true;
      this.log.warn(
        `agy does not recognize model "${this.config.model}"; it fell back to its ` +
          `default (Gemini Flash, Medium). Try \`agy update\`, pick a recognized id ` +
          `(see \`agy models\`, e.g. gemini-3.6-flash-low), or set ACP_AGY_MODEL="" to use the default cleanly.`,
      );
    }

    if (result.aborted) {
      await this.safeUpdate(sessionId, {
        sessionUpdate: "tool_call_update",
        toolCallId,
        status: "failed",
        rawOutput: { cancelled: true },
      });
      return { stopReason: "cancelled" };
    }

    if (result.exitCode !== 0) {
      await this.safeUpdate(sessionId, {
        sessionUpdate: "tool_call_update",
        toolCallId,
        status: "failed",
        rawOutput: { exitCode: result.exitCode, stderr: tail(result.stderr) },
      });
      const detail = tail(result.stderr) || tail(result.stdout) || "no output";
      throw acp.RequestError.internalError(
        { exitCode: result.exitCode },
        `Antigravity CLI exited with code ${result.exitCode}: ${detail}`,
      );
    }

    // If the id never surfaced during the run, fall back to the post-run value,
    // then drain any steps the live poll hasn't emitted yet.
    if (!live.active && result.conversationId) {
      live.begin(result.conversationId, result.appDataDir, false);
    }
    await live.finalDrain();

    // Persist continuity for the next turn (agy resumes via --conversation).
    if (live.conversationId) {
      session.conversationId = live.conversationId;
      session.lastStepIdx = live.maxIdx;
    }

    const storeText = live.text;
    const stdoutText = result.stdout.trim();
    let assistantText = storeText || stdoutText;
    if (!assistantText) {
      assistantText =
        "Antigravity finished the turn. No assistant text was captured — check the workspace for file changes.";
      await this.safeUpdate(sessionId, {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: assistantText },
      });
    } else if (!storeText && stdoutText) {
      // The store yielded no text but agy printed to stdout — surface that.
      await this.safeUpdate(sessionId, {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: stdoutText },
      });
    }

    this.sessions.recordTurn(session, "assistant", assistantText);
    await this.safeUpdate(sessionId, {
      sessionUpdate: "tool_call_update",
      toolCallId,
      status: "completed",
      rawOutput: { exitCode: 0, conversationId: live.conversationId },
    });
    return { stopReason: "end_turn" };
  }

  /**
   * Assemble the final prompt text. When we know the session's agy conversation
   * id, agy resumes it with full server-side memory, so we send the text as-is.
   * Only when continuity can't be delegated (id not yet captured but we've run
   * before — e.g. a prior id capture failed) do we inject the local transcript.
   */
  private composePrompt(session: Session, text: string): string {
    if (session.conversationId) return text;
    const inject = session.hasRun && this.config.persist !== "off";
    return inject
      ? buildContextPreamble(session.transcript, this.config.maxContextChars) + text
      : text;
  }

  private async ensureConsent(
    session: Session,
    sessionId: string,
    mode: PermissionMode,
  ): Promise<boolean> {
    const need =
      this.config.consent === "always" ||
      (this.config.consent === "session" && !session.consented);
    if (!need) return true;

    try {
      const res = await this.connection.requestPermission({
        sessionId,
        toolCall: {
          toolCallId: `consent-${randomUUID()}`,
          title: `Allow Antigravity CLI (${this.config.model}) to act in ${session.cwd}?`,
          kind: "execute",
          status: "pending",
          rawInput: { model: this.config.model, permissionMode: mode, cwd: session.cwd },
        },
        options: [
          { optionId: "allow_always", name: "Allow for this session", kind: "allow_always" },
          { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
          { optionId: "reject", name: "Reject", kind: "reject_once" },
        ],
      });
      if (res.outcome.outcome === "cancelled") return false;
      if (res.outcome.optionId === "reject") return false;
      if (res.outcome.optionId === "allow_always") session.consented = true;
      return true;
    } catch (err) {
      // Client may not implement session/request_permission. The operator
      // explicitly enabled consent, but failing closed would make the agent
      // unusable on such clients, so we proceed with a loud warning.
      this.log.warn("permission request failed; proceeding without consent gate", {
        err: String(err),
      });
      return true;
    }
  }

  private requireSession(id: string): Session {
    const session = this.sessions.get(id);
    if (!session) {
      throw acp.RequestError.invalidParams({ sessionId: id }, `Unknown session: ${id}`);
    }
    return session;
  }

  /** sessionUpdate that never throws — the connection may close mid-stream. */
  private async safeUpdate(sessionId: string, update: acp.SessionUpdate): Promise<void> {
    try {
      await this.connection.sessionUpdate({ sessionId, update });
    } catch (err) {
      this.log.debug("sessionUpdate failed (connection likely closed)", { err: String(err) });
    }
  }
}

/** Minimal FIFO counting semaphore to cap concurrent agy processes. */
class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly max: number) {}

  async acquire(): Promise<void> {
    if (this.active < this.max) {
      this.active++;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    // A slot was reserved for us in release() before we were resumed.
  }

  release(): void {
    const next = this.waiters.shift();
    if (next) {
      next(); // hand our slot directly to the next waiter (active stays the same)
    } else {
      this.active--;
    }
  }
}

/**
 * Streams an agy conversation's completed steps (tool calls + assistant text) to
 * the client as they appear — live while agy runs, plus a final drain. Each step
 * is emitted at most once (tracked by `idx`); accumulated text is exposed for
 * the transcript. All store/emit failures are swallowed (best-effort).
 */
class LiveStreamer {
  active = false;
  private convId: string | null = null;
  private convDir: string | null = null;
  private lastIdx: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private draining = false;
  private readonly textParts: string[] = [];

  constructor(
    startIdx: number,
    private readonly resolveDir: (appDataDir: string | null) => string,
    private readonly emit: (update: acp.SessionUpdate) => Promise<void>,
    private readonly log: Logger,
  ) {
    this.lastIdx = startIdx;
  }

  get conversationId(): string | null {
    return this.convId;
  }
  get maxIdx(): number {
    return this.lastIdx;
  }
  get text(): string {
    return this.textParts.join("\n\n").trim();
  }

  /** Bind to a conversation; optionally start polling its store. */
  begin(id: string, appDataDir: string | null, poll: boolean): void {
    if (this.active) return;
    this.active = true;
    this.convId = id;
    this.convDir = this.resolveDir(appDataDir);
    if (poll) {
      this.timer = setInterval(() => void this.drain(), 500);
      this.timer.unref();
    }
  }

  stopPolling(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Wait for any in-flight poll to settle, then emit any remaining steps. */
  async finalDrain(): Promise<void> {
    while (this.draining) await new Promise((r) => setTimeout(r, 20));
    await this.drain();
  }

  private async drain(): Promise<void> {
    if (this.draining || !this.convId || !this.convDir) return;
    this.draining = true;
    try {
      const res = readConversationSteps(this.convDir, this.convId, this.lastIdx);
      if (res) {
        for (const step of res.steps) {
          this.lastIdx = Math.max(this.lastIdx, step.idx);
          if (step.tool) {
            await this.emit({
              sessionUpdate: "tool_call",
              toolCallId: `agy-tool-${randomUUID()}`,
              title: step.tool.title,
              kind: step.tool.kind,
              status: "completed",
              locations: step.tool.targetFile ? [{ path: step.tool.targetFile }] : undefined,
              rawInput: step.tool.args ?? { tool: step.tool.name },
            });
          } else if (step.text) {
            this.textParts.push(step.text);
            await this.emit({
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: step.text },
            });
          }
        }
      }
    } catch (err) {
      this.log.debug("live store drain failed", { err: String(err) });
    } finally {
      this.draining = false;
    }
  }
}

function tail(text: string, max = 600): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return "…" + trimmed.slice(trimmed.length - max);
}
