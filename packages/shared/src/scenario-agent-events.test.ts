import { describe, expect, it } from "vitest";
import { AgentEventCursorSchema, AgentEventSequenceReader, decodeScenarioAgentEvent, ScenarioAgentEventSchema } from "./scenario-agent-events.js";

describe("ScenarioAgentEventSchema", () => {
  it("parses a versioned authoritative item lifecycle event", () => {
    const event = ScenarioAgentEventSchema.parse({
      protocolVersion: 2,
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
      protocolVersion: 1, id: "event_1", sequence: 1, runId: "run_1", caseId: "case_1",
      workId: null, turnId: "turn_1", role: "planner", method: "turn/completed",
      createdAt: "2026-08-25T12:00:00.000Z", params: { status: "running", error: null },
    })).toThrow();
  });
});

const fact = (sequence: number) => ({ protocolVersion:2,id:`event_${sequence}`,sequence,runId:"run",caseId:"case",workId:null,
  turnId:"turn",role:"system",createdAt:"2026-08-31T00:00:00.000Z",method:"turn/completed",params:{status:"completed",outcome:null,checkpointRef:null,error:null} });

describe("bounded Agent protocol reader", () => {
  it("orders reconnect deliveries and emits each recent event once", () => {
    const reader = new AgentEventSequenceReader({caseId:"case",runId:"run"});
    expect(reader.accept(fact(2))).toEqual({status:"gap",events:[]});
    expect(reader.cursor).toBe(0);
    expect(reader.accept(fact(1)).events.map((event) => event.sequence)).toEqual([1,2]);
    expect(reader.accept(fact(2))).toEqual({status:"duplicate",events:[]});
    expect(reader.cursor).toBe(2);
  });
  it.each(["caseId","runId"])("rejects a foreign %s without advancing", (field) => {
    const reader = new AgentEventSequenceReader({caseId:"case",runId:"run"});
    expect(() => reader.accept({...fact(1),[field]:"other"})).toThrow("different Case/Run");
    expect(reader.cursor).toBe(0);
  });
  it("rejects unsupported versions and malformed envelopes separately", () => {
    expect(() => decodeScenarioAgentEvent({...fact(1),protocolVersion:3})).toThrow("Unsupported");
    expect(() => decodeScenarioAgentEvent({...fact(1),sequence:1.5})).toThrow("Invalid");
    expect(() => decodeScenarioAgentEvent({...fact(1),sequence:Number.MAX_SAFE_INTEGER+1})).toThrow("Invalid");
  });
  it.each(["pending","delivered"])("rejects conflicting %s duplicates", (state) => {
    const reader = new AgentEventSequenceReader({caseId:"case",runId:"run"});
    const event = fact(state==="pending" ? 2 : 1);
    reader.accept(event);
    expect(() => reader.accept({...event,id:"different"})).toThrow("Conflicting");
    expect(() => reader.accept({...event,params:{...event.params,error:"changed"}})).toThrow("Conflicting");
  });
  it("rejects reuse of an event ID at another sequence", () => {
    const reader = new AgentEventSequenceReader({caseId:"case",runId:"run"}); reader.accept(fact(1));
    expect(() => reader.accept({...fact(2),id:"event_1"})).toThrow("identity reused");
  });
  it("bounds buffering and labels unverifiable old deliveries as stale", () => {
    const reader = new AgentEventSequenceReader({caseId:"case",runId:"run"},0,2);
    expect(() => reader.accept(fact(3))).toThrow("bounded replay");
    [1,2,3].forEach((n) => reader.accept(fact(n)));
    expect(reader.accept(fact(1)).status).toBe("stale");
  });
  it("validates cursor version and event anchor", () => {
    const cursor = {version:1,protocolVersion:2,caseId:"case",runId:"run",sequence:1,eventId:"event_1"};
    expect(AgentEventCursorSchema.parse(cursor)).toEqual(cursor);
    for (const changed of [{version:2},{protocolVersion:3},{sequence:0},{eventId:null},{sequence:-1}]) {
      expect(AgentEventCursorSchema.safeParse({...cursor,...changed}).success).toBe(false);
    }
  });
});
