import { describe, it, expect } from "vitest";
import { makeRecordTaskTool } from "./case-tools.js";
import type { Task } from "@traceforge/shared";

function mkTasks() {
  const created: Task[] = [];
  return {
    created,
    writer: {
      create: (caseId: string, input: Omit<Task, "id" | "caseId" | "createdAt" | "updatedAt" | "updateCount">) => {
        const t = { ...input, id: `task_${created.length}`, caseId, createdAt: "t", updatedAt: "t", updateCount: 0 } as Task;
        created.push(t);
        return t;
      },
      listByCase: (caseId: string) => created.filter((task) => task.caseId === caseId),
      getById: () => undefined,
      update: () => undefined,
    },
  };
}
const timeline = { append: (_c: string, _e: string, d: string, r?: string) => ({ id: "tl", caseId: "c", eventType: "x", detail: d, refId: r ?? null, createdAt: "t" }) };
const noop = () => {};

describe("makeRecordTaskTool normalization", () => {
  it("maps an out-of-enum priority (critical) to high instead of crashing", async () => {
    const tk = mkTasks();
    const tool = makeRecordTaskTool("c", tk.writer, timeline, noop);
    const res = await tool.execute({ title: "urgent task", priority: "critical", hypothesisIds: ["hyp_1"] });
    expect(res.ok).toBe(true);
    expect(tk.created[0].priority).toBe("high");
  });

  it("maps an out-of-enum status to open instead of crashing", async () => {
    const tk = mkTasks();
    const tool = makeRecordTaskTool("c", tk.writer, timeline, noop);
    const res = await tool.execute({ title: "weird status", status: "maybe", hypothesisIds: ["hyp_1"] });
    expect(res.ok).toBe(true);
    expect(tk.created[0].status).toBe("open");
  });

  it("keeps a valid priority/status as-is", async () => {
    const tk = mkTasks();
    const tool = makeRecordTaskTool("c", tk.writer, timeline, noop);
    await tool.execute({ title: "t", priority: "low", status: "blocked", hypothesisIds: ["hyp_1"] });
    expect(tk.created[0].priority).toBe("low");
    expect(tk.created[0].status).toBe("blocked");
  });
  it("reuses an equivalent relationship-gated task instead of creating a duplicate", async () => {
    const tk = mkTasks();
    const existing = tk.writer.create("c", {
      runId: "run_1", title: "Replay privileged request", status: "blocked", reason: "waiting",
      blockedBy: [], triggerWhen: [], relatedFacts: [], hypothesisIds: ["hyp_1"], priority: "high",
      relationshipGate: { blockedHypothesisIds: ["hyp_1"], resumeStatus: "approved", priorReason: "ready" },
    });
    const tool = makeRecordTaskTool("c", tk.writer, timeline, noop, "run_1");
    const result = await tool.execute({ title: " replay privileged request ", hypothesisIds: ["hyp_1"] });
    expect(result.ok).toBe(true);
    expect(result.content).toContain(existing.id);
    expect(result.content).toContain("relationship-gated");
    expect(tk.created).toHaveLength(1);
  });
});
