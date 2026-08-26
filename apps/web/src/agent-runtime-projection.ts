import type { ScenarioAgentEvent, ScenarioAgentItem, ScenarioAgentRole } from "@traceforge/shared";

export type AgentProtocolTurnStatus = "running" | "completed" | "failed" | "interrupted" | "cancelled";

export interface AgentProtocolItemProjection {
  id: string;
  value: ScenarioAgentItem;
  startedAt: string | null;
  updatedAt: string;
  completedAt: string | null;
  lastSequence: number;
}

export interface AgentProtocolTurnProjection {
  id: string;
  runId: string;
  caseId: string;
  workId: string | null;
  role: ScenarioAgentRole;
  status: AgentProtocolTurnStatus;
  sourceRunRevision: number | null;
  sourceGraphRevision: number | null;
  startedAt: string;
  completedAt: string | null;
  error: string | null;
  itemOrder: string[];
  items: Record<string, AgentProtocolItemProjection>;
}

export interface AgentProtocolProjection {
  runId: string;
  cursor: number;
  turnOrder: string[];
  turns: Record<string, AgentProtocolTurnProjection>;
  pending: Record<number, ScenarioAgentEvent>;
}

export function createAgentProtocolProjection(runId: string): AgentProtocolProjection {
  return { runId, cursor: 0, turnOrder: [], turns: {}, pending: {} };
}

function createTurn(event: ScenarioAgentEvent): AgentProtocolTurnProjection {
  return {
    id: event.turnId,
    runId: event.runId,
    caseId: event.caseId,
    workId: event.workId,
    role: event.role,
    status: "running",
    sourceRunRevision: event.method === "turn/started" ? event.params.sourceRunRevision : null,
    sourceGraphRevision: event.method === "turn/started" ? event.params.sourceGraphRevision : null,
    startedAt: event.createdAt,
    completedAt: null,
    error: null,
    itemOrder: [],
    items: {},
  };
}

function applyEvent(projection: AgentProtocolProjection, event: ScenarioAgentEvent): AgentProtocolProjection {
  const currentTurn = projection.turns[event.turnId] ?? createTurn(event);
  let turn = currentTurn;
  if (event.method === "turn/started") {
    turn = {
      ...turn,
      role: event.role,
      workId: event.workId,
      sourceRunRevision: event.params.sourceRunRevision,
      sourceGraphRevision: event.params.sourceGraphRevision,
      startedAt: event.createdAt,
    };
  } else if (event.method === "turn/completed") {
    turn = { ...turn, status: event.params.status, completedAt: event.createdAt, error: event.params.error };
  } else {
    const item = event.params.item;
    const existing = turn.items[item.id];
    turn = {
      ...turn,
      itemOrder: existing ? turn.itemOrder : [...turn.itemOrder, item.id],
      items: {
        ...turn.items,
        [item.id]: {
          id: item.id,
          value: item,
          startedAt: existing?.startedAt ?? (event.method === "item/started" ? event.createdAt : null),
          updatedAt: event.createdAt,
          completedAt: event.method === "item/completed" ? event.createdAt : existing?.completedAt ?? null,
          lastSequence: event.sequence,
        },
      },
    };
  }
  return {
    ...projection,
    turnOrder: projection.turns[event.turnId] ? projection.turnOrder : [...projection.turnOrder, event.turnId],
    turns: { ...projection.turns, [event.turnId]: turn },
  };
}

/**
 * Merge replay and WebSocket deliveries into one deterministic projection.
 * Events beyond a sequence gap wait in `pending` until replay fills the gap.
 */
export function mergeAgentProtocolEvents(
  current: AgentProtocolProjection,
  incoming: readonly ScenarioAgentEvent[],
): AgentProtocolProjection {
  const pending = { ...current.pending };
  for (const event of incoming) {
    if (event.runId !== current.runId || event.sequence <= current.cursor) continue;
    pending[event.sequence] ??= event;
  }
  let next = { ...current, pending };
  while (next.pending[next.cursor + 1]) {
    const sequence = next.cursor + 1;
    const event = next.pending[sequence];
    const remaining = { ...next.pending };
    delete remaining[sequence];
    next = applyEvent({ ...next, cursor: sequence, pending: remaining }, event);
  }
  return next;
}

export function orderedAgentProtocolTurns(projection: AgentProtocolProjection | null): AgentProtocolTurnProjection[] {
  if (!projection) return [];
  return projection.turnOrder.map((id) => projection.turns[id]).filter(Boolean);
}
