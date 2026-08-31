/**
 * In-memory session state for the ACP adapter.
 *
 * Each ACP session maps to one logical agy conversation. We track enough state
 * to preserve continuity across prompt turns and to cancel an in-flight run.
 */

import { randomUUID } from "node:crypto";
import type { PermissionMode } from "./config.js";

export interface Turn {
  readonly role: "user" | "assistant";
  readonly text: string;
}

export interface Session {
  readonly id: string;
  /** Absolute working directory; passed to agy as its process cwd. */
  cwd: string;
  /** Extra absolute roots forwarded as `agy --add-dir`. */
  additionalDirectories: string[];
  /** Per-session override of the global permission mode (via session modes). */
  permissionMode: PermissionMode | null;
  /** agy conversation id once known (best effort), else null. */
  conversationId: string | null;
  /** Highest conversation-store step index already streamed for `conversationId`. */
  lastStepIdx: number;
  /** Whether at least one agy run has completed for this session. */
  hasRun: boolean;
  /** Whether the user has consented to running agy (for consent=session). */
  consented: boolean;
  /** Rolling transcript used for context injection. */
  transcript: Turn[];
  /** Controls the currently running prompt turn, if any. */
  abort: AbortController | null;
  /** Per-session serialization chain: turns within one session run in order. */
  queue: Promise<unknown>;
}

export class SessionStore {
  private readonly sessions = new Map<string, Session>();

  create(cwd: string, additionalDirectories: string[]): Session {
    const session: Session = {
      id: randomUUID(),
      cwd,
      additionalDirectories,
      permissionMode: null,
      conversationId: null,
      lastStepIdx: -1,
      hasRun: false,
      consented: false,
      transcript: [],
      abort: null,
      queue: Promise.resolve(),
    };
    this.sessions.set(session.id, session);
    return session;
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  delete(id: string): boolean {
    const session = this.sessions.get(id);
    session?.abort?.abort();
    return this.sessions.delete(id);
  }

  /** Abort every in-flight prompt turn (used on connection teardown). */
  abortAll(): void {
    for (const session of this.sessions.values()) {
      session.abort?.abort();
    }
  }

  recordTurn(session: Session, role: Turn["role"], text: string): void {
    const trimmed = text.trim();
    if (trimmed.length > 0) {
      session.transcript.push({ role, text: trimmed });
    }
  }
}
