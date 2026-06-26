# 实时实体数据机制 实施计划（图谱重做 第 1 轮 / 共 3 轮）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans（当前会话直接执行，TDD 节奏）。Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 Fact/Task 加 updateCount/updatedAt/validity 字段 + FactStore.getById/update + TaskStore.update，让 record_fact/record_task 入参可带 id 实现 upsert（带=更新该实体并 updateCount+1、emit fact_updated/task_updated；不带=新建），为下一轮工作流图谱的「节点实时计数+状态变化」提供数据地基。对应 spec docs/superpowers/specs/2026-06-26-realtime-entity-data-design.md。

**Architecture:** `@traceforge/shared` 给 FactSchema 加 updateCount/updatedAt/validity、TaskSchema 加 updateCount、新增 fact_updated 事件。`apps/server` db 建表加列 + FactStore.getById/update + TaskStore.update。`@traceforge/extension` 的 FactWriter/TaskWriter 接口扩 getById/update，record_fact/record_task 加可选 id 走 upsert。routes 工具注入适配。开发期删 live.sqlite 重建。

**Tech Stack:** TypeScript ESM strict、Vitest、Drizzle、Zod、沿用既有 store/tool/event 体系。

## Global Constraints

- 沿用既有约束：Node ≥ 22、pnpm、ESM、`strict: true`、Vitest、`@traceforge/shared` 单源类型、所有业务表带 case_id、纯逻辑模块必须单测。`verbatimModuleSyntax: true` → 类型导入用 `import type`。
- **范围**：只 Fact/Task 加字段（updateCount/updatedAt/validity）；**Action 不动**。前端本轮不消费 fact_updated（下一轮才用），但 store WS 处理需能收到不报错。
- **upsert 由 LLM 决定**：record_fact/record_task 不带 id=新建、带已知 id=更新；带未知 id 返回 `{ok:false}`。代码不判「何时该更新」。
- **validity 闭枚举**：`z.enum(["valid","superseded"]).default("valid")`。
- **字段默认值**：updateCount 默认 0、updatedAt 默认 ""（空视同 createdAt）、validity 默认 valid——不破坏现有数据。
- **建表加列 + 开发期删 live.sqlite 重建**（不写 ALTER 迁移，YAGNI）。
- 提交信息结尾附：`Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`。

**既有约定**（精确）：
- `FactSchema`：id/caseId/type/title/value/source{type,ref}/confidence/tags/createdAt。
- `TaskSchema`：含 status enum、updatedAt、priority enum 等。
- `FactStore`：create(caseId, input)、listByCase。`TaskStore`：create/listByCase/getById/updateStatus。
- `FactWriter`（case-tools）：create/listByCase。`TaskWriter`：create。
- db/client.ts 用 `sqlite.exec` 显式 CREATE TABLE；drizzle schema 在 db/schema.ts。

---

### Task 1: shared —— Fact/Task 加字段 + fact_updated 事件

**Files:**
- Modify: `packages/shared/src/schemas.ts`, `packages/shared/src/events.ts`
- Test: `packages/shared/src/realtime-fields.test.ts`

**Interfaces:**
- Produces：
  - `Fact` 加 `updateCount: number`、`updatedAt: string`、`validity: "valid"|"superseded"`。
  - `Task` 加 `updateCount: number`。
  - `RuntimeEvent` 加 `{ type: "fact_updated"; fact: Fact }`。

- [ ] **Step 1: 写失败测试 `packages/shared/src/realtime-fields.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { FactSchema, TaskSchema } from "./schemas.js";
import type { RuntimeEvent } from "./events.js";

describe("realtime entity fields", () => {
  it("Fact defaults updateCount=0, validity=valid, updatedAt=''", () => {
    const f = FactSchema.parse({
      id: "f1", caseId: "c", type: "endpoint", title: "t", value: {},
      source: { type: "ai", ref: "x" }, createdAt: "t0",
    });
    expect(f.updateCount).toBe(0);
    expect(f.validity).toBe("valid");
    expect(f.updatedAt).toBe("");
  });

  it("Fact rejects an invalid validity", () => {
    expect(FactSchema.safeParse({
      id: "f1", caseId: "c", type: "x", title: "t", value: {},
      source: { type: "ai", ref: "x" }, createdAt: "t0", validity: "bogus",
    }).success).toBe(false);
  });

  it("Task defaults updateCount=0", () => {
    const t = TaskSchema.parse({ id: "t1", caseId: "c", title: "t", createdAt: "t0", updatedAt: "t0" });
    expect(t.updateCount).toBe(0);
  });

  it("accepts fact_updated event", () => {
    const f = FactSchema.parse({ id: "f1", caseId: "c", type: "x", title: "t", value: {}, source: { type: "ai", ref: "" }, createdAt: "t0" });
    const e: RuntimeEvent = { type: "fact_updated", fact: f };
    expect(e.type).toBe("fact_updated");
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run packages/shared/src/realtime-fields.test.ts`
Expected: FAIL —— 字段/事件不存在。

- [ ] **Step 3: 改 `packages/shared/src/schemas.ts`**

在 `FactSchema` 的 `createdAt: z.string(),` 之后（`});` 之前）加：
```ts
  updateCount: z.number().default(0),
  updatedAt: z.string().default(""),
  validity: z.enum(["valid", "superseded"]).default("valid"),
```

在 `TaskSchema` 的 `updatedAt: z.string(),` 之后（`});` 之前）加：
```ts
  updateCount: z.number().default(0),
```

- [ ] **Step 4: 改 `packages/shared/src/events.ts`**

在 `RuntimeEvent` 联合里 `fact_created` 那行之后追加：
```ts
  | { type: "fact_updated"; fact: Fact }
```
（Fact 已在该文件 import，无需改 import。）

- [ ] **Step 5: 运行确认通过 + tsc**

Run: `pnpm vitest run packages/shared/src/realtime-fields.test.ts && pnpm --filter @traceforge/shared exec tsc --noEmit -p tsconfig.json`
Expected: 4 用例全绿；tsc 退出码 0。

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(shared): add updateCount/updatedAt/validity fields and fact_updated event

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: server —— db 建表加列 + FactStore.getById/update + TaskStore.update

**Files:**
- Modify: `apps/server/src/db/schema.ts`, `apps/server/src/db/client.ts`, `apps/server/src/stores/fact-store.ts`, `apps/server/src/stores/task-store.ts`
- Test: `apps/server/src/stores/realtime-store.test.ts`

**Interfaces:**
- Consumes: `Fact`/`Task`（含新字段，Task 1）。
- Produces：
  - `FactStore.getById(id): Fact | undefined`、`FactStore.update(id, patch): Fact | undefined`（updateCount+1、updatedAt=now）。
  - `TaskStore.update(id, patch): Task | undefined`（updateCount+1、updatedAt=now）。
  - facts 表 +列 update_count/updated_at/validity；tasks 表 +列 update_count。

- [ ] **Step 1: drizzle schema 加列 `apps/server/src/db/schema.ts`**

`facts` 表对象里 `createdAt: text("created_at").notNull(),` 后加：
```ts
  updateCount: integer("update_count", { mode: "number" }).notNull().default(0),
  updatedAt: text("updated_at").notNull().default(""),
  validity: text("validity").notNull().default("valid"),
```
`tasks` 表对象里 `updatedAt: text("updated_at").notNull(),` 后加：
```ts
  updateCount: integer("update_count", { mode: "number" }).notNull().default(0),
```
> 顶部确保已 `import { ..., integer } from "drizzle-orm/sqlite-core";`（facts 已用 integer，无需改）。

- [ ] **Step 2: 建表加列 `apps/server/src/db/client.ts`**

把 facts 建表语句改为（加三列）：
```sql
    CREATE TABLE IF NOT EXISTS facts (
      id TEXT PRIMARY KEY, case_id TEXT NOT NULL, type TEXT NOT NULL, title TEXT NOT NULL,
      value_json TEXT NOT NULL, source_json TEXT NOT NULL, confidence REAL NOT NULL,
      tags_json TEXT NOT NULL, created_at TEXT NOT NULL,
      update_count INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL DEFAULT '', validity TEXT NOT NULL DEFAULT 'valid'
    );
```
把 tasks 建表语句改为（加一列）：
```sql
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY, case_id TEXT NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL,
      reason TEXT NOT NULL, blocked_by_json TEXT NOT NULL, trigger_when_json TEXT NOT NULL,
      related_facts_json TEXT NOT NULL, priority TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      update_count INTEGER NOT NULL DEFAULT 0
    );
```

- [ ] **Step 3: 写失败测试 `apps/server/src/stores/realtime-store.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { createDb } from "../db/client.js";
import { FactStore } from "./fact-store.js";
import { TaskStore } from "./task-store.js";

describe("FactStore getById/update", () => {
  it("creates with updateCount=0, updates bumps count + updatedAt + fields", () => {
    const s = new FactStore(createDb(":memory:"));
    const f = s.create("c", { type: "endpoint", title: "a", value: {}, source: { type: "ai", ref: "" }, confidence: 1, tags: [], updateCount: 0, updatedAt: "", validity: "valid" });
    expect(f.updateCount).toBe(0);
    expect(s.getById(f.id)?.title).toBe("a");
    const u = s.update(f.id, { title: "b", confidence: 0.5, validity: "superseded" });
    expect(u?.title).toBe("b");
    expect(u?.confidence).toBe(0.5);
    expect(u?.validity).toBe("superseded");
    expect(u?.updateCount).toBe(1);
    expect(u?.updatedAt).not.toBe("");
    expect(s.getById(f.id)?.updateCount).toBe(1);
  });
  it("update returns undefined for a missing id", () => {
    const s = new FactStore(createDb(":memory:"));
    expect(s.update("nope", { title: "x" })).toBeUndefined();
    expect(s.getById("nope")).toBeUndefined();
  });
});

describe("TaskStore update", () => {
  it("update bumps updateCount + updatedAt + fields", () => {
    const s = new TaskStore(createDb(":memory:"));
    const t = s.create("c", { title: "a", status: "open", reason: "", blockedBy: [], triggerWhen: [], relatedFacts: [], priority: "medium", updateCount: 0 });
    const u = s.update(t.id, { title: "b", status: "blocked" });
    expect(u?.title).toBe("b");
    expect(u?.status).toBe("blocked");
    expect(u?.updateCount).toBe(1);
    expect(s.update("nope", { title: "x" })).toBeUndefined();
  });
});
```

- [ ] **Step 4: 运行确认失败**

Run: `pnpm vitest run apps/server/src/stores/realtime-store.test.ts`
Expected: FAIL —— getById/update 不存在（且 create 现在不接受新字段——下一步同时修）。

- [ ] **Step 5: 改 `apps/server/src/stores/fact-store.ts`**

把 `create` 的 insert 与返回带上新字段，并加 getById/update。完整替换文件为：

```ts
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { facts } from "../db/schema.js";
import { type Fact, FactSchema } from "@traceforge/shared";

type FactInput = Omit<Fact, "id" | "caseId" | "createdAt">;

function rowToFact(row: typeof facts.$inferSelect): Fact {
  return FactSchema.parse({
    id: row.id, caseId: row.caseId, type: row.type, title: row.title,
    value: JSON.parse(row.valueJson), source: JSON.parse(row.sourceJson),
    confidence: row.confidence, tags: JSON.parse(row.tagsJson), createdAt: row.createdAt,
    updateCount: row.updateCount, updatedAt: row.updatedAt, validity: row.validity,
  });
}

export class FactStore {
  constructor(private db: Db) {}

  create(caseId: string, input: FactInput): Fact {
    const id = `fact_${randomUUID()}`;
    const createdAt = new Date().toISOString();
    const f = FactSchema.parse({ ...input, id, caseId, createdAt, updateCount: 0, updatedAt: createdAt });
    this.db.insert(facts).values({
      id, caseId, type: f.type, title: f.title,
      valueJson: JSON.stringify(f.value), sourceJson: JSON.stringify(f.source),
      confidence: f.confidence, tagsJson: JSON.stringify(f.tags), createdAt,
      updateCount: 0, updatedAt: createdAt, validity: f.validity,
    }).run();
    return f;
  }

  getById(id: string): Fact | undefined {
    const row = this.db.select().from(facts).where(eq(facts.id, id)).get();
    return row ? rowToFact(row) : undefined;
  }

  update(id: string, patch: Partial<Pick<Fact, "type" | "title" | "value" | "confidence" | "tags" | "validity">>): Fact | undefined {
    const cur = this.getById(id);
    if (!cur) return undefined;
    const updatedAt = new Date().toISOString();
    const next = FactSchema.parse({ ...cur, ...patch, updateCount: cur.updateCount + 1, updatedAt });
    this.db.update(facts).set({
      type: next.type, title: next.title,
      valueJson: JSON.stringify(next.value), confidence: next.confidence,
      tagsJson: JSON.stringify(next.tags), validity: next.validity,
      updateCount: next.updateCount, updatedAt,
    }).where(eq(facts.id, id)).run();
    return next;
  }

  listByCase(caseId: string): Fact[] {
    return this.db.select().from(facts).where(eq(facts.caseId, caseId)).all().map(rowToFact);
  }
}
```

- [ ] **Step 6: 改 `apps/server/src/stores/task-store.ts` 加 update**

在 TaskStore 里（`updateStatus` 旁）加（沿用其 rowToTask）：
```ts
  update(id: string, patch: Partial<Pick<Task, "title" | "status" | "reason" | "priority" | "blockedBy" | "triggerWhen" | "relatedFacts">>): Task | undefined {
    const cur = this.getById(id);
    if (!cur) return undefined;
    const updatedAt = new Date().toISOString();
    const next = TaskSchema.parse({ ...cur, ...patch, updateCount: cur.updateCount + 1, updatedAt });
    this.db.update(tasks).set({
      title: next.title, status: next.status, reason: next.reason, priority: next.priority,
      blockedByJson: JSON.stringify(next.blockedBy), triggerWhenJson: JSON.stringify(next.triggerWhen),
      relatedFactsJson: JSON.stringify(next.relatedFacts), updateCount: next.updateCount, updatedAt,
    }).where(eq(tasks.id, id)).run();
    return next;
  }
```
并把 TaskStore 的 create + rowToTask 带上 updateCount（rowToTask 的 parse 对象加 `updateCount: row.updateCount`；create 的 TaskSchema.parse input 已含 updateCount 默认，insert values 加 `updateCount: 0`）。需顶部 import `TaskSchema`（已有 import type Task → 改为 `import { type Task, TaskSchema }`）。

> 注：task-store.ts 现有 create/rowToTask 需同步加 updateCount 列读写（insert values 加 `updateCount: 0`；rowToTask parse 加 `updateCount: row.updateCount`），否则新列读不出。

- [ ] **Step 7: 运行确认通过 + tsc**

Run: `pnpm vitest run apps/server/src/stores/realtime-store.test.ts && pnpm --filter @traceforge/server exec tsc --noEmit -p tsconfig.json`
Expected: 3 用例全绿；tsc 退出码 0。

- [ ] **Step 8: Commit**

```bash
git add -A && git commit -m "feat(server): add fact/task realtime columns, FactStore.getById/update, TaskStore.update

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: extension —— record_fact/record_task 加可选 id（upsert）

**Files:**
- Modify: `packages/extension/src/case-tools.ts`
- Test: `packages/extension/src/upsert-tools.test.ts`

**Interfaces:**
- Consumes: `FactStore.getById/update`、`TaskStore.update`（Task 2，经注入接口）。
- Produces：
  - `FactWriter` 接口加 `getById(id): Fact | undefined`、`update(id, patch): Fact | undefined`。
  - `TaskWriter` 接口加 `getById(id): { id; status } | Task | undefined`、`update(id, patch): Task | undefined`。
  - `makeRecordFactTool` 入参加可选 `id`：带=update + emit fact_updated；不带=create + emit fact_created；带未知 id={ok:false}。
  - `makeRecordTaskTool` 同理（emit task_updated / task_created）。

- [ ] **Step 1: 写失败测试 `packages/extension/src/upsert-tools.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { makeRecordFactTool, makeRecordTaskTool } from "./case-tools.js";
import type { Fact, Task, RuntimeEvent } from "@traceforge/shared";

function mkFacts() {
  const map = new Map<string, Fact>();
  let n = 0;
  return {
    map,
    writer: {
      create: (caseId: string, input: Omit<Fact, "id" | "caseId" | "createdAt">) => {
        const f = { ...input, id: `fact_${n++}`, caseId, createdAt: "t", updateCount: 0, updatedAt: "t" } as Fact;
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
      create: (caseId: string, input: Omit<Task, "id" | "caseId" | "createdAt" | "updatedAt">) => {
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
    await tool.execute({ title: "a" });
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
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run packages/extension/src/upsert-tools.test.ts`
Expected: FAIL —— 工具不接受 id / writer 无 getById·update。

- [ ] **Step 3: 改 `packages/extension/src/case-tools.ts`**

把 `FactWriter` 接口改为：
```ts
export interface FactWriter {
  create(caseId: string, input: Omit<Fact, "id" | "caseId" | "createdAt">): Fact;
  listByCase(caseId: string): Fact[];
  getById(id: string): Fact | undefined;
  update(id: string, patch: Partial<Pick<Fact, "type" | "title" | "value" | "confidence" | "tags" | "validity">>): Fact | undefined;
}
```
把 `TaskWriter` 接口改为：
```ts
export interface TaskWriter {
  create(caseId: string, input: Omit<Task, "id" | "caseId" | "createdAt" | "updatedAt">): Task;
  getById(id: string): Task | undefined;
  update(id: string, patch: Partial<Pick<Task, "title" | "status" | "reason" | "priority" | "blockedBy" | "triggerWhen" | "relatedFacts">>): Task | undefined;
}
```

`makeRecordFactTool`：inputSchema.properties 加 `id: { type: "string" }`；execute 改为：
```ts
    execute: async (input) => {
      const i = input as { id?: string; type?: string; title?: string; value?: unknown; confidence?: number; tags?: string[] };
      if (typeof i.id === "string" && i.id) {
        if (!facts.getById(i.id)) return { ok: false, content: `fact ${i.id} 不存在，新建请去掉 id` };
        const patch: Record<string, unknown> = {};
        if (i.type !== undefined) patch.type = i.type;
        if (i.title !== undefined) patch.title = i.title;
        if (i.value !== undefined) patch.value = i.value;
        if (typeof i.confidence === "number") patch.confidence = i.confidence;
        if (Array.isArray(i.tags)) patch.tags = i.tags;
        const fact = facts.update(i.id, patch as never);
        if (!fact) return { ok: false, content: `更新失败：${i.id}` };
        const entry = timeline.append(caseId, "fact_updated", `Fact 更新: ${fact.title}（第 ${fact.updateCount} 次）`, fact.id);
        emit({ type: "fact_updated", fact });
        emit({ type: "timeline_appended", entry });
        return { ok: true, content: `已更新 Fact ${fact.id}（第 ${fact.updateCount} 次）` };
      }
      const fact = facts.create(caseId, {
        type: i.type ?? "note", title: i.title ?? "", value: i.value ?? {},
        source: { type: "ai", ref: "agent" },
        confidence: typeof i.confidence === "number" ? i.confidence : 1,
        tags: Array.isArray(i.tags) ? i.tags : [],
        updateCount: 0, updatedAt: "", validity: "valid",
      });
      const entry = timeline.append(caseId, "fact_created", `Fact (agent): ${fact.title}`, fact.id);
      emit({ type: "fact_created", fact });
      emit({ type: "timeline_appended", entry });
      return { ok: true, content: `已记录 Fact ${fact.id}: ${fact.title}` };
    },
```
> 注：create 的 input 现在要带 updateCount/updatedAt/validity（FactWriter.create 的 Omit 类型已含它们，给默认值即可）。description 补一句「更新已有 Fact 时带上其 id；新建则不带 id」。

`makeRecordTaskTool`：inputSchema.properties 加 `id: { type: "string" }`；execute 开头加：
```ts
      const i = input as Record<string, unknown>;
      if (typeof i.id === "string" && i.id) {
        if (!tasks.getById(i.id)) return { ok: false, content: `task ${i.id} 不存在，新建请去掉 id` };
        const patch: Record<string, unknown> = {};
        if (typeof i.title === "string") patch.title = i.title;
        if (typeof i.status === "string") patch.status = i.status;
        if (typeof i.reason === "string") patch.reason = i.reason;
        if (typeof i.priority === "string") patch.priority = i.priority;
        if (Array.isArray(i.blockedBy)) patch.blockedBy = i.blockedBy;
        if (Array.isArray(i.triggerWhen)) patch.triggerWhen = i.triggerWhen;
        if (Array.isArray(i.relatedFacts)) patch.relatedFacts = i.relatedFacts;
        const task = tasks.update(i.id, patch as never);
        if (!task) return { ok: false, content: `更新失败：${i.id}` };
        const entry = timeline.append(caseId, "task_updated", `Task 更新: ${task.title}（第 ${task.updateCount} 次）`, task.id);
        emit({ type: "task_updated", task });
        emit({ type: "timeline_appended", entry });
        return { ok: true, content: `已更新 Task ${task.id}（第 ${task.updateCount} 次）` };
      }
```
（其余新建逻辑不变，但 create 的 input 加 `updateCount: 0`。）

- [ ] **Step 4: 运行确认通过 + tsc**

Run: `pnpm vitest run packages/extension/src/upsert-tools.test.ts && pnpm --filter @traceforge/extension exec tsc --noEmit -p tsconfig.json`
Expected: 5 用例全绿；tsc 退出码 0。

- [ ] **Step 5: 全 extension 测试（确认未破坏既有 record_task/reopen 等）**

Run: `pnpm vitest run packages/extension && pnpm --filter @traceforge/extension exec tsc --noEmit -p tsconfig.json`
Expected: 测试全绿；**tsc 可能报这几个测试的 mock writer 缺 getById/update**——`case-tools-record.test.ts`、`record-task-normalize.test.ts`、`reevaluate-tools.test.ts` 里给 FactWriter/TaskWriter mock 时若不全会报。给报错的 mock 补最小桩：FactWriter mock 加 `getById: () => undefined, update: () => undefined`（这些测试不走 upsert 分支，桩够用）；TaskWriter mock 加 `getById: () => undefined, update: () => undefined`。逐个按 tsc 报错补，直到退出码 0。

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(extension): record_fact/record_task accept optional id for upsert

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: server —— routes 注入适配 + 全量校验

**Files:**
- Modify: `apps/server/src/routes.ts`（若注入处类型需调整）
- Test: 复用既有 routes-agent / 全量

**Interfaces:**
- Consumes: FactStore/TaskStore（已有 getById/update，Task 2）满足扩展后的 FactWriter/TaskWriter（Task 3）。

- [ ] **Step 1: tsc 检查 routes 注入是否仍兼容**

Run: `pnpm --filter @traceforge/server exec tsc --noEmit -p tsconfig.json`
Expected: 退出码 0（FactStore 现有 getById/update、TaskStore 现有 getById/update，应自动满足新接口；若报缺 reopen_task 等用的 reader 类型，按提示补——但那些走的是 TaskStatusReader/StatusWriter，不受影响）。

- [ ] **Step 2: 全量 server 测试**

Run: `pnpm vitest run apps/server`
Expected: 全部通过（record_fact 路由测试 routes-agent 仍过——agent 调 record_fact 不带 id 即新建，行为不变）。

- [ ] **Step 3: Commit（若有改动；无改动跳过）**

```bash
git add -A && git commit -m "chore(server): verify store satisfies upsert writer interfaces

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: 收尾 —— 全量校验、删库重建、文档

**Files:**
- Modify: `README.md`

- [ ] **Step 1: 全量测试 + 构建**

Run: `pnpm test && pnpm -r build`
Expected: 全绿（shared +4、server +3、extension +5 用例）；各包构建无错。

- [ ] **Step 2: 删 live.sqlite 重建（开发库含旧 schema，删掉下次启动按新建表重建）**

Run: `rm -f live.sqlite live.sqlite-shm live.sqlite-wal`
Expected: 删除成功（下次起后端会用新建表语句重建，含新列）。

- [ ] **Step 3: 端到端手动验证（可选，真 agent）**

```bash
# 起后端（注入 .env key），建 case，agent 记 fact，再带同 id 更新
node --import tsx -e "import('./apps/server/src/main.ts').then(m=>m.buildServer('e2e-upsert.sqlite')).then(a=>a.listen({port:4000,host:'127.0.0.1'}))" > server.log 2>&1 &
sleep 5
CID=$(curl -s -X POST localhost:4000/api/cases -H 'content-type: application/json' -d '{"name":"upsert","allowHosts":["t.com"]}' | sed -E 's/.*"id":"([^"]+)".*/\1/')
# 手动建一个 fact，再带 id 更新，看 updateCount 变 1
FID=$(curl -s -X POST localhost:4000/api/cases/$CID/facts -H 'content-type: application/json' --data-binary '{"type":"endpoint","title":"orig"}' | sed -E 's/.*"id":"(fact_[^"]+)".*/\1/')
echo "fact: $FID"
# 注：HTTP /facts 路由是 create-only；upsert 是 agent 工具路径。此步仅验证 fact 有 updateCount 字段。
curl -s localhost:4000/api/cases/$CID/facts | grep -o '"updateCount":[0-9]*'
# 清理：杀后端、删 e2e-upsert.sqlite* server.log
```
Expected: facts 返回含 `"updateCount":0`，证明字段已落库。（真 upsert 经 agent record_fact 带 id，靠真 LLM，留作手测。）

- [ ] **Step 4: 更新 `README.md`**

"当前进度"在重评估行后追加：
```markdown
- 实时实体数据机制（工作流图谱重做 第 1 轮 / 共 3 轮）：Fact/Task 加 updateCount/updatedAt/validity；record_fact/record_task 入参可带 id 实现 upsert（带=更新该实体并 updateCount+1、emit fact_updated/task_updated；不带=新建），LLM 自主决定。为后续工作流图谱的「节点实时计数+状态变化」提供数据地基。后两轮：图谱引擎换 @xyflow/react+elk、整体浅色化三栏
```
把测试数量更新为实际值。

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "docs: update README for realtime entity data (graph rework round 1)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## 自检说明（写给计划作者，非执行步骤）

- **Spec 覆盖**：§2 字段 → Task 1；§3 store → Task 2；§4 工具 upsert → Task 3；§5 事件 fact_updated → Task 1(定义)+Task 3(emit)；§6 错误处理 → Task 3 各 {ok:false}；§7 测试 → 各任务；§3 删库重建 → Task 5 Step 2；§8 理念 → upsert 由 LLM 决定/validity 闭枚举 贯穿；§9 分解 = 本 5 任务。
- **类型一致性**：`updateCount`/`updatedAt`/`validity`（Task 1 schema，Task 2 store 读写，Task 3 工具）；`FactStore.getById/update`、`TaskStore.update`（Task 2 定义，Task 3 经 FactWriter/TaskWriter 注入，Task 4 routes 满足）；`fact_updated` 事件（Task 1 定义，Task 3 emit）；FactWriter/TaskWriter 扩展（Task 3 定义，server store Task 2 满足）。
- **既有 mock 兼容**：Task 3 Step 5 提示——既有测试里 FactWriter/TaskWriter 的 mock 若缺 getById/update 会 tsc 报错，需补桩。这是已知点，执行时按 tsc 提示补。
- **HTTP /facts 路由不变**：仍 create-only（人工/外部新建）；upsert 只走 agent record_fact 工具路径。Task 5 端到端注明此区别。
- **Action 不动**：核对——本计划无 ActionCard 改动。
- **前端不消费**：本轮 fact_updated 前端不处理（下一轮），store 现有 WS else-if 链不认识 fact_updated 会落到末尾被忽略，不报错（RuntimeEvent 类型已含，TS 不报）。
