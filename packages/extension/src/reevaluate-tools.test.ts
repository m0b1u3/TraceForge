import { describe, it, expect } from "vitest";
import { makeReopenTaskTool, type TaskStatusReader, type StatusWriter } from "./case-tools.js";
import type { Fact, Task } from "@traceforge/shared";

function mkFacts(ids: string[]) {
  const list = ids.map((id) => ({ id, caseId: "c" }) as Fact);
  return { listByCase: () => list, create: () => ({}) as Fact };
}
function mkTasks(rows: Array<{ id: string; title: string; status: string }>) {
  const map = new Map(rows.map((r) => [r.id, { ...r }]));
  const updates: Array<{ id: string; status: string; reason: string }> = [];
  const reader: TaskStatusReader = { getById: (id) => map.get(id) };
  const writer: StatusWriter = {
    updateStatus: (id, status, reason) => {
      updates.push({ id, status, reason });
      const r = map.get(id); if (!r) return undefined;
      return { id, caseId: "c", title: r.title, status };
    },
  };
  return { reader, writer, updates };
}
const timeline = { append: (_c: string, _e: string, d: string, r?: string) => ({ id: "tl", caseId: "c", eventType: "x", detail: d, refId: r ?? null, createdAt: "t" }) };
const noop = () => {};

describe("makeReopenTaskTool", () => {
  it("is normal risk", () => {
    const t = makeReopenTaskTool("c", mkTasks([]).reader, mkTasks([]).writer, mkFacts([]), timeline, noop);
    expect(t.risk).toBe("normal");
    expect(t.name).toBe("reopen_task");
  });

  it("reopens a blocked task to recheck_candidate", async () => {
    const tk = mkTasks([{ id: "task_1", title: "测后台接口", status: "blocked" }]);
    const tool = makeReopenTaskTool("c", tk.reader, tk.writer, mkFacts(["f1"]), timeline, noop);
    const res = await tool.execute({ taskId: "task_1", reason: "已获凭据", evidenceRefs: ["f1"] });
    expect(res.ok).toBe(true);
    expect(tk.updates).toEqual([{ id: "task_1", status: "recheck_candidate", reason: "已获凭据" }]);
  });

  it("rejects a missing taskId", async () => {
    const tk = mkTasks([]);
    const tool = makeReopenTaskTool("c", tk.reader, tk.writer, mkFacts(["f1"]), timeline, noop);
    const res = await tool.execute({ taskId: "nope", reason: "x", evidenceRefs: ["f1"] });
    expect(res.ok).toBe(false);
    expect(res.content).toMatch(/not found/i);
  });

  it("rejects empty or unknown evidenceRefs", async () => {
    const tk = mkTasks([{ id: "task_1", title: "t", status: "blocked" }]);
    const tool = makeReopenTaskTool("c", tk.reader, tk.writer, mkFacts(["f1"]), timeline, noop);
    expect((await tool.execute({ taskId: "task_1", reason: "x", evidenceRefs: [] })).ok).toBe(false);
    expect((await tool.execute({ taskId: "task_1", reason: "x", evidenceRefs: ["ghost"] })).ok).toBe(false);
  });

  it("rejects reopening a done task (points to revert_done_task)", async () => {
    const tk = mkTasks([{ id: "task_1", title: "t", status: "done" }]);
    const tool = makeReopenTaskTool("c", tk.reader, tk.writer, mkFacts(["f1"]), timeline, noop);
    const res = await tool.execute({ taskId: "task_1", reason: "x", evidenceRefs: ["f1"] });
    expect(res.ok).toBe(false);
    expect(res.content).toMatch(/revert_done_task/);
  });
});
