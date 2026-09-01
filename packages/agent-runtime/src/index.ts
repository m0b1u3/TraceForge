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
