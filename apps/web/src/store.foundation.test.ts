import { beforeEach, describe, expect, it } from "vitest";
import { createAgentProtocolProjection } from "./agent-runtime-projection.js";
import { runtimeWebSocketUrl, useStore } from "./store.js";

beforeEach(() => useStore.setState({
  caseId: "case_1", cases: [], agentProtocol: createAgentProtocolProjection("run_1"),
  agentProtocolSyncStatus: "live", connectionStatus: "offline", toast: null,
}));

describe("foundation store", () => {
  it("selects the correct WebSocket scheme", () => {
    expect(runtimeWebSocketUrl({ protocol: "https:", host: "traceforge.example" } as Location)).toBe("wss://traceforge.example/ws");
  });

  it("projects only protocol events belonging to the active Case and Run", () => {
    const started = {
      protocolVersion: 1 as const, id: "event_1", sequence: 1, runId: "run_1", caseId: "case_1",
      workId: null, turnId: "turn_1", role: "planner" as const, createdAt: "2026-08-25T12:00:00.000Z",
      method: "turn/started" as const, params: { sourceRunRevision: 1, sourceGraphRevision: null },
    };
    useStore.getState().handleRuntimeEvent({ type: "scenario_agent_event", event: started });
    expect(useStore.getState().agentProtocol?.cursor).toBe(1);
    useStore.getState().handleRuntimeEvent({ type: "scenario_agent_event", event: { ...started, id: "foreign", sequence: 2, caseId: "case_2" } });
    expect(useStore.getState().agentProtocol?.cursor).toBe(1);
  });
});
