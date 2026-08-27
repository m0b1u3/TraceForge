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
  }),
]);
export type ScenarioAgentItem = z.infer<typeof ScenarioAgentItemSchema>;

const envelope = z.object({
  protocolVersion: z.literal(2), id: z.string().min(1), sequence: z.number().int().positive(),
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
