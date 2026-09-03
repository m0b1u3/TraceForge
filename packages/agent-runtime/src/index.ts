export type AgentTurnResult<T> =
  | { outcome: "continue" }
  | { outcome: "finished"; value: T };

export interface AgentSessionOptions {
  maxTurns: number;
}

export interface AgentToolIntent { id: string; name: string; }
export type AgentToolIntentDisposition = "ready" | "duplicate" | "unavailable";
export interface AgentToolObservationPolicyResult {
  consecutiveFailures: number;
  commitInvocation: boolean;
  requiresApproval: boolean;
  failureLimitReached: boolean;
}

export const AGENT_EXECUTION_JOURNAL_FORMAT = "traceforge-agent-execution-journal";
export const AGENT_EXECUTION_JOURNAL_VERSION = 1;
export const MAX_AGENT_JOURNAL_ENTRIES = 4096;
export const MAX_AGENT_JOURNAL_STEERING = 1024;
export const MAX_AGENT_JOURNAL_COMPLETED_INTENTS = 4096;

export interface AgentJournalEntry {
  turn: number;
  kind: "model" | "tool" | "observer" | "system";
  summary: string;
  refs: string[];
  receiptKey?: string;
}

export interface AgentJournalTerminal {
  outcome: "completed" | "blocked" | "failed" | "waiting_approval" | "interrupted" | "budget_exhausted";
  reason: string;
  turn: number;
}

export interface AgentExecutionJournal {
  format: typeof AGENT_EXECUTION_JOURNAL_FORMAT;
  version: typeof AGENT_EXECUTION_JOURNAL_VERSION;
  sessionId: string;
  turn: number;
  consecutiveFailures: number;
  entries: AgentJournalEntry[];
  steering: string[];
  completedIntentIds: string[];
  terminal: AgentJournalTerminal | null;
}

export function createAgentExecutionJournal(input: {
  sessionId: string;
  initialEntries?: AgentJournalEntry[];
}): AgentExecutionJournal {
  return validateAgentExecutionJournal({
    format: AGENT_EXECUTION_JOURNAL_FORMAT,
    version: AGENT_EXECUTION_JOURNAL_VERSION,
    sessionId: input.sessionId,
    turn: 0,
    consecutiveFailures: 0,
    entries: structuredClone(input.initialEntries ?? []),
    steering: [],
    completedIntentIds: [],
    terminal: null,
  });
}

export function migrateLegacyAgentExecutionJournal(input: {
  sessionId: string;
  turn: number;
  consecutiveFailures?: number;
  transcript: AgentJournalEntry[];
  steering: string[];
  completedInvocationIds: string[];
}): AgentExecutionJournal {
  return validateAgentExecutionJournal({
    format: AGENT_EXECUTION_JOURNAL_FORMAT,
    version: AGENT_EXECUTION_JOURNAL_VERSION,
    sessionId: input.sessionId,
    turn: input.turn,
    consecutiveFailures: input.consecutiveFailures ?? 0,
    entries: structuredClone(input.transcript),
    steering: [...input.steering],
    completedIntentIds: [...input.completedInvocationIds],
    terminal: null,
  });
}

export function validateAgentExecutionJournal(value: unknown): AgentExecutionJournal {
  if (!value || typeof value !== "object") throw new Error("Invalid Agent Execution Journal");
  const journal = value as AgentExecutionJournal;
  const strings = (items: unknown): items is string[] => Array.isArray(items)
    && items.every((item) => typeof item === "string" && item.length > 0 && Buffer.byteLength(item) <= 8192);
  if (journal.format !== AGENT_EXECUTION_JOURNAL_FORMAT || journal.version !== AGENT_EXECUTION_JOURNAL_VERSION
    || typeof journal.sessionId !== "string" || !journal.sessionId.trim() || Buffer.byteLength(journal.sessionId) > 1024
    || !Number.isSafeInteger(journal.turn) || journal.turn < 0
    || !Number.isSafeInteger(journal.consecutiveFailures) || journal.consecutiveFailures < 0
    || !Array.isArray(journal.entries) || journal.entries.length > MAX_AGENT_JOURNAL_ENTRIES
    || !Array.isArray(journal.steering) || journal.steering.length > MAX_AGENT_JOURNAL_STEERING
    || !journal.steering.every((item) => typeof item === "string" && Buffer.byteLength(item) <= 64 * 1024)
    || !strings(journal.completedIntentIds) || journal.completedIntentIds.length > MAX_AGENT_JOURNAL_COMPLETED_INTENTS
    || new Set(journal.completedIntentIds).size !== journal.completedIntentIds.length) {
    throw new Error("Invalid Agent Execution Journal");
  }
  for (const entry of journal.entries) {
    if (!entry || !Number.isSafeInteger(entry.turn) || entry.turn < 0
      || !["model", "tool", "observer", "system"].includes(entry.kind)
      || typeof entry.summary !== "string" || Buffer.byteLength(entry.summary) > 64 * 1024
      || !strings(entry.refs) || entry.refs.length > 1024
      || (entry.receiptKey !== undefined && (entry.kind !== "tool" || typeof entry.receiptKey !== "string" || !entry.receiptKey.trim()))) {
      throw new Error("Invalid Agent Execution Journal entry");
    }
  }
  if (journal.terminal !== null && (!journal.terminal
    || !["completed", "blocked", "failed", "waiting_approval", "interrupted", "budget_exhausted"].includes(journal.terminal.outcome)
    || typeof journal.terminal.reason !== "string" || !journal.terminal.reason.trim() || Buffer.byteLength(journal.terminal.reason) > 64 * 1024
    || !Number.isSafeInteger(journal.terminal.turn) || journal.terminal.turn < 0 || journal.terminal.turn > journal.turn)) {
    throw new Error("Invalid Agent Execution Journal terminal state");
  }
  return journal;
}

export function recordAgentJournalTerminal(
  journal: AgentExecutionJournal,
  terminal: AgentJournalTerminal,
): AgentExecutionJournal {
  validateAgentExecutionJournal(journal);
  if (journal.terminal && JSON.stringify(journal.terminal) !== JSON.stringify(terminal)) {
    throw new Error("Agent Execution Journal already has a different terminal state");
  }
  journal.terminal = structuredClone(terminal);
  return validateAgentExecutionJournal(journal);
}

export function resumeAgentExecutionJournal(journal: AgentExecutionJournal): AgentExecutionJournal {
  validateAgentExecutionJournal(journal);
  if (journal.terminal?.outcome === "completed") throw new Error("Completed Agent Execution Journal cannot resume");
  journal.terminal = null;
  return journal;
}

/**
 * Owns the model/observer/tool turn budget independently of worker leases and
 * control-plane polling. A WorkerHost supplies one domain turn at a time.
 */
export class AgentSession<T> {
  constructor(
    readonly id: string,
    private readonly options: AgentSessionOptions,
  ) {
    if (!id.trim()) throw new Error("Agent Session id is required");
    if (!Number.isSafeInteger(options.maxTurns) || options.maxTurns < 1) {
      throw new Error("Agent Session maxTurns must be a positive integer");
    }
  }

  async run(
    firstTurn: number,
    signal: AbortSignal,
    executeTurn: (turn: number) => Promise<AgentTurnResult<T>>,
  ): Promise<{ outcome: "finished"; value: T } | { outcome: "budget_exhausted"; turns: number }> {
    if (!Number.isSafeInteger(firstTurn) || firstTurn < 1) throw new Error("Agent Session firstTurn must be positive");
    for (let turn = firstTurn; turn <= this.options.maxTurns; turn += 1) {
      signal.throwIfAborted();
      const result = await executeTurn(turn);
      signal.throwIfAborted();
      if (result.outcome === "finished") return result;
    }
    return { outcome: "budget_exhausted", turns: this.options.maxTurns };
  }

  /** Runs the invariant cognitive phase order before a host applies effects. */
  async evaluate<TContext, TIntent, TObservation>(input: {
    context: TContext;
    signal: AbortSignal;
    decide(context: TContext, signal: AbortSignal): Promise<TIntent>;
    recordIntent?(intent: TIntent): void;
    observe(context: TContext, intent: TIntent, signal: AbortSignal): Promise<TObservation>;
  }): Promise<{ intent: TIntent; observation: TObservation }> {
    input.signal.throwIfAborted();
    const intent = await input.decide(input.context, input.signal);
    input.signal.throwIfAborted();
    input.recordIntent?.(intent);
    const observation = await input.observe(input.context, intent, input.signal);
    input.signal.throwIfAborted();
    return { intent, observation };
  }

  classifyToolIntent(intent: AgentToolIntent, completedInvocationIds: readonly string[], available: boolean): AgentToolIntentDisposition {
    if (!intent.id.trim() || !intent.name.trim()) throw new Error("Agent tool intent requires an id and name");
    if (completedInvocationIds.includes(intent.id)) return "duplicate";
    return available ? "ready" : "unavailable";
  }

  applyToolObservation(
    status: "succeeded" | "failed" | "approval_required",
    consecutiveFailures: number,
    failureLimit: number,
  ): AgentToolObservationPolicyResult {
    if (!Number.isSafeInteger(consecutiveFailures) || consecutiveFailures < 0
      || !Number.isSafeInteger(failureLimit) || failureLimit < 1) throw new Error("Invalid Agent tool failure policy");
    if (status === "approval_required") return { consecutiveFailures, commitInvocation: false, requiresApproval: true, failureLimitReached: false };
    const next = status === "succeeded" ? 0 : consecutiveFailures + 1;
    return { consecutiveFailures: next, commitInvocation: true, requiresApproval: false, failureLimitReached: next >= failureLimit };
  }
}

export class AgentHarness {
  openSession<T>(id: string, options: AgentSessionOptions): AgentSession<T> {
    return new AgentSession<T>(id, options);
  }
}
