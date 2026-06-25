# LLM 驱动的重评估 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans（当前会话直接执行，TDD 节奏）。Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 加两个 agent 工具 `reopen_task`（normal，重启未完成 Task）与 `revert_done_task`（command 过 ApprovalGate，打回 done Task），都汇到 `recheck_candidate`，让 LLM 自主用新 Fact 复活/翻案旧 Task——Fact↔Task 关联完全由 LLM 判断，代码不写映射表。对应 spec docs/superpowers/specs/2026-06-25-reevaluation-design.md。

**Architecture:** `packages/extension/src/case-tools.ts` 新增 `makeReopenTaskTool` / `makeRevertDoneTaskTool`（与 makeRecordTaskTool 同模式，注入结构接口 TaskStatusReader/StatusWriter + 复用 FactWriter 验 evidenceRefs + TimelineWriter + Emit）。`apps/server`：TaskStore 补 `getById`，routes agent run 注册两工具。两工具靠校验目标状态互斥（reopen 拒 done、revert 只收 done），证据驱动（evidenceRefs 非空且引用已知 Fact）。

**Tech Stack:** TypeScript ESM strict、Vitest、沿用 ToolRegistry/ApprovalGate/case-tools 体系。

## Global Constraints

- 沿用既有约束：Node ≥ 22、pnpm、ESM、`strict: true`、Vitest、`@traceforge/shared` 单源类型、纯逻辑模块必须单测。
- **零硬编码**：代码不含 factTypeToTriggers/canFactUnblockTask 等映射表；Fact↔Task 关联由 LLM 在 agent 循环判断。
- **两工具风险固定**：`reopen_task` risk=normal（不卡门）；`revert_done_task` risk=command（过 ApprovalGate）。用现有门机制，零改动 ApprovalGate。
- **证据驱动**：两工具都要求 evidenceRefs 非空且都引用已记录 Fact id（复用 record_action 的校验），否则 `{ok:false}`。
- **状态互斥**：reopen 目标状态须 ≠ "done"（否则提示用 revert_done_task）；revert 目标状态须 === "done"（否则提示用 reopen_task）。都改为 `recheck_candidate`。
- **不抛崩**：所有校验失败返回 `{ok:false, content}`，不抛异常。
- **不含新建 Task**（走现有 record_task）、不含置信度传播/失效时效（后续）。
- 提交信息结尾附：`Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`。

**既有约定**（精确，照抄风格）：
- `TaskWriter`（case-tools.ts 已有）：`create(...)`。本计划新增 `TaskStatusReader { getById(taskId): { id; title; status } | undefined }` 与 `StatusWriter { updateStatus(id, status, reason): unknown }`。
- `FactWriter`（case-tools.ts 已有）：`listByCase(caseId): Fact[]`、`create(...)`——复用其 listByCase 验 evidenceRefs。
- `TimelineWriter.append(caseId, eventType, detail, refId)`、`Emit`、`emit({type:"task_updated", task})`、`emit({type:"timeline_appended", entry})` 均已有。
- `TaskStore`（server）有 `listByCase`、`updateStatus(id, status, reason?)`；本计划补 `getById(id): Task | undefined`。

---

### Task 1: extension —— makeReopenTaskTool

**Files:**
- Modify: `packages/extension/src/case-tools.ts`, `packages/extension/src/index.ts`
- Test: `packages/extension/src/reevaluate-tools.test.ts`

**Interfaces:**
- Consumes: `FactWriter`（已有，用 listByCase 验 evidence）、`TimelineWriter`/`Emit`（已有）、`Task`（shared）。
- Produces：
  - `interface TaskStatusReader { getById(taskId: string): { id: string; title: string; status: string } | undefined }`
  - `interface StatusWriter { updateStatus(id: string, status: string, reason: string): { id: string; caseId: string; title: string; status: string } | undefined }`
  - `function makeReopenTaskTool(caseId: string, tasksR: TaskStatusReader, tasksW: StatusWriter, facts: FactWriter, timeline: TimelineWriter, emit: Emit): ToolDescriptor` —— name=`reopen_task`，risk=normal；校验 taskId 存在、evidenceRefs 非空且已知 fact、目标状态 ≠ done；改为 recheck_candidate + timeline + emit task_updated。

- [ ] **Step 1: 写失败测试 `packages/extension/src/reevaluate-tools.test.ts`**

```ts
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
const timeline = { append: (_c: string, _e: string, d: string, r?: string) => ({ id: "tl", caseId: "c", eventType: "x", detail: d, refId: r, createdAt: "t" }) };
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
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run packages/extension/src/reevaluate-tools.test.ts`
Expected: FAIL —— makeReopenTaskTool 不存在。

- [ ] **Step 3: 在 `packages/extension/src/case-tools.ts` 末尾追加接口与工具**

在文件末尾（makeRecordActionTool 之后）追加：

```ts
export interface TaskStatusReader {
  getById(taskId: string): { id: string; title: string; status: string } | undefined;
}
export interface StatusWriter {
  updateStatus(id: string, status: string, reason: string): { id: string; caseId: string; title: string; status: string } | undefined;
}

// 校验 evidenceRefs 非空且都引用已记录 Fact（复用 record_action 规则）
function evidenceValid(caseId: string, facts: FactWriter, input: unknown): { ok: true; refs: string[] } | { ok: false } {
  const i = input as Record<string, unknown>;
  const refs = Array.isArray(i.evidenceRefs) ? (i.evidenceRefs as unknown[]).filter((r): r is string => typeof r === "string") : [];
  const known = new Set(facts.listByCase(caseId).map((f) => f.id));
  return refs.length > 0 && refs.every((r) => known.has(r)) ? { ok: true, refs } : { ok: false };
}

export function makeReopenTaskTool(
  caseId: string, tasksR: TaskStatusReader, tasksW: StatusWriter, facts: FactWriter, timeline: TimelineWriter, emit: Emit,
): ToolDescriptor {
  return {
    name: "reopen_task",
    description: "当新证据使一个未完成（blocked/failed/open）的旧任务重新可做时，把它重启为 recheck_candidate。evidenceRefs 必须引用支撑此判断的已记录 Fact。已完成(done)的任务请改用 revert_done_task。",
    inputSchema: {
      type: "object",
      properties: { taskId: { type: "string" }, reason: { type: "string" }, evidenceRefs: { type: "array", items: { type: "string" } } },
      required: ["taskId", "reason", "evidenceRefs"],
    },
    risk: "normal",
    source: "builtin",
    execute: async (input) => {
      const i = input as { taskId: string; reason: string };
      const task = tasksR.getById(i.taskId);
      if (!task) return { ok: false, content: `task not found: ${i.taskId}` };
      if (task.status === "done") return { ok: false, content: "已完成任务请用 revert_done_task" };
      const ev = evidenceValid(caseId, facts, input);
      if (!ev.ok) return { ok: false, content: "evidenceRefs 必须非空且都引用已记录的 Fact id" };
      tasksW.updateStatus(i.taskId, "recheck_candidate", i.reason);
      const updated = { id: task.id, caseId, title: task.title, status: "recheck_candidate", reason: i.reason, blockedBy: [], triggerWhen: [], relatedFacts: [], priority: "medium", createdAt: "", updatedAt: new Date().toISOString() } as unknown as Task;
      const entry = timeline.append(caseId, "task_reopened", `Task 重启: ${task.title} ← ${i.reason}`, task.id);
      emit({ type: "task_updated", task: updated });
      emit({ type: "timeline_appended", entry });
      return { ok: true, content: `Task ${task.title} 已重启为 recheck_candidate` };
    },
  };
}
```

> 注：emit task_updated 需要一个 Task 对象；此处用目标 id/title + 新状态构造一个最小 Task（前端只用 id/status/title 刷新列表）。真实完整字段在 DB 已更新，listByCase 拉取时准确。

- [ ] **Step 4: 导出 `packages/extension/src/index.ts`**

把 case-tools 的导出那块（`makeRecordActionTool` 等）补上新符号：

```ts
export {
  makeListTrafficTool, makeGetTrafficTool, type TrafficReader,
  makeRecordFactTool, makeRecordTaskTool, makeRecordActionTool,
  makeReopenTaskTool, type TaskStatusReader, type StatusWriter,
  type FactWriter, type TaskWriter, type ActionWriter, type DecisionWriter, type TimelineWriter, type Emit,
} from "./case-tools.js";
```

- [ ] **Step 5: 运行确认通过 + tsc**

Run: `pnpm vitest run packages/extension/src/reevaluate-tools.test.ts && pnpm --filter @traceforge/extension exec tsc --noEmit -p tsconfig.json`
Expected: 5 用例全绿；tsc 退出码 0。

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(extension): add reopen_task reevaluation tool (normal risk)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: extension —— makeRevertDoneTaskTool

**Files:**
- Modify: `packages/extension/src/case-tools.ts`, `packages/extension/src/index.ts`
- Test: `packages/extension/src/reevaluate-tools.test.ts`（追加）

**Interfaces:**
- Consumes: `TaskStatusReader`/`StatusWriter`/`FactWriter`/`TimelineWriter`/`Emit`（Task 1 + 已有）、`evidenceValid`（Task 1 内部函数，同文件可直接用）。
- Produces：
  - `function makeRevertDoneTaskTool(caseId: string, tasksR: TaskStatusReader, tasksW: StatusWriter, facts: FactWriter, timeline: TimelineWriter, emit: Emit): ToolDescriptor` —— name=`revert_done_task`，risk=command；校验 taskId 存在、evidenceRefs、目标状态 === done；改为 recheck_candidate + timeline + emit。

- [ ] **Step 1: 在测试文件追加 revert 用例**

在 `packages/extension/src/reevaluate-tools.test.ts` 末尾追加（import 行补 `makeRevertDoneTaskTool`）：

```ts
import { makeRevertDoneTaskTool } from "./case-tools.js";

describe("makeRevertDoneTaskTool", () => {
  it("is command risk (goes through approval gate)", () => {
    const tk = mkTasks([]);
    const t = makeRevertDoneTaskTool("c", tk.reader, tk.writer, mkFacts([]), timeline, noop);
    expect(t.risk).toBe("command");
    expect(t.name).toBe("revert_done_task");
  });

  it("reverts a done task to recheck_candidate", async () => {
    const tk = mkTasks([{ id: "task_1", title: "确认无注入", status: "done" }]);
    const tool = makeRevertDoneTaskTool("c", tk.reader, tk.writer, mkFacts(["f1"]), timeline, noop);
    const res = await tool.execute({ taskId: "task_1", reason: "发现矛盾证据", evidenceRefs: ["f1"] });
    expect(res.ok).toBe(true);
    expect(tk.updates).toEqual([{ id: "task_1", status: "recheck_candidate", reason: "发现矛盾证据" }]);
  });

  it("rejects reverting a non-done task (points to reopen_task)", async () => {
    const tk = mkTasks([{ id: "task_1", title: "t", status: "blocked" }]);
    const tool = makeRevertDoneTaskTool("c", tk.reader, tk.writer, mkFacts(["f1"]), timeline, noop);
    const res = await tool.execute({ taskId: "task_1", reason: "x", evidenceRefs: ["f1"] });
    expect(res.ok).toBe(false);
    expect(res.content).toMatch(/reopen_task/);
  });

  it("rejects empty evidenceRefs", async () => {
    const tk = mkTasks([{ id: "task_1", title: "t", status: "done" }]);
    const tool = makeRevertDoneTaskTool("c", tk.reader, tk.writer, mkFacts(["f1"]), timeline, noop);
    expect((await tool.execute({ taskId: "task_1", reason: "x", evidenceRefs: [] })).ok).toBe(false);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run packages/extension/src/reevaluate-tools.test.ts`
Expected: FAIL —— makeRevertDoneTaskTool 不存在。

- [ ] **Step 3: 在 `case-tools.ts` 追加 makeRevertDoneTaskTool**

在 makeReopenTaskTool 之后追加：

```ts
export function makeRevertDoneTaskTool(
  caseId: string, tasksR: TaskStatusReader, tasksW: StatusWriter, facts: FactWriter, timeline: TimelineWriter, emit: Emit,
): ToolDescriptor {
  return {
    name: "revert_done_task",
    description: "当新证据与一个已完成(done)任务的结论矛盾时，把它打回 recheck_candidate 重新核查。这是推翻已完成结论的高风险操作，需人工确认。evidenceRefs 必须引用支撑此判断的已记录 Fact。未完成的任务请用 reopen_task。",
    inputSchema: {
      type: "object",
      properties: { taskId: { type: "string" }, reason: { type: "string" }, evidenceRefs: { type: "array", items: { type: "string" } } },
      required: ["taskId", "reason", "evidenceRefs"],
    },
    risk: "command",
    source: "builtin",
    execute: async (input) => {
      const i = input as { taskId: string; reason: string };
      const task = tasksR.getById(i.taskId);
      if (!task) return { ok: false, content: `task not found: ${i.taskId}` };
      if (task.status !== "done") return { ok: false, content: "未完成任务请用 reopen_task" };
      const ev = evidenceValid(caseId, facts, input);
      if (!ev.ok) return { ok: false, content: "evidenceRefs 必须非空且都引用已记录的 Fact id" };
      tasksW.updateStatus(i.taskId, "recheck_candidate", i.reason);
      const updated = { id: task.id, caseId, title: task.title, status: "recheck_candidate", reason: i.reason, blockedBy: [], triggerWhen: [], relatedFacts: [], priority: "medium", createdAt: "", updatedAt: new Date().toISOString() } as unknown as Task;
      const entry = timeline.append(caseId, "task_reverted", `Task 打回: ${task.title}（done→recheck）← ${i.reason}`, task.id);
      emit({ type: "task_updated", task: updated });
      emit({ type: "timeline_appended", entry });
      return { ok: true, content: `Task ${task.title} 已打回 recheck_candidate` };
    },
  };
}
```

- [ ] **Step 4: 导出 `packages/extension/src/index.ts` 补 makeRevertDoneTaskTool**

把 Task 1 那行导出补上：

```ts
  makeReopenTaskTool, makeRevertDoneTaskTool, type TaskStatusReader, type StatusWriter,
```

- [ ] **Step 5: 运行确认通过 + tsc**

Run: `pnpm vitest run packages/extension/src/reevaluate-tools.test.ts && pnpm --filter @traceforge/extension exec tsc --noEmit -p tsconfig.json`
Expected: 9 用例全绿；tsc 退出码 0。

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(extension): add revert_done_task reevaluation tool (command risk)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: server —— TaskStore.getById + 路由注册两工具

**Files:**
- Modify: `apps/server/src/stores/task-store.ts`, `apps/server/src/routes.ts`
- Test: `apps/server/src/stores/reevaluate-store.test.ts`

**Interfaces:**
- Consumes: `makeReopenTaskTool`/`makeRevertDoneTaskTool`（Task 1-2）、现有 TaskStore/FactStore/timeline/bus 装配。
- Produces：
  - `TaskStore.getById(id: string): Task | undefined`。
  - routes agent run 注册 reopen_task + revert_done_task（在 record_action 之后）。

- [ ] **Step 1: 写失败测试 `apps/server/src/stores/reevaluate-store.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { createDb } from "../db/client.js";
import { TaskStore } from "./task-store.js";

describe("TaskStore.getById", () => {
  it("returns a created task by id and undefined for a missing one", () => {
    const store = new TaskStore(createDb(":memory:"));
    const t = store.create("c", { title: "t", status: "blocked", reason: "", blockedBy: [], triggerWhen: [], relatedFacts: [], priority: "medium" });
    expect(store.getById(t.id)?.title).toBe("t");
    expect(store.getById("nope")).toBeUndefined();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run apps/server/src/stores/reevaluate-store.test.ts`
Expected: FAIL —— getById 不存在。

- [ ] **Step 3: 在 `task-store.ts` 加 getById**

在 `updateStatus` 之前（或 listByCase 之后）加：

```ts
  getById(id: string): Task | undefined {
    const row = this.db.select().from(tasks).where(eq(tasks.id, id)).get();
    return row ? rowToTask(row) : undefined;
  }
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm vitest run apps/server/src/stores/reevaluate-store.test.ts`
Expected: PASS。

- [ ] **Step 5: 在 `routes.ts` 注册两工具**

顶部 import 块（`makeRecordActionTool` 那组）补：

```ts
  makeRecordFactTool, makeRecordTaskTool, makeRecordActionTool,
  makeReopenTaskTool, makeRevertDoneTaskTool,
```

在 agent run 路由的 `registry.register(makeRecordActionTool(...))` 之后追加：

```ts
    registry.register(makeReopenTaskTool(id, taskStore, taskStore, factStore, timelineStore, (e) => bus.emit(e)));
    registry.register(makeRevertDoneTaskTool(id, taskStore, taskStore, factStore, timelineStore, (e) => bus.emit(e)));
```

> taskStore 同时充当 TaskStatusReader（getById）与 StatusWriter（updateStatus）；factStore 充当 FactWriter（listByCase）。系统提示里可不改——LLM 看工具描述即知何时用。

- [ ] **Step 6: tsc + 全量 server 测试**

Run: `pnpm --filter @traceforge/server exec tsc --noEmit -p tsconfig.json && pnpm vitest run apps/server`
Expected: tsc 退出码 0；server 全部测试通过。

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat(server): add TaskStore.getById and register reevaluation tools

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: 收尾 —— 全量校验、端到端、文档

**Files:**
- Modify: `README.md`, `TraceForge_design.md`

- [ ] **Step 1: 全量测试 + 构建**

Run: `pnpm test && pnpm -r build`
Expected: 全绿（extension 多 9 用例、server 多 1 用例）；各包构建无错。

- [ ] **Step 2: 端到端手动验证（真 LLM，可选；需 config/llm.json）**

```bash
# 起后端，建 case，先 record 一个 blocked task 与一个 fact，再让 agent 重评估
node --import tsx -e "import('./apps/server/src/main.ts').then(m=>m.buildServer('e2e-reeval.sqlite')).then(a=>a.listen({port:4000,host:'127.0.0.1'}))" > server.log 2>&1 &
sleep 5
CID=$(curl -s -X POST localhost:4000/api/cases -H 'content-type: application/json' -d '{"name":"reeval","allowHosts":["t.com"]}' | sed -E 's/.*"id":"([^"]+)".*/\1/')
# 给 agent 一个会触发重评估的目标（前提：case 里已有 blocked task + 新 fact）
curl -s -X POST localhost:4000/api/cases/$CID/agent/run -H 'content-type: application/json' -d '{"goal":"我刚发现了管理员凭据，检查有没有之前因缺凭据而挂起的任务该重启"}'
# 观察：agent 是否调用 reopen_task；GET /api/cases/$CID/tasks 看状态是否转 recheck_candidate
# 清理：杀后端、删 e2e-reeval.sqlite* server.log
```
Expected: agent 自主调用 reopen_task 把挂起任务转为 recheck_candidate（端到端依赖真 LLM 判断，Task 1-3 单测已覆盖工具逻辑，此步可记环境受限跳过）。

- [ ] **Step 3: 更新 `README.md`**

"当前进度"标题追加，并在 PoC MCP server 行后追加：

```markdown
- LLM 驱动的重评估（修订路线第 4 项）：两个 agent 工具 reopen_task（重启未完成的旧任务，normal）与 revert_done_task（打回已完成结论，command 过 ApprovalGate 人工确认），都转为 recheck_candidate。新 Fact 入库后 LLM 自主判断哪些旧任务该复活/翻案——Fact↔Task 关联完全由 LLM 决定，代码不写 factTypeToTriggers 等映射表（第 27 章双向重评估的去硬编码最小闭环）。两工具强制 evidenceRefs 引用已记录 Fact
```

把测试数量更新为实际值。

- [ ] **Step 4: 勾选设计文档第 31 章修订路线第 4 项**

在 `TraceForge_design.md` 第 31.3 节，把第 4 项「重新评估机制」标注为已完成（在该行末尾追加「✅ 已完成（reopen_task/revert_done_task，LLM 判断关联，去 factTypeToTriggers 硬编码）」）。

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "docs: update README and roadmap for LLM-driven reevaluation

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## 自检说明（写给计划作者，非执行步骤）

- **Spec 覆盖**：§2 两工具 → Task 1（reopen）+ Task 2（revert）；§3 契约/状态互斥 → Task 1-2 校验逻辑 + 测试；§4 实现结构/注入 → Task 1-2 接口 + Task 3 store/routes；§5 错误处理 → Task 1-2 各 {ok:false} 分支 + 测试；§6 测试 → Task 1-2 单测 + Task 4 端到端；§7 理念 → 零硬编码/分级贯穿；§8 分解 = 本 4 任务。
- **类型一致性**：`TaskStatusReader.getById`/`StatusWriter.updateStatus`（Task 1 定义，Task 2 复用，Task 3 taskStore 实现）；`makeReopenTaskTool`/`makeRevertDoneTaskTool` 签名（Task 1-2 定义，Task 3 routes 调用一致，参数顺序 caseId, tasksR, tasksW, facts, timeline, emit）；`evidenceValid` 内部函数（Task 1 定义，Task 2 同文件复用）；risk 值（reopen=normal Task 1、revert=command Task 2）。
- **安全约束落点**：reopen=normal（Task 1 risk 字段 + 测试）不卡门；revert=command（Task 2 risk 字段 + 测试）过现有 ApprovalGate（routes 已有 gate，零改动）；evidenceRefs 校验（两工具 evidenceValid + 测试空/未知用例）；状态互斥（reopen 拒 done、revert 拒非 done + 测试）。
- **零硬编码核对**：无 factTypeToTriggers/映射表；关联由 LLM 在 agent 循环判断（工具只校验目标状态 + evidence，不判 fact 类型）。
- **TaskStore 双角色**：同一 taskStore 实例同时满足 TaskStatusReader（getById）与 StatusWriter（updateStatus），routes 注入两次同实例（Task 3 Step 5）。
- **emit task_updated 的最小 Task 构造**：DB 已被 updateStatus 真实更新，前端列表刷新只用 id/status/title；listByCase 拉取时字段完整（Task 1 Step 3 注）。
