import { describe, it, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { makeRecordFactTool, makeRecordActionTool } from "./case-tools.js";
import { type Fact, type ActionCard, FactSchema } from "@traceforge/shared";
import type { RuntimeEvent } from "@traceforge/shared";

// 内存 store 假实现（满足结构接口）
function memFacts() {
  const arr: Fact[] = [];
  return {
    create: (caseId: string, input: Omit<Fact, "id" | "caseId" | "createdAt">) => {
      const f = FactSchema.parse({ ...input, id: `fact_${randomUUID()}`, caseId, createdAt: "now" });
      arr.push(f); return f;
    },
    listByCase: (caseId: string) => arr.filter((f) => f.caseId === caseId),
    _arr: arr,
  };
}
const memTimeline = { append: (_c: string, _e: string, _d: string, _r?: string) => ({ id: "tl", caseId: "c", eventType: "x", refId: null, detail: "", createdAt: "now" }) };

describe("makeRecordFactTool", () => {
  it("writes a fact, appends timeline, emits event", async () => {
    const facts = memFacts();
    const tlSpy = vi.spyOn(memTimeline, "append");
    const events: RuntimeEvent[] = [];
    const tool = makeRecordFactTool("c", facts, memTimeline, (e) => events.push(e));
    expect(tool.risk).toBe("normal");
    const res = await tool.execute({ type: "graphql_endpoint", title: "gql", value: { url: "x" } });
    expect(res.ok).toBe(true);
    expect(facts._arr).toHaveLength(1);
    expect(facts._arr[0].source.type).toBe("ai");
    expect(tlSpy).toHaveBeenCalled();
    expect(events.some((e) => e.type === "fact_created")).toBe(true);
  });
});

describe("makeRecordActionTool", () => {
  it("rejects an action with evidenceRefs not pointing to known facts", async () => {
    const facts = memFacts(); // 空，无 fact
    const actions = { create: (a: ActionCard) => a };
    const decisions = { create: () => ({}) };
    const events: RuntimeEvent[] = [];
    const tool = makeRecordActionTool("c", facts, actions, decisions, memTimeline, (e) => events.push(e));
    const res = await tool.execute({ title: "x", goal: "g", evidenceRefs: ["fact_ghost"], reasoning: "r", steps: ["s"], tool: "http_replay" });
    expect(res.ok).toBe(false);
    expect(res.content).toMatch(/evidence/i);
  });

  it("records an action when evidenceRefs are valid known facts", async () => {
    const facts = memFacts();
    const f = facts.create("c", { type: "api_endpoint", title: "api", value: {}, source: { type: "ai", ref: "r" }, confidence: 1, tags: [] });
    const stored: ActionCard[] = [];
    const actions = { create: (a: ActionCard) => { stored.push(a); return a; } };
    let decisionMade = false;
    const decisions = { create: () => { decisionMade = true; return {}; } };
    const events: RuntimeEvent[] = [];
    const tool = makeRecordActionTool("c", facts, actions, decisions, memTimeline, (e) => events.push(e));
    const res = await tool.execute({ title: "probe", goal: "g", evidenceRefs: [f.id], reasoning: "r", steps: ["s"], tool: "http_replay" });
    expect(res.ok).toBe(true);
    expect(stored).toHaveLength(1);
    expect(decisionMade).toBe(true);
    expect(events.some((e) => e.type === "action_recorded")).toBe(true);
  });
});
