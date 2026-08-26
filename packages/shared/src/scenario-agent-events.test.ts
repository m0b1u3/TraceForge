import { describe, expect, it } from "vitest";
import { ScenarioAgentEventSchema } from "./scenario-agent-events.js";

describe("ScenarioAgentEventSchema", () => {
  it("parses a versioned authoritative item lifecycle event", () => {
    const event = ScenarioAgentEventSchema.parse({
      protocolVersion: 1,
      id: "event_1",
      sequence: 1,
      runId: "run_1",
      caseId: "case_1",
      workId: "work_1",
      turnId: "snapshot_1",
      role: "worker",
      method: "item/completed",
      createdAt: "2026-08-25T12:00:00.000Z",
      params: {
        item: {
          type: "toolCall",
          id: "invocation_1",
          tool: "http_request",
          status: "completed",
          risk: "read_only",
          summary: "Observation persisted",
          refs: ["evidence_1"],
        },
      },
    });
    expect(event.method).toBe("item/completed");
    if (event.method === "item/completed") expect(event.params.item.status).toBe("completed");
  });

  it("rejects unknown protocol versions and non-terminal completed items", () => {
    expect(() => ScenarioAgentEventSchema.parse({
      protocolVersion: 2, id: "event_1", sequence: 1, runId: "run_1", caseId: "case_1",
      workId: null, turnId: "turn_1", role: "planner", method: "turn/completed",
      createdAt: "2026-08-25T12:00:00.000Z", params: { status: "running", error: null },
    })).toThrow();
  });
});
