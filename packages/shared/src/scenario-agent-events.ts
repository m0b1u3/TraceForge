import { z } from "zod";
import { AgentTurnOutcomeSchema, AgentTurnPhaseSchema } from "./agent-turn.js";

export const ScenarioAgentRoleSchema = z.enum(["planner", "observer", "worker", "replay", "system"]);
export type ScenarioAgentRole = z.infer<typeof ScenarioAgentRoleSchema>;

const usage = z.object({ promptTokens: z.number().int().nonnegative(), completionTokens: z.number().int().nonnegative(), totalTokens: z.number().int().nonnegative() });

export const ScenarioAgentItemSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("modelAdmission"), id: z.string().min(1),
    status: z.enum(["queued", "admitted", "released", "cancelled", "timedOut", "interrupted", "rejected"]),
    priority: z.number().int(), queueWaitMs: z.number().int().nonnegative().nullable().default(null),
    outcome: z.enum(["completed", "failed", "timedOut", "cancelled"]).nullable().default(null),
    reason: z.string().nullable().default(null),
  }),
  z.object({
    type: z.literal("modelCall"), id: z.string().min(1), routeId: z.string().min(1), attempt: z.number().int().positive(),
    status: z.enum(["inProgress", "completed", "failed", "timedOut", "cancelled", "interrupted"]),
    reservedTokens: z.number().int().nonnegative(), usage: usage.nullable().default(null), error: z.string().nullable().default(null),
  }),
  z.object({
    type: z.literal("toolCall"), id: z.string().min(1), tool: z.string().min(1),
    status: z.enum(["inProgress", "completed", "failed", "waitingApproval", "cancelled"]),
    risk: z.enum(["read_only", "bounded_write", "privileged", "destructive"]).nullable().default(null),
    summary: z.string().nullable().default(null), refs: z.array(z.string()).default([]),
  }),
  z.object({
    type: z.literal("approval"), id: z.string().min(1), tool: z.string().min(1),
    status: z.enum(["pending", "approved", "rejected", "cancelled"]),
    risk: z.enum(["read_only", "bounded_write", "privileged", "destructive"]), reason: z.string().nullable().default(null),
  }),
  z.object({
    type: z.literal("controlChange"), id: z.string().min(1), status: z.literal("completed"),
    eventType: z.string().min(1), summary: z.string().min(1), refs: z.array(z.string()).default([]),
    // Completion belongs to recording this fact, never to a referenced process/tool.
    audit: z.object({
      version: z.literal(1), source: z.enum(["compaction", "contextSnapshot", "invocation", "reconciliation", "recoveryCommand", "executionOccupancy", "processOccupancy"]),
      sourceId: z.string().min(1), state: z.string().min(1),
      semantics: z.enum(["durable_fact", "observed_state"]),
      automaticRetryAllowed: z.literal(false),
    }).optional(),
  }),
]);
export type ScenarioAgentItem = z.infer<typeof ScenarioAgentItemSchema>;

const envelope = z.object({
  protocolVersion: z.literal(2), id: z.string().min(1), sequence: z.number().int().positive().safe(),
  runId: z.string().min(1), caseId: z.string().min(1), workId: z.string().min(1).nullable(),
  turnId: z.string().min(1), role: ScenarioAgentRoleSchema, createdAt: z.string().datetime(),
});

export const ScenarioAgentEventSchema = z.discriminatedUnion("method", [
  envelope.extend({
    method: z.literal("turn/started"),
    params: z.object({
      agentInstanceId: z.string().min(1), sourceRunRevision: z.number().int().nonnegative(),
      sourceGraphRevision: z.number().int().nonnegative().nullable(),
    }),
  }),
  envelope.extend({
    method: z.literal("turn/progress"),
    params: z.object({ phase: AgentTurnPhaseSchema, summary: z.string().min(1), refs: z.array(z.string()).default([]) }),
  }),
  envelope.extend({
    method: z.literal("turn/completed"),
    params: z.object({
      status: z.enum(["completed", "failed", "interrupted", "cancelled"]),
      outcome: AgentTurnOutcomeSchema.nullable().default(null), checkpointRef: z.string().nullable().default(null),
      error: z.string().nullable().default(null),
    }),
  }),
  envelope.extend({ method: z.literal("item/started"), params: z.object({ item: ScenarioAgentItemSchema }) }),
  envelope.extend({ method: z.literal("item/updated"), params: z.object({ item: ScenarioAgentItemSchema }) }),
  envelope.extend({ method: z.literal("item/completed"), params: z.object({ item: ScenarioAgentItemSchema }) }),
]);
export type ScenarioAgentEvent = z.infer<typeof ScenarioAgentEventSchema>;

export type ScenarioAgentEventDraft = Omit<ScenarioAgentEvent, "protocolVersion" | "id" | "sequence" | "createdAt"> & { createdAt?: string };

export class AgentEventProtocolError extends Error {
  constructor(readonly code: "unsupported_version" | "invalid_event" | "scope_mismatch" | "sequence_conflict" | "sequence_gap" | "buffer_capacity", message: string) {
    super(message); this.name = "AgentEventProtocolError";
  }
}

/** One decoder for durable reads and live deliveries. Unknown versions are never coerced. */
export function decodeScenarioAgentEvent(input: unknown): ScenarioAgentEvent {
  if (input && typeof input === "object" && "protocolVersion" in input && input.protocolVersion !== 2) {
    throw new AgentEventProtocolError("unsupported_version", "Unsupported Agent event protocol version");
  }
  const parsed = ScenarioAgentEventSchema.safeParse(input);
  if (!parsed.success) throw new AgentEventProtocolError("invalid_event", "Invalid Agent event envelope");
  return parsed.data;
}

export const AgentEventCursorSchema = z.object({
  version: z.literal(1), protocolVersion: z.literal(2), caseId: z.string().min(1).max(2048), runId: z.string().min(1).max(2048),
  sequence: z.number().int().nonnegative().safe(), eventId: z.string().min(1).max(2048).nullable(),
}).strict().refine((cursor) => (cursor.sequence === 0) === (cursor.eventId === null), "Cursor anchor mismatch");
export type AgentEventCursor = z.infer<typeof AgentEventCursorSchema>;

/** Bounded transport reader; emits facts only and has no command/tool execution port. */
export class AgentEventSequenceReader {
  private readonly pending = new Map<number, ScenarioAgentEvent>();
  private readonly recent = new Map<number, ScenarioAgentEvent>();
  private sequence: number;
  constructor(private readonly scope: { caseId: string; runId: string }, after = 0, private readonly capacity = 256) {
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(capacity) || capacity < 1 || capacity > 4096) throw new Error("Invalid Agent reader bounds");
    this.sequence = after;
  }
  get cursor(): number { return this.sequence; }
  accept(input: unknown): { status: "delivered" | "duplicate" | "stale" | "gap"; events: ScenarioAgentEvent[] } {
    const event = decodeScenarioAgentEvent(input);
    if (event.runId !== this.scope.runId || event.caseId !== this.scope.caseId) throw new AgentEventProtocolError("scope_mismatch", "Agent event belongs to a different Case/Run");
    const existing = this.recent.get(event.sequence) ?? this.pending.get(event.sequence);
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(event)) throw new AgentEventProtocolError("sequence_conflict", "Conflicting event at the same sequence");
      return { status: "duplicate", events: [] };
    }
    if ([...this.recent.values(), ...this.pending.values()].some((other) => other.id === event.id)) throw new AgentEventProtocolError("sequence_conflict", "Event identity reused at another sequence");
    // Outside the verification window: require durable cursor replay for historical integrity.
    if (event.sequence <= this.sequence) return { status: "stale", events: [] };
    if (event.sequence - this.sequence > this.capacity || this.pending.size >= this.capacity) throw new AgentEventProtocolError("buffer_capacity", "Agent event gap exceeds the bounded replay window");
    this.pending.set(event.sequence, event);
    const events: ScenarioAgentEvent[] = [];
    while (this.pending.has(this.sequence + 1)) {
      const next = this.pending.get(++this.sequence)!;
      this.pending.delete(this.sequence); this.recent.set(this.sequence, next); events.push(next);
      if (this.recent.size > this.capacity) this.recent.delete(this.recent.keys().next().value!);
    }
    return { status: events.length ? "delivered" : "gap", events };
  }
}
