import { describe, it, expect } from "vitest";
import { AgentRunSchema, AgentRunStatusSchema } from "./schemas.js";
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
    expect(run.completionReason).toBeNull();
    expect(run.error).toBeNull();
  });

  it("accepts needs_continuation as an agent run status", () => {
    expect(AgentRunStatusSchema.parse("needs_continuation")).toBe("needs_continuation");
  });

  it("defaults completionReason to null for older run payloads", () => {
    const run = AgentRunSchema.parse({
      id: "run_1",
      caseId: "case_1",
      goal: "inspect target",
      status: "queued",
      createdAt: "2026-06-30T00:00:00.000Z",
    });

    expect(run.completionReason).toBeNull();
  });

  it("preserves completionReason when present", () => {
    const run = AgentRunSchema.parse({
      id: "run_1",
      caseId: "case_1",
      goal: "inspect target",
      status: "needs_continuation",
      createdAt: "2026-06-30T00:00:00.000Z",
      completionReason: "run budget exhausted after 2 turns",
    });

    expect(run.completionReason).toBe("run budget exhausted after 2 turns");
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

  it("accepts agent run needs continuation events", () => {
    const event: RuntimeEvent = {
      type: "agent_run_needs_continuation",
      reason: "run budget exhausted after 2 turns",
      run: {
        id: "run_1",
        caseId: "case_1",
        goal: "inspect target",
        status: "needs_continuation",
        createdAt: "2026-06-30T00:00:00.000Z",
        startedAt: null,
        finishedAt: "2026-06-30T00:01:00.000Z",
        interruptReason: null,
        completionReason: "run budget exhausted after 2 turns",
        error: null,
      },
    };
    expect(event.reason).toContain("budget");
  });
});
