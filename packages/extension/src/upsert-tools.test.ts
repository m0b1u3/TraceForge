import { describe, it, expect } from "vitest";
import { makeRecordFactTool, makeRecordTaskTool } from "./case-tools.js";
import type { Fact, Task, RuntimeEvent } from "@traceforge/shared";

function mkFacts() {
  const map = new Map<string, Fact>();
  let n = 0;
  return {
    map,
    writer: {
      create: (caseId: string, input: Omit<Fact, "id" | "caseId" | "createdAt" | "updateCount" | "updatedAt" | "validity"> & Partial<Pick<Fact, "validity">>) => {
        const f = { ...input, validity: input.validity ?? "valid", id: `fact_${n++}`, caseId, createdAt: "t", updateCount: 0, updatedAt: "t" } as Fact;
        map.set(f.id, f); return f;
      },
      listByCase: () => [...map.values()],
      getById: (id: string) => map.get(id),
      update: (id: string, patch: Partial<Fact>) => {
        const cur = map.get(id); if (!cur) return undefined;
        const next = { ...cur, ...patch, updateCount: cur.updateCount + 1 } as Fact;
        map.set(id, next); return next;
      },
    },
  };
}
const timeline = { append: (_c: string, _e: string, d: string, r?: string) => ({ id: "tl", caseId: "c", eventType: "x", detail: d, refId: r ?? null, createdAt: "t" }) };

describe("makeRecordFactTool upsert", () => {
  it("no id → create (updateCount 0), emits fact_created", async () => {
    const fx = mkFacts(); const evs: RuntimeEvent[] = [];
    const tool = makeRecordFactTool("c", fx.writer, timeline, (e) => evs.push(e));
    const res = await tool.execute({ type: "endpoint", title: "a" });
    expect(res.ok).toBe(true);
    expect(evs.some((e) => e.type === "fact_created")).toBe(true);
  });

  it("with known id → update, bumps count, emits fact_updated", async () => {
    const fx = mkFacts(); const evs: RuntimeEvent[] = [];
    const tool = makeRecordFactTool("c", fx.writer, timeline, (e) => evs.push(e));
    await tool.execute({ type: "endpoint", title: "a" });
    const id = [...fx.map.keys()][0];
    const res = await tool.execute({ id, type: "endpoint", title: "a2", confidence: 0.7 });
    expect(res.ok).toBe(true);
    expect(fx.map.get(id)?.updateCount).toBe(1);
    expect(fx.map.get(id)?.title).toBe("a2");
    expect(evs.some((e) => e.type === "fact_updated")).toBe(true);
  });

  it("with unknown id → ok:false", async () => {
    const fx = mkFacts();
    const tool = makeRecordFactTool("c", fx.writer, timeline, () => {});
    const res = await tool.execute({ id: "ghost", type: "x", title: "y" });
    expect(res.ok).toBe(false);
  });
});

function mkTasks() {
  const map = new Map<string, Task>();
  let n = 0;
  return {
    map,
    writer: {
      create: (caseId: string, input: Omit<Task, "id" | "caseId" | "createdAt" | "updatedAt" | "updateCount">) => {
        const t = { ...input, id: `task_${n++}`, caseId, createdAt: "t", updatedAt: "t", updateCount: 0 } as Task;
        map.set(t.id, t); return t;
      },
      getById: (id: string) => map.get(id),
      update: (id: string, patch: Partial<Task>) => {
        const cur = map.get(id); if (!cur) return undefined;
        const next = { ...cur, ...patch, updateCount: cur.updateCount + 1 } as Task;
        map.set(id, next); return next;
      },
    },
  };
}

describe("makeRecordTaskTool upsert", () => {
  it("with known id → update + task_updated", async () => {
    const tx = mkTasks(); const evs: RuntimeEvent[] = [];
    const tool = makeRecordTaskTool("c", tx.writer, timeline, (e) => evs.push(e));
    await tool.execute({ title: "a", hypothesisIds: ["hyp_1"] });
    const id = [...tx.map.keys()][0];
    const res = await tool.execute({ id, title: "a2", status: "blocked" });
    expect(res.ok).toBe(true);
    expect(tx.map.get(id)?.updateCount).toBe(1);
    expect(evs.some((e) => e.type === "task_updated")).toBe(true);
  });
  it("unknown id → ok:false", async () => {
    const tx = mkTasks();
    const tool = makeRecordTaskTool("c", tx.writer, timeline, () => {});
    expect((await tool.execute({ id: "ghost", title: "x" })).ok).toBe(false);
  });
});
