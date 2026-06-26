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
    const res = await tool.execute({ title: "urgent task", priority: "critical" });
    expect(res.ok).toBe(true);
    expect(tk.created[0].priority).toBe("high");
  });

  it("maps an out-of-enum status to open instead of crashing", async () => {
    const tk = mkTasks();
    const tool = makeRecordTaskTool("c", tk.writer, timeline, noop);
    const res = await tool.execute({ title: "weird status", status: "maybe" });
    expect(res.ok).toBe(true);
    expect(tk.created[0].status).toBe("open");
  });

  it("keeps a valid priority/status as-is", async () => {
    const tk = mkTasks();
    const tool = makeRecordTaskTool("c", tk.writer, timeline, noop);
    await tool.execute({ title: "t", priority: "low", status: "blocked" });
    expect(tk.created[0].priority).toBe("low");
    expect(tk.created[0].status).toBe("blocked");
  });
});
