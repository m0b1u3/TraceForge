import { describe, expect, it } from "vitest";
import type { ScenarioAgentEvent } from "@traceforge/shared";
import { createAgentProtocolProjection, mergeAgentProtocolEvents, orderedAgentProtocolTurns } from "./agent-runtime-projection.js";

const base = {
  protocolVersion: 1 as const,
  runId: "run_1",
  caseId: "case_1",
  workId: "work_1",
  turnId: "turn_1",
  role: "worker" as const,
  createdAt: "2026-08-25T12:00:00.000Z",
};

function events(): ScenarioAgentEvent[] {
  return [
    { ...base, id: "event_1", sequence: 1, method: "turn/started", params: { sourceRunRevision: 2, sourceGraphRevision: 4 } },
    { ...base, id: "event_2", sequence: 2, method: "item/started", params: { item: { type: "toolCall", id: "tool_1", tool: "http.request", status: "inProgress", risk: "read_only", summary: null, refs: [] } } },
    { ...base, id: "event_3", sequence: 3, method: "item/completed", params: { item: { type: "toolCall", id: "tool_1", tool: "http.request", status: "completed", risk: "read_only", summary: "Observed response", refs: ["evidence:1"] } } },
    { ...base, id: "event_4", sequence: 4, method: "turn/completed", params: { status: "completed", error: null } },
  ];
}

describe("Agent protocol projection", () => {
  it("reconstructs Turns and items from canonical sequence order", () => {
    const projection = mergeAgentProtocolEvents(createAgentProtocolProjection("run_1"), events());
    expect(projection.cursor).toBe(4);
    expect(orderedAgentProtocolTurns(projection)).toEqual([
      expect.objectContaining({
        id: "turn_1", role: "worker", status: "completed", sourceRunRevision: 2, sourceGraphRevision: 4,
        items: { tool_1: expect.objectContaining({ completedAt: base.createdAt, value: expect.objectContaining({ status: "completed", refs: ["evidence:1"] }) }) },
      }),
    ]);
  });

  it("buffers out-of-order WebSocket events until replay fills the gap and ignores duplicates", () => {
    const [started, itemStarted, itemCompleted, completed] = events();
    const withGap = mergeAgentProtocolEvents(createAgentProtocolProjection("run_1"), [itemCompleted, completed]);
    expect(withGap.cursor).toBe(0);
    expect(Object.keys(withGap.pending)).toEqual(["3", "4"]);

    const recovered = mergeAgentProtocolEvents(withGap, [started, itemStarted, itemCompleted]);
    expect(recovered.cursor).toBe(4);
    expect(recovered.pending).toEqual({});
    expect(recovered.turnOrder).toEqual(["turn_1"]);
  });

  it("does not merge events from a different Run", () => {
    const foreign = { ...events()[0], id: "foreign", runId: "run_2" };
    expect(mergeAgentProtocolEvents(createAgentProtocolProjection("run_1"), [foreign])).toEqual(createAgentProtocolProjection("run_1"));
  });
});
