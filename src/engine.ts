/**
 * engine.ts — the EngineAdapter contract (ACP Vision 2030, Phase 1).
 *
 * acp's durable value is its control plane: guards, ledger, memory,
 * checkpoint, verify, escalation. Engines that actually run prompts are
 * replaceable adapters behind this interface. `AgyRunner` is the first
 * adapter; a direct Gemini-API adapter (Phase 2) plugs in here without
 * touching any guard, ledger, or memory code.
 *
 * Rule: control-plane code may only depend on THIS interface — never on a
 * concrete engine class. If an engine's vendor breaks its CLI/API, recovery
 * means swapping one adapter file, not rebuilding the project.
 */

/** Options every engine run receives — mirrors AgyRunOptions deliberately. */
export interface EngineRunOptions {
  readonly prompt: string;
  readonly cwd: string;
  readonly additionalDirectories: readonly string[];
  /** Resume a specific engine conversation by id; null/absent starts fresh. */
  readonly conversationId?: string | null;
  readonly signal: AbortSignal;
  readonly onStdout: (text: string) => void;
  readonly onStderr?: (text: string) => void;
  readonly onConversationId?: (conversationId: string, appDataDir: string | null) => void;
}

/** Result every engine run returns — mirrors AgyRunResult deliberately. */
export interface EngineRunResult {
  readonly exitCode: number | null;
  readonly termSignal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly aborted: boolean;
  readonly conversationId: string | null;
  readonly appDataDir: string | null;
  readonly modelFallback: boolean;
  readonly notLoggedIn: boolean;
}

/**
 * The contract any engine must fulfil to run under acp's control plane.
 * Implementations: AgyRunner (today). Planned: direct Gemini API, Claude API,
 * local models (ollama).
 */
export interface EngineAdapter {
  run(opts: EngineRunOptions): Promise<EngineRunResult>;
}
