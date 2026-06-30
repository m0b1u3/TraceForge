import { describe, it, expect } from "vitest";
import { AgentRunSchema } from "./schemas.js";
import type { RuntimeEvent } from "./events.js";

describe("AgentRunSchema", () => {
  it("parses a running agent run with nullable terminal fields", () => {
    const run = AgentRunSchema.parse({
      id: "run_1",
      caseId: "case_1",
      goal: "inspect target",
      status: "running",
      createdAt: "2026-06-30T00:00:00.000Z",
    });
    expect(run.startedAt).toBeNull();
    expect(run.finishedAt).toBeNull();
    expect(run.interruptReason).toBeNull();
    expect(run.error).toBeNull();
  });

  it("rejects status values outside the system state machine", () => {
    expect(() => AgentRunSchema.parse({
      id: "run_1",
      caseId: "case_1",
      goal: "x",
      status: "thinking",
      createdAt: "t",
    })).toThrow();
  });
});

describe("agent run RuntimeEvent typing", () => {
  it("accepts the new streaming event shapes", () => {
    const event: RuntimeEvent = {
      type: "agent_stream_delta",
      caseId: "case_1",
      runId: "run_1",
      messageId: "msg_1",
      delta: "hello",
    };
    expect(event.delta).toBe("hello");
  });
});
