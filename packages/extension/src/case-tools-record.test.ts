import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { makeRecordFactTool, makeRecordActionTool } from "./case-tools.js";
import { type Fact, type ActionCard, FactSchema } from "@traceforge/shared";
import type { RuntimeEvent } from "@traceforge/shared";

// 内存 store 假实现（满足结构接口）
function memFacts() {
  const arr: Fact[] = [];
  return {
    create: (caseId: string, input: Omit<Fact, "id" | "caseId" | "createdAt" | "updateCount" | "updatedAt" | "validity">) => {
      const f = FactSchema.parse({ ...input, id: `fact_${randomUUID()}`, caseId, createdAt: "now" });
      arr.push(f); return f;
    },
    listByCase: (caseId: string) => arr.filter((f) => f.caseId === caseId),
    getById: (id: string) => arr.find((f) => f.id === id),
    update: (id: string, patch: Partial<Fact>) => {
      const i = arr.findIndex((f) => f.id === id); if (i === -1) return undefined;
      arr[i] = { ...arr[i], ...patch, updateCount: arr[i].updateCount + 1 } as Fact; return arr[i];
    },
    _arr: arr,
  };
}
function makeTimeline() {
  const entries: Array<{ id: string; caseId: string; eventType: string; refId: string | null; detail: string; createdAt: string }> = [];
  return {
    entries,
    append: (caseId: string, eventType: string, detail: string, refId?: string) => {
      const entry = { id: `tl_${entries.length + 1}`, caseId, eventType, refId: refId ?? null, detail, createdAt: "now" };
      entries.push(entry);
      return entry;
    },
  };
}

describe("makeRecordFactTool", () => {
  it("writes a fact, appends timeline, emits event", async () => {
    const facts = memFacts();
    const timeline = makeTimeline();
    const events: RuntimeEvent[] = [];
    const tool = makeRecordFactTool("c", facts, timeline, (e) => events.push(e));
    expect(tool.security).toMatchObject({ impactScope: "case", mutates: true });
    const res = await tool.execute({ type: "graphql_endpoint", title: "gql", value: { url: "x" } });
    expect(res.ok).toBe(true);
    expect(facts._arr).toHaveLength(1);
    expect(facts._arr[0].source.type).toBe("ai");
    expect(timeline.entries).toHaveLength(1);
    expect(events.some((e) => e.type === "fact_created")).toBe(true);
  });
});

describe("makeRecordActionTool", () => {
  it("rejects an action with evidenceRefs not pointing to known facts", async () => {
    const facts = memFacts(); // 空，无 fact
    const actions = { create: (a: ActionCard) => a };
    const decisions = { create: () => ({}) };
    const events: RuntimeEvent[] = [];
    const tool = makeRecordActionTool("c", facts, actions, decisions, makeTimeline(), (e) => events.push(e));
    const res = await tool.execute({ title: "x", goal: "g", evidenceRefs: ["fact_ghost"], reasoning: "r", steps: ["s"], tool: "http_replay" });
    expect(res.ok).toBe(false);
    expect(res.content).toMatch(/evidence/i);
  });

  it("records an action when evidence and cognitive references are present", async () => {
    const facts = memFacts();
    const f = facts.create("c", { type: "api_endpoint", title: "api", value: {}, source: { type: "ai", ref: "r" }, confidence: 1, tags: [] });
    const stored: ActionCard[] = [];
    const actions = { create: (a: ActionCard) => { stored.push(a); return a; } };
    let decisionMade = false;
    const decisions = { create: () => { decisionMade = true; return {}; } };
    const events: RuntimeEvent[] = [];
    const tool = makeRecordActionTool("c", facts, actions, decisions, makeTimeline(), (e) => events.push(e));
    const res = await tool.execute({
      title: "probe",
      goal: "g",
      evidenceRefs: [f.id],
      hypothesisRefs: ["hyp_1"],
      taskRefs: ["task_1"],
      reasoning: "r",
      steps: ["s"],
      tool: "http_replay",
    });
    expect(res.ok).toBe(true);
    expect(stored).toHaveLength(1);
    expect(decisionMade).toBe(true);
    expect(events.some((e) => e.type === "action_recorded")).toBe(true);
  });
});
