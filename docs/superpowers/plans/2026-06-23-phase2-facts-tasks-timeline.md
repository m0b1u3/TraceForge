# TraceForge 阶段 2：Facts / Tasks / Timeline 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (本计划在当前会话由控制者直接执行，TDD 节奏)。Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让用户能把一条请求/页面手动标记为 Fact、创建并挂起 Task（含 blocked + triggerWhen）、并在 Timeline 面板按时间线回放所有关键事件。

**Architecture:** 在阶段 1 已立的 monorepo 上扩展。`@traceforge/shared` 新增 `Fact`/`Task`/`TimelineEntry` 的 Zod schema 与对应 `RuntimeEvent`。server 新增 `FactStore`/`TaskStore`/`TimelineStore`（沿用阶段 1 的 Drizzle + better-sqlite3 + `case_id` 隔离模式）与对应 REST 路由；任何 Fact/Task 的写入都自动追加一条 Timeline 记录并 emit 事件。前端新增 FactsPanel / TasksPanel / TimelinePanel，从 Traffic Panel 的请求行可"标记为 Fact"，三个面板经 WebSocket 实时刷新。本阶段仍不调用 LLM。

**Tech Stack:** 沿用阶段 1 —— TypeScript、pnpm、Fastify、better-sqlite3 + Drizzle、Zod、Vite、React、Zustand、Vitest。

## Global Constraints

- 沿用阶段 1 全部约束：Node ≥ 22、pnpm、ESM、`strict: true`、Vitest。
- 所有共享数据结构定义在 `@traceforge/shared`，用 Zod schema 并由 `z.infer` 导出类型——禁止多处重复定义。
- 所有业务表带 `case_id`，所有 store 查询以 `caseId` 为首参并强制 `WHERE case_id = ?`（呼应设计文档第 28 章）。
- 纯逻辑/存储模块必须有 Vitest 单元测试。
- 沿用阶段 1 的 id 前缀约定：`fact_`、`task_`、`tl_`，用 `crypto.randomUUID()`。
- Fact 的 `type` 枚举对齐设计文档 8.1 节；Task 的 `status` 枚举对齐 8.2 节。
- **每次 Fact 创建、Task 创建、Task 状态变更都必须：(a) 写入对应表 (b) 追加一条 TimelineEntry (c) 经 EventBus emit 对应 RuntimeEvent。** 三者缺一不可——这是 Timeline 即历史的硬要求。
- 不调用 LLM；Fact 的来源 `source.type` 本阶段只会是 `manual` 或 `traffic`。
- 提交信息结尾附：`Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`。

---

### Task 1: shared —— Fact / Task / TimelineEntry schema 与事件扩展

**Files:**
- Modify: `packages/shared/src/schemas.ts`
- Modify: `packages/shared/src/events.ts`
- Test: `packages/shared/src/phase2-schemas.test.ts`

**Interfaces:**
- Consumes: 现有 `packages/shared/src/schemas.ts`（已含 ScopeRule/Case/TrafficEntry）。
- Produces（追加到同文件，经 `index.ts` 既有 `export *` 自动导出）：
  - `FactSchema` / `Fact`：`{ id, caseId, type, title, value(unknown), source:{type,ref}, confidence(number,默认1), tags(string[]默认[]), createdAt }`。`type` 为 8.1 节枚举；`source.type` 枚举 `"browser"|"traffic"|"js"|"terminal"|"file_read"|"manual"|"ai"`。
  - `TaskSchema` / `Task`：`{ id, caseId, title, status(默认"open"), reason(默认""), blockedBy(string[]默认[]), triggerWhen(string[]默认[]), relatedFacts(string[]默认[]), priority(默认"medium"), createdAt, updatedAt }`。`status` 为 8.2 节枚举。
  - `TimelineEntrySchema` / `TimelineEntry`：`{ id, caseId, eventType(string), refId(string|null默认null), detail(string), createdAt }`。
  - `RuntimeEvent` 联合新增分支：`fact_created`(fact)、`task_created`(task)、`task_updated`(task)、`timeline_appended`(entry)。

- [ ] **Step 1: 写失败测试 `packages/shared/src/phase2-schemas.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { FactSchema, TaskSchema, TimelineEntrySchema } from "./schemas.js";

describe("FactSchema", () => {
  it("defaults confidence to 1 and tags to []", () => {
    const f = FactSchema.parse({
      id: "fact_1", caseId: "case_1", type: "login_endpoint", title: "admin login",
      value: { url: "https://t/admin" }, source: { type: "manual", ref: "page_1" },
      createdAt: "now",
    });
    expect(f.confidence).toBe(1);
    expect(f.tags).toEqual([]);
  });

  it("rejects an unknown fact type", () => {
    expect(() =>
      FactSchema.parse({
        id: "f", caseId: "c", type: "not_a_type", title: "t",
        value: {}, source: { type: "manual", ref: "r" }, createdAt: "now",
      }),
    ).toThrow();
  });
});

describe("TaskSchema", () => {
  it("defaults status to open and priority to medium", () => {
    const t = TaskSchema.parse({
      id: "task_1", caseId: "case_1", title: "verify login",
      createdAt: "now", updatedAt: "now",
    });
    expect(t.status).toBe("open");
    expect(t.priority).toBe("medium");
    expect(t.blockedBy).toEqual([]);
  });

  it("accepts a blocked task with triggerWhen", () => {
    const t = TaskSchema.parse({
      id: "task_2", caseId: "c", title: "login", status: "blocked",
      blockedBy: ["credential"], triggerWhen: ["credential_found"],
      createdAt: "now", updatedAt: "now",
    });
    expect(t.status).toBe("blocked");
    expect(t.triggerWhen).toEqual(["credential_found"]);
  });
});

describe("TimelineEntrySchema", () => {
  it("defaults refId to null", () => {
    const e = TimelineEntrySchema.parse({
      id: "tl_1", caseId: "c", eventType: "fact_created", detail: "x", createdAt: "now",
    });
    expect(e.refId).toBeNull();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run packages/shared/src/phase2-schemas.test.ts`
Expected: FAIL —— `FactSchema`/`TaskSchema`/`TimelineEntrySchema` 未导出。

- [ ] **Step 3: 在 `packages/shared/src/schemas.ts` 末尾追加**

```ts
export const FactSchema = z.object({
  id: z.string(),
  caseId: z.string(),
  type: z.enum([
    "target", "page", "js_file", "api_endpoint", "login_endpoint", "parameter",
    "credential", "token", "cookie", "session", "file_read", "source_code",
    "config_file", "heapdump", "finding", "ssh_service", "ssh_session",
    "database_connection", "sensitive_path", "note",
  ]),
  title: z.string(),
  value: z.unknown(),
  source: z.object({
    type: z.enum(["browser", "traffic", "js", "terminal", "file_read", "manual", "ai"]),
    ref: z.string(),
  }),
  confidence: z.number().default(1),
  tags: z.array(z.string()).default([]),
  createdAt: z.string(),
});
export type Fact = z.infer<typeof FactSchema>;

export const TaskSchema = z.object({
  id: z.string(),
  caseId: z.string(),
  title: z.string(),
  status: z.enum([
    "open", "blocked", "recheck_candidate", "approved", "running",
    "done", "failed", "rejected", "out_of_scope",
  ]).default("open"),
  reason: z.string().default(""),
  blockedBy: z.array(z.string()).default([]),
  triggerWhen: z.array(z.string()).default([]),
  relatedFacts: z.array(z.string()).default([]),
  priority: z.enum(["low", "medium", "high"]).default("medium"),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Task = z.infer<typeof TaskSchema>;

export const TimelineEntrySchema = z.object({
  id: z.string(),
  caseId: z.string(),
  eventType: z.string(),
  refId: z.string().nullable().default(null),
  detail: z.string(),
  createdAt: z.string(),
});
export type TimelineEntry = z.infer<typeof TimelineEntrySchema>;
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm vitest run packages/shared/src/phase2-schemas.test.ts`
Expected: PASS（5 个用例全绿）。

- [ ] **Step 5: 扩展 `packages/shared/src/events.ts`**

将文件改为（在 import 增加新类型，在联合追加 4 个分支）：

```ts
import type { Case, TrafficEntry, Fact, Task, TimelineEntry } from "./schemas.js";

export type RuntimeEvent =
  | { type: "case_created"; case: Case }
  | { type: "request_captured"; entry: TrafficEntry }
  | { type: "response_captured"; entry: TrafficEntry }
  | { type: "scope_violation"; caseId: string; url: string; reason: string }
  | { type: "fact_created"; fact: Fact }
  | { type: "task_created"; task: Task }
  | { type: "task_updated"; task: Task }
  | { type: "timeline_appended"; entry: TimelineEntry };
```

- [ ] **Step 6: 全量 shared 测试 + 类型检查**

Run: `pnpm vitest run packages/shared && pnpm --filter @traceforge/shared exec tsc --noEmit -p tsconfig.json`
Expected: 所有 shared 测试通过；tsc 退出码 0。

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat(shared): add Fact/Task/TimelineEntry schemas and phase-2 events

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: server —— Fact / Task / Timeline 存储与 DB 表

**Files:**
- Modify: `apps/server/src/db/schema.ts`
- Modify: `apps/server/src/db/client.ts`
- Create: `apps/server/src/stores/fact-store.ts`
- Create: `apps/server/src/stores/task-store.ts`
- Create: `apps/server/src/stores/timeline-store.ts`
- Test: `apps/server/src/stores/phase2-stores.test.ts`

**Interfaces:**
- Consumes: `Fact`/`Task`/`TimelineEntry`（`@traceforge/shared`，Task 1）；现有 `Db`（`db/client.ts`）。
- Produces：
  - `createDb` 额外建 `facts`、`tasks`、`timeline` 三张表（均带 `case_id` + 索引）。
  - `FactStore`：`create(caseId, input: Omit<Fact,"id"|"caseId"|"createdAt">) → Fact`、`listByCase(caseId) → Fact[]`。
  - `TaskStore`：`create(caseId, input) → Task`、`listByCase(caseId) → Task[]`、`updateStatus(id, status, reason?) → Task | undefined`。
  - `TimelineStore`：`append(caseId, eventType, detail, refId?) → TimelineEntry`、`listByCase(caseId) → TimelineEntry[]`（按 createdAt 升序）。
  - 注：store 只负责持久化，不负责 emit 事件/写 Timeline 的联动——联动在 Task 3 的路由层组合（保持 store 纯粹、可单测）。

- [ ] **Step 1: 在 `apps/server/src/db/schema.ts` 追加表定义**

```ts
export const facts = sqliteTable("facts", {
  id: text("id").primaryKey(),
  caseId: text("case_id").notNull(),
  type: text("type").notNull(),
  title: text("title").notNull(),
  valueJson: text("value_json").notNull(),
  sourceJson: text("source_json").notNull(),
  confidence: integer("confidence", { mode: "number" }).notNull(),
  tagsJson: text("tags_json").notNull(),
  createdAt: text("created_at").notNull(),
});

export const tasks = sqliteTable("tasks", {
  id: text("id").primaryKey(),
  caseId: text("case_id").notNull(),
  title: text("title").notNull(),
  status: text("status").notNull(),
  reason: text("reason").notNull(),
  blockedByJson: text("blocked_by_json").notNull(),
  triggerWhenJson: text("trigger_when_json").notNull(),
  relatedFactsJson: text("related_facts_json").notNull(),
  priority: text("priority").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const timeline = sqliteTable("timeline", {
  id: text("id").primaryKey(),
  caseId: text("case_id").notNull(),
  eventType: text("event_type").notNull(),
  refId: text("ref_id"),
  detail: text("detail").notNull(),
  createdAt: text("created_at").notNull(),
});
```

> 注：confidence 用 REAL 更合适，但 better-sqlite3 对 number 列存取无碍；为简单起见此处用 integer mode:"number"，SQLite 动态类型实际可存浮点。若后续需要精确浮点，改列定义即可。

- [ ] **Step 2: 在 `apps/server/src/db/client.ts` 的 `sqlite.exec` 中追加建表 DDL**

在现有 `CREATE TABLE ... traffic_entries ...` 之后、`return drizzle(sqlite)` 之前，追加：

```sql
    CREATE TABLE IF NOT EXISTS facts (
      id TEXT PRIMARY KEY, case_id TEXT NOT NULL, type TEXT NOT NULL, title TEXT NOT NULL,
      value_json TEXT NOT NULL, source_json TEXT NOT NULL, confidence REAL NOT NULL,
      tags_json TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_facts_case ON facts(case_id);
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY, case_id TEXT NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL,
      reason TEXT NOT NULL, blocked_by_json TEXT NOT NULL, trigger_when_json TEXT NOT NULL,
      related_facts_json TEXT NOT NULL, priority TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_tasks_case ON tasks(case_id);
    CREATE TABLE IF NOT EXISTS timeline (
      id TEXT PRIMARY KEY, case_id TEXT NOT NULL, event_type TEXT NOT NULL,
      ref_id TEXT, detail TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_timeline_case ON timeline(case_id);
```

- [ ] **Step 3: 写失败测试 `apps/server/src/stores/phase2-stores.test.ts`**

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { createDb, type Db } from "../db/client.js";
import { FactStore } from "./fact-store.js";
import { TaskStore } from "./task-store.js";
import { TimelineStore } from "./timeline-store.js";

let db: Db;
beforeEach(() => { db = createDb(":memory:"); });

describe("FactStore", () => {
  it("creates a fact with generated id and lists it by case", () => {
    const store = new FactStore(db);
    const f = store.create("case_1", {
      type: "login_endpoint", title: "admin login",
      value: { url: "https://t/admin" }, source: { type: "manual", ref: "page_1" },
      confidence: 1, tags: ["auth"],
    });
    expect(f.id).toMatch(/^fact_/);
    expect(f.caseId).toBe("case_1");
    const list = store.listByCase("case_1");
    expect(list).toHaveLength(1);
    expect(list[0].tags).toEqual(["auth"]);
    expect(store.listByCase("other")).toHaveLength(0);
  });
});

describe("TaskStore", () => {
  it("creates a blocked task and updates its status", () => {
    const store = new TaskStore(db);
    const t = store.create("case_1", {
      title: "verify login", status: "blocked", reason: "no creds",
      blockedBy: ["credential"], triggerWhen: ["credential_found"],
      relatedFacts: [], priority: "medium",
    });
    expect(t.id).toMatch(/^task_/);
    expect(t.status).toBe("blocked");
    const updated = store.updateStatus(t.id, "recheck_candidate", "creds found");
    expect(updated?.status).toBe("recheck_candidate");
    expect(updated?.reason).toBe("creds found");
    expect(store.listByCase("case_1")[0].status).toBe("recheck_candidate");
  });

  it("returns undefined when updating a missing task", () => {
    const store = new TaskStore(db);
    expect(store.updateStatus("nope", "done")).toBeUndefined();
  });
});

describe("TimelineStore", () => {
  it("appends and lists entries in chronological order, scoped by case", () => {
    const store = new TimelineStore(db);
    store.append("case_1", "fact_created", "added fact A", "fact_a");
    store.append("case_1", "task_created", "added task B");
    store.append("other", "fact_created", "noise");
    const list = store.listByCase("case_1");
    expect(list).toHaveLength(2);
    expect(list[0].eventType).toBe("fact_created");
    expect(list[0].refId).toBe("fact_a");
    expect(list[1].refId).toBeNull();
  });
});
```

- [ ] **Step 4: 运行确认失败**

Run: `pnpm vitest run apps/server/src/stores/phase2-stores.test.ts`
Expected: FAIL —— 三个 store 模块不存在。

- [ ] **Step 5: 写 `apps/server/src/stores/fact-store.ts`**

```ts
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { facts } from "../db/schema.js";
import { type Fact, FactSchema } from "@traceforge/shared";

type FactInput = Omit<Fact, "id" | "caseId" | "createdAt">;

export class FactStore {
  constructor(private db: Db) {}

  create(caseId: string, input: FactInput): Fact {
    const id = `fact_${randomUUID()}`;
    const createdAt = new Date().toISOString();
    const f = FactSchema.parse({ ...input, id, caseId, createdAt });
    this.db.insert(facts).values({
      id, caseId, type: f.type, title: f.title,
      valueJson: JSON.stringify(f.value), sourceJson: JSON.stringify(f.source),
      confidence: f.confidence, tagsJson: JSON.stringify(f.tags), createdAt,
    }).run();
    return f;
  }

  listByCase(caseId: string): Fact[] {
    return this.db.select().from(facts).where(eq(facts.caseId, caseId)).all().map((row) =>
      FactSchema.parse({
        id: row.id, caseId: row.caseId, type: row.type, title: row.title,
        value: JSON.parse(row.valueJson), source: JSON.parse(row.sourceJson),
        confidence: row.confidence, tags: JSON.parse(row.tagsJson), createdAt: row.createdAt,
      }),
    );
  }
}
```

- [ ] **Step 6: 写 `apps/server/src/stores/task-store.ts`**

```ts
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { tasks } from "../db/schema.js";
import { type Task, TaskSchema } from "@traceforge/shared";

type TaskInput = Omit<Task, "id" | "caseId" | "createdAt" | "updatedAt">;

function rowToTask(row: typeof tasks.$inferSelect): Task {
  return TaskSchema.parse({
    id: row.id, caseId: row.caseId, title: row.title, status: row.status, reason: row.reason,
    blockedBy: JSON.parse(row.blockedByJson), triggerWhen: JSON.parse(row.triggerWhenJson),
    relatedFacts: JSON.parse(row.relatedFactsJson), priority: row.priority,
    createdAt: row.createdAt, updatedAt: row.updatedAt,
  });
}

export class TaskStore {
  constructor(private db: Db) {}

  create(caseId: string, input: TaskInput): Task {
    const id = `task_${randomUUID()}`;
    const now = new Date().toISOString();
    const t = TaskSchema.parse({ ...input, id, caseId, createdAt: now, updatedAt: now });
    this.db.insert(tasks).values({
      id, caseId, title: t.title, status: t.status, reason: t.reason,
      blockedByJson: JSON.stringify(t.blockedBy), triggerWhenJson: JSON.stringify(t.triggerWhen),
      relatedFactsJson: JSON.stringify(t.relatedFacts), priority: t.priority,
      createdAt: now, updatedAt: now,
    }).run();
    return t;
  }

  listByCase(caseId: string): Task[] {
    return this.db.select().from(tasks).where(eq(tasks.caseId, caseId)).all().map(rowToTask);
  }

  updateStatus(id: string, status: Task["status"], reason?: string): Task | undefined {
    const row = this.db.select().from(tasks).where(eq(tasks.id, id)).get();
    if (!row) return undefined;
    const updatedAt = new Date().toISOString();
    const nextReason = reason ?? row.reason;
    this.db.update(tasks)
      .set({ status, reason: nextReason, updatedAt })
      .where(eq(tasks.id, id)).run();
    return rowToTask({ ...row, status, reason: nextReason, updatedAt });
  }
}
```

- [ ] **Step 7: 写 `apps/server/src/stores/timeline-store.ts`**

```ts
import { randomUUID } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { timeline } from "../db/schema.js";
import { type TimelineEntry, TimelineEntrySchema } from "@traceforge/shared";

export class TimelineStore {
  constructor(private db: Db) {}

  append(caseId: string, eventType: string, detail: string, refId?: string): TimelineEntry {
    const id = `tl_${randomUUID()}`;
    const createdAt = new Date().toISOString();
    const e = TimelineEntrySchema.parse({ id, caseId, eventType, refId: refId ?? null, detail, createdAt });
    this.db.insert(timeline).values({
      id, caseId, eventType, refId: e.refId, detail, createdAt,
    }).run();
    return e;
  }

  listByCase(caseId: string): TimelineEntry[] {
    return this.db.select().from(timeline)
      .where(eq(timeline.caseId, caseId)).orderBy(asc(timeline.createdAt)).all()
      .map((row) =>
        TimelineEntrySchema.parse({
          id: row.id, caseId: row.caseId, eventType: row.eventType,
          refId: row.refId, detail: row.detail, createdAt: row.createdAt,
        }),
      );
  }
}
```

- [ ] **Step 8: 运行确认通过**

Run: `pnpm vitest run apps/server/src/stores/phase2-stores.test.ts`
Expected: PASS（FactStore + TaskStore 2 用例 + TimelineStore 全绿）。

> 注：TimelineStore 按 `createdAt` 字符串排序依赖 ISO 时间戳的字典序 == 时间序；同毫秒内插入顺序不保证。本阶段可接受（测试用例不依赖同毫秒区分）；若后续需要严格插入序，加自增 seq 列。

- [ ] **Step 9: Commit**

```bash
git add -A && git commit -m "feat(server): add Fact/Task/Timeline stores and tables with case_id isolation

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: server —— Fact/Task/Timeline 路由与联动

**Files:**
- Modify: `apps/server/src/routes.ts`
- Test: `apps/server/src/routes-phase2.test.ts`

**Interfaces:**
- Consumes: `FactStore`/`TaskStore`/`TimelineStore`（Task 2）、现有 `EventBus`、现有 `registerRoutes` 签名 `(app, db, bus)`。
- Produces（在现有 `registerRoutes` 内追加路由 + 一个可被测试调用的联动）：
  - `POST /api/cases/:id/facts`：body `{ type, title, value, source, confidence?, tags? }` → 建 Fact + append Timeline(`fact_created`) + emit `fact_created` 与 `timeline_appended`。返回 Fact。
  - `GET /api/cases/:id/facts` → Fact[]。
  - `POST /api/cases/:id/tasks`：body 为 TaskInput → 建 Task + Timeline(`task_created`) + emit。返回 Task。
  - `GET /api/cases/:id/tasks` → Task[]。
  - `PATCH /api/tasks/:taskId`：body `{ status, reason? }` → updateStatus + Timeline(`task_updated`) + emit `task_updated`。404 当任务不存在。
  - `GET /api/cases/:id/timeline` → TimelineEntry[]。
  - 抽出一个内部 helper `recordFact` / `recordTaskCreate` / `recordTaskUpdate` 封装"写库 + Timeline + emit"三连，保证联动不被遗漏。

- [ ] **Step 1: 写失败测试 `apps/server/src/routes-phase2.test.ts`（用 Fastify inject，不起真实端口）**

```ts
import { describe, it, expect, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { createDb } from "./db/client.js";
import { EventBus } from "./event-bus.js";
import { registerRoutes } from "./routes.js";
import type { RuntimeEvent } from "@traceforge/shared";

let app: FastifyInstance;
let events: RuntimeEvent[];
let caseId: string;

beforeEach(async () => {
  app = Fastify();
  const db = createDb(":memory:");
  const bus = new EventBus();
  events = [];
  bus.subscribe((e) => events.push(e));
  registerRoutes(app, db, bus);
  await app.ready();
  const res = await app.inject({
    method: "POST", url: "/api/cases",
    payload: { name: "demo", allowHosts: ["t.com"] },
  });
  caseId = res.json().id;
  events.length = 0; // 清掉 case_created
});

describe("facts route", () => {
  it("creates a fact, appends timeline, emits events", async () => {
    const res = await app.inject({
      method: "POST", url: `/api/cases/${caseId}/facts`,
      payload: {
        type: "login_endpoint", title: "admin login",
        value: { url: "https://t.com/admin" }, source: { type: "manual", ref: "page_1" },
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toMatch(/^fact_/);

    const facts = (await app.inject({ url: `/api/cases/${caseId}/facts` })).json();
    expect(facts).toHaveLength(1);

    const tl = (await app.inject({ url: `/api/cases/${caseId}/timeline` })).json();
    expect(tl.some((e: any) => e.eventType === "fact_created")).toBe(true);

    expect(events.some((e) => e.type === "fact_created")).toBe(true);
    expect(events.some((e) => e.type === "timeline_appended")).toBe(true);
  });
});

describe("tasks route", () => {
  it("creates a blocked task and patches its status", async () => {
    const created = await app.inject({
      method: "POST", url: `/api/cases/${caseId}/tasks`,
      payload: { title: "verify login", status: "blocked", blockedBy: ["credential"], triggerWhen: ["credential_found"] },
    });
    const taskId = created.json().id;
    expect(created.json().status).toBe("blocked");

    const patched = await app.inject({
      method: "PATCH", url: `/api/tasks/${taskId}`,
      payload: { status: "recheck_candidate", reason: "creds found" },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().status).toBe("recheck_candidate");

    expect(events.some((e) => e.type === "task_created")).toBe(true);
    expect(events.some((e) => e.type === "task_updated")).toBe(true);
  });

  it("returns 404 when patching a missing task", async () => {
    const res = await app.inject({ method: "PATCH", url: "/api/tasks/nope", payload: { status: "done" } });
    expect(res.statusCode).toBe(404);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run apps/server/src/routes-phase2.test.ts`
Expected: FAIL —— 新路由不存在（facts POST 返回 404）。

- [ ] **Step 3: 修改 `apps/server/src/routes.ts`**

在文件顶部 import 增加三个 store：

```ts
import { FactStore } from "./stores/fact-store.js";
import { TaskStore } from "./stores/task-store.js";
import { TimelineStore } from "./stores/timeline-store.js";
```

在 `registerRoutes` 函数体内（现有 `const traffic = new TrafficStore(db);` 之后）追加：

```ts
  const factStore = new FactStore(db);
  const taskStore = new TaskStore(db);
  const timelineStore = new TimelineStore(db);

  app.post("/api/cases/:id/facts", async (req) => {
    const { id } = req.params as { id: string };
    const input = req.body as Parameters<FactStore["create"]>[1];
    const fact = factStore.create(id, input);
    const entry = timelineStore.append(id, "fact_created", `Fact: ${fact.title}`, fact.id);
    bus.emit({ type: "fact_created", fact });
    bus.emit({ type: "timeline_appended", entry });
    return fact;
  });

  app.get("/api/cases/:id/facts", async (req) => {
    const { id } = req.params as { id: string };
    return factStore.listByCase(id);
  });

  app.post("/api/cases/:id/tasks", async (req) => {
    const { id } = req.params as { id: string };
    const input = req.body as Parameters<TaskStore["create"]>[1];
    const task = taskStore.create(id, input);
    const entry = timelineStore.append(id, "task_created", `Task: ${task.title}`, task.id);
    bus.emit({ type: "task_created", task });
    bus.emit({ type: "timeline_appended", entry });
    return task;
  });

  app.get("/api/cases/:id/tasks", async (req) => {
    const { id } = req.params as { id: string };
    return taskStore.listByCase(id);
  });

  app.patch("/api/tasks/:taskId", async (req, reply) => {
    const { taskId } = req.params as { taskId: string };
    const { status, reason } = req.body as { status: import("@traceforge/shared").Task["status"]; reason?: string };
    const task = taskStore.updateStatus(taskId, status, reason);
    if (!task) return reply.code(404).send({ error: "task not found" });
    const entry = timelineStore.append(task.caseId, "task_updated", `Task ${task.title} → ${status}`, task.id);
    bus.emit({ type: "task_updated", task });
    bus.emit({ type: "timeline_appended", entry });
    return task;
  });

  app.get("/api/cases/:id/timeline", async (req) => {
    const { id } = req.params as { id: string };
    return timelineStore.listByCase(id);
  });
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm vitest run apps/server/src/routes-phase2.test.ts`
Expected: PASS（facts 创建+联动、task 创建+patch、404 全绿）。

- [ ] **Step 5: 类型检查 + 全量 server 测试**

Run: `pnpm --filter @traceforge/server exec tsc --noEmit -p tsconfig.json && pnpm vitest run apps/server`
Expected: tsc 退出码 0；server 全部测试（阶段1 + 阶段2）通过。

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(server): add Fact/Task/Timeline routes with timeline+event linkage

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: web —— FactsPanel / TasksPanel / TimelinePanel 与"标记为 Fact"

**Files:**
- Modify: `apps/web/src/api.ts`
- Modify: `apps/web/src/store.ts`
- Modify: `apps/web/src/App.tsx`

**Interfaces:**
- Consumes: 阶段 2 后端路由（Task 3）、`Fact`/`Task`/`TimelineEntry`/`RuntimeEvent` 类型（`@traceforge/shared`）、现有 web store/api。
- Produces：
  - `api.ts` 新增 `createFact`、`listFacts`、`createTask`、`listTasks`、`patchTask`、`listTimeline`。
  - `store.ts` 在现有 State 上增加 `facts`/`tasks`/`timeline` 数组及其 add/set 方法；`connectWs` 的 onmessage 增加对 `fact_created`/`task_created`/`task_updated`/`timeline_appended` 的处理（按 caseId 过滤）。
  - `App.tsx`：Traffic 表格每行加"Mark as Fact"按钮（弹最简：用 `prompt()` 取 title，type 固定 `api_endpoint`，source `{type:"traffic", ref: t.id}`，value 为该请求 URL）；新增 Facts / Tasks / Timeline 三个列表区块；一个"New blocked task"按钮（prompt 取 title，建 status=blocked 的 task）。

- [ ] **Step 1: 扩展 `apps/web/src/api.ts`（追加函数）**

```ts
import type { Case, TrafficEntry, Fact, Task, TimelineEntry } from "@traceforge/shared";

// ...保留现有 createCase / openUrl / listTraffic ...

export async function createFact(
  caseId: string,
  input: Omit<Fact, "id" | "caseId" | "createdAt" | "confidence" | "tags"> &
    Partial<Pick<Fact, "confidence" | "tags">>,
): Promise<Fact> {
  const r = await fetch(`/api/cases/${caseId}/facts`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input),
  });
  return r.json();
}

export async function listFacts(caseId: string): Promise<Fact[]> {
  return (await fetch(`/api/cases/${caseId}/facts`)).json();
}

export async function createTask(
  caseId: string,
  input: Omit<Task, "id" | "caseId" | "createdAt" | "updatedAt">,
): Promise<Task> {
  const r = await fetch(`/api/cases/${caseId}/tasks`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input),
  });
  return r.json();
}

export async function listTasks(caseId: string): Promise<Task[]> {
  return (await fetch(`/api/cases/${caseId}/tasks`)).json();
}

export async function patchTask(taskId: string, status: Task["status"], reason?: string): Promise<Task> {
  const r = await fetch(`/api/tasks/${taskId}`, {
    method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status, reason }),
  });
  return r.json();
}

export async function listTimeline(caseId: string): Promise<TimelineEntry[]> {
  return (await fetch(`/api/cases/${caseId}/timeline`)).json();
}
```

- [ ] **Step 2: 扩展 `apps/web/src/store.ts`**

```ts
import { create } from "zustand";
import type { TrafficEntry, Fact, Task, TimelineEntry, RuntimeEvent } from "@traceforge/shared";

interface State {
  caseId: string | null;
  traffic: TrafficEntry[];
  facts: Fact[];
  tasks: Task[];
  timeline: TimelineEntry[];
  setCase: (id: string) => void;
  addEntry: (e: TrafficEntry) => void;
  addFact: (f: Fact) => void;
  upsertTask: (t: Task) => void;
  addTimeline: (e: TimelineEntry) => void;
  connectWs: () => void;
}

export const useStore = create<State>((set, get) => ({
  caseId: null,
  traffic: [],
  facts: [],
  tasks: [],
  timeline: [],
  setCase: (id) => set({ caseId: id, traffic: [], facts: [], tasks: [], timeline: [] }),
  addEntry: (e) => set((s) => ({ traffic: [...s.traffic, e] })),
  addFact: (f) => set((s) => ({ facts: [...s.facts, f] })),
  upsertTask: (t) =>
    set((s) => {
      const i = s.tasks.findIndex((x) => x.id === t.id);
      if (i === -1) return { tasks: [...s.tasks, t] };
      const copy = s.tasks.slice();
      copy[i] = t;
      return { tasks: copy };
    }),
  addTimeline: (e) => set((s) => ({ timeline: [...s.timeline, e] })),
  connectWs: () => {
    const ws = new WebSocket(`ws://${location.host}/ws`);
    ws.onmessage = (msg) => {
      const event = JSON.parse(msg.data) as RuntimeEvent;
      const cid = get().caseId;
      if (event.type === "response_captured" && event.entry.caseId === cid) get().addEntry(event.entry);
      else if (event.type === "fact_created" && event.fact.caseId === cid) get().addFact(event.fact);
      else if (event.type === "task_created" && event.task.caseId === cid) get().upsertTask(event.task);
      else if (event.type === "task_updated" && event.task.caseId === cid) get().upsertTask(event.task);
      else if (event.type === "timeline_appended" && event.entry.caseId === cid) get().addTimeline(event.entry);
    };
  },
}));
```

- [ ] **Step 3: 扩展 `apps/web/src/App.tsx`**

在 import 增加新 api，在已有 caseId 分支内：(a) Traffic 表头加一列空表头、每行末尾加 Mark 按钮；(b) 表格下方新增 Facts / Tasks / Timeline 三块；(c) 加 "New blocked task" 按钮。完整替换 `caseId` 为真时的 JSX：

```tsx
import { useEffect, useState } from "react";
import { useStore } from "./store.js";
import { createCase, openUrl, createFact, createTask, patchTask } from "./api.js";

export function App() {
  const { caseId, traffic, facts, tasks, timeline, setCase, connectWs } = useStore();
  const [name, setName] = useState("demo");
  const [hosts, setHosts] = useState("example.com");
  const [url, setUrl] = useState("https://example.com/");

  useEffect(() => { connectWs(); }, [connectWs]);

  if (!caseId) {
    return (
      <div style={{ fontFamily: "sans-serif", padding: 16 }}>
        <h1>TraceForge</h1>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="case name" />
        <input value={hosts} onChange={(e) => setHosts(e.target.value)} placeholder="allow hosts (comma)" />
        <button onClick={async () => {
          const c = await createCase(name, hosts.split(",").map((h) => h.trim()));
          setCase(c.id);
        }}>Create Case</button>
      </div>
    );
  }

  return (
    <div style={{ fontFamily: "sans-serif", padding: 16 }}>
      <h1>TraceForge</h1>
      <p>Case: {caseId}</p>
      <input value={url} onChange={(e) => setUrl(e.target.value)} style={{ width: 360 }} />
      <button onClick={() => openUrl(caseId, url)}>Open</button>

      <h2>Traffic ({traffic.length})</h2>
      <table border={1} cellPadding={4}>
        <thead><tr><th>Method</th><th>Status</th><th>URL</th><th></th></tr></thead>
        <tbody>
          {traffic.map((t) => (
            <tr key={t.id}>
              <td>{t.method}</td><td>{t.responseStatus}</td><td>{t.url}</td>
              <td><button onClick={() => {
                const title = window.prompt("Fact title", t.url) ?? t.url;
                createFact(caseId, {
                  type: "api_endpoint", title,
                  value: { url: t.url, method: t.method }, source: { type: "traffic", ref: t.id },
                });
              }}>Mark as Fact</button></td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Facts ({facts.length})</h2>
      <ul>{facts.map((f) => <li key={f.id}>[{f.type}] {f.title}</li>)}</ul>

      <h2>Tasks ({tasks.length})</h2>
      <button onClick={() => {
        const title = window.prompt("Blocked task title");
        if (title) createTask(caseId, {
          title, status: "blocked", reason: "manually created",
          blockedBy: ["credential"], triggerWhen: ["credential_found"], relatedFacts: [], priority: "medium",
        });
      }}>New blocked task</button>
      <ul>{tasks.map((t) => (
        <li key={t.id}>
          [{t.status}] {t.title}{" "}
          <button onClick={() => patchTask(t.id, "done")}>mark done</button>
        </li>
      ))}</ul>

      <h2>Timeline ({timeline.length})</h2>
      <ol>{timeline.map((e) => <li key={e.id}>{e.eventType}: {e.detail}</li>)}</ol>
    </div>
  );
}
```

- [ ] **Step 4: 类型检查 + 构建**

Run: `pnpm --filter @traceforge/web exec tsc --noEmit -p tsconfig.json && pnpm --filter @traceforge/web build`
Expected: tsc 退出码 0；Vite 构建成功。

- [ ] **Step 5: 端到端手动验证（经 Vite 代理，curl 驱动后端联动）**

Run（项目目录内起后端，curl 经 :5173 代理）:
```bash
# 起后端（参考阶段1 run-server.mjs 模式，dbPath 用 e2e.sqlite）后：
CASE=$(curl -s -X POST localhost:5173/api/cases -H 'content-type: application/json' -d '{"name":"p2","allowHosts":["example.com"]}')
CID=$(echo "$CASE" | sed -E 's/.*"id":"([^"]+)".*/\1/')
curl -s -X POST localhost:5173/api/cases/$CID/facts -H 'content-type: application/json' \
  -d '{"type":"login_endpoint","title":"admin","value":{"url":"x"},"source":{"type":"manual","ref":"r"}}' >/dev/null
TASK=$(curl -s -X POST localhost:5173/api/cases/$CID/tasks -H 'content-type: application/json' \
  -d '{"title":"login","status":"blocked","blockedBy":["credential"],"triggerWhen":["credential_found"]}')
TID=$(echo "$TASK" | sed -E 's/.*"id":"([^"]+)".*/\1/')
curl -s -X PATCH localhost:5173/api/tasks/$TID -H 'content-type: application/json' -d '{"status":"recheck_candidate","reason":"creds"}' >/dev/null
echo "facts: $(curl -s localhost:5173/api/cases/$CID/facts | grep -o '"id":"fact_' | wc -l)"
echo "tasks status: $(curl -s localhost:5173/api/cases/$CID/tasks | grep -o '"status":"[^"]*"')"
echo "timeline events: $(curl -s localhost:5173/api/cases/$CID/timeline | grep -o '"eventType":"[^"]*"')"
```
Expected: facts=1；tasks status 为 `recheck_candidate`；timeline 含 `fact_created`、`task_created`、`task_updated` 三类事件。随后清理后端进程与 e2e.sqlite*。

> 浏览器内"Mark as Fact"按钮 + WebSocket 实时刷新需真人在 `localhost:5173` 点击验证；上面的 curl 已覆盖后端联动与数据正确性。

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(web): add Facts/Tasks/Timeline panels and mark-as-fact action

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: 阶段收尾 —— 全量校验与 README 更新

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: 全部前序任务产物。
- Produces: 更新的进度说明 + 一次全绿的 `pnpm test` 与 `pnpm -r build`。

- [ ] **Step 1: 全量测试**

Run: `pnpm test`
Expected: PASS —— 阶段1（14）+ 阶段2（shared 5、stores 多用例、routes 3）全绿。

- [ ] **Step 2: 全量构建**

Run: `pnpm -r build`
Expected: 各包均无错误。

- [ ] **Step 3: 更新 `README.md` 的"当前进度"小节**

把"当前进度（阶段 0 + 1）"改为"当前进度（阶段 0 + 1 + 2）"，并追加条目：

```markdown
- Facts / Tasks / Timeline：手动标记请求为 Fact、创建挂起（blocked）Task、Timeline 实时回放
```

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "docs: update README for phase 2 (facts/tasks/timeline)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## 自检说明（写给计划作者，非执行步骤）

- **Spec 覆盖**：对应设计文档第 21 章「阶段 2：Facts / Tasks / Timeline」全部交付物（FactStore / TaskStore / TimelineStore / FactsPanel / TasksPanel + Timeline 展示 + blocked task 支持）。重新评估引擎（Reevaluator）属阶段 8，不在本计划；本阶段只建 blocked task + triggerWhen 数据，不实现自动解锁。
- **类型一致性**：Fact/Task/TimelineEntry 单源定义于 `@traceforge/shared`（Task 1），server store（Task 2）与 routes（Task 3）与 web（Task 4）均消费同一份。store 方法签名在 Task 2 定义、Task 3 经 `Parameters<...>` 复用，避免输入类型漂移。`RuntimeEvent` 新分支在 Task 1 定义、Task 3 emit、Task 4 onmessage 消费，三处一致。
- **联动硬约束落点**：store 保持纯持久化（可单测），"写库+Timeline+emit"三连放在路由层（Task 3 Step 3），并由 Task 3 的测试断言 timeline 记录与事件都产生——确保 Global Constraints 的联动要求被测试守住。
- **AI**：本阶段无 LLM 调用，Fact.source.type 仅 manual/traffic，符合阶段约束。
