import { describe, it, expect } from "vitest";
import { AgentEventSchema, type AgentEvent } from "./schemas.js";

describe("AgentEventSchema", () => {
  it("parses a tool_call event with a tool name", () => {
    const e: AgentEvent = AgentEventSchema.parse({
      id: "ae_1",
      caseId: "c1",
      kind: "tool_call",
      text: "record_fact({...})",
      tool: "record_fact",
      createdAt: "2026-06-26T00:00:00.000Z",
    });
    expect(e.kind).toBe("tool_call");
    expect(e.tool).toBe("record_fact");
  });

  it("defaults tool to null for text events", () => {
    const e = AgentEventSchema.parse({
      id: "ae_2",
      caseId: "c1",
      kind: "text",
      text: "thinking",
      createdAt: "2026-06-26T00:00:00.000Z",
    });
    expect(e.tool).toBeNull();
  });

  it("rejects an unknown kind", () => {
    expect(() =>
      AgentEventSchema.parse({ id: "x", caseId: "c1", kind: "bogus", text: "", createdAt: "t" }),
    ).toThrow();
  });

  it("parses refs linking an event to the knowledge it produced", () => {
    const e = AgentEventSchema.parse({
      id: "ae_3",
      caseId: "c1",
      kind: "tool_result",
      text: "record_fact → ok",
      tool: "record_fact",
      refs: { factIds: ["fact_1"], taskIds: [], timelineEntryIds: ["tl_1"] },
      createdAt: "2026-06-26T00:00:00.000Z",
    });
    expect(e.refs).toEqual({ factIds: ["fact_1"], taskIds: [], timelineEntryIds: ["tl_1"] });
  });

  it("defaults refs to null when absent", () => {
    const e = AgentEventSchema.parse({
      id: "ae_4",
      caseId: "c1",
      kind: "tool_call",
      text: "get_traffic(...)",
      createdAt: "2026-06-26T00:00:00.000Z",
    });
    expect(e.refs).toBeNull();
  });
});
