# Agent 认知内核 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 TraceForge 的 agent 加上跨轮记忆、三层上下文+token预算降级、假设驱动规划、会话状态机，根治「同意/继续不认」与长 Case 爆 context。

**Architecture:** 在 `AgentRuntime`（无状态工具循环）与 LLM 之间插入认知层（`packages/reasoning-core`）：run 前由 ContextBuilder 把会话状态/近期对话/相关 Facts/远期摘要组装成三层上下文 messages，run 后由 LLM 经工具更新 SessionState/Hypothesis。AgentRuntime 改为接收预组装 messages。

**Tech Stack:** TypeScript ESM strict（verbatimModuleSyntax，类型导入用 `import type`）、Zod（schema 单源在 @traceforge/shared）、Drizzle + better-sqlite3、Vitest。

## Global Constraints

- 最高原则「LLM 主导、零硬编码」：领域决策（何时进 exploit 阶段、哪个 Fact 关联哪个假设）走 LLM + 工具，代码不写死规则。
- 开闭枚举原则：系统状态机用闭 enum（phase、hypothesis.status）；LLM 判断/可扩展字段用开放 string（currentGoal、focus.note）。
- 所有业务表带 `case_id` 隔离。
- 证据驱动硬规则延续：record_hypothesis 的 basedOnFactIds 非空，且每个 id 必须是已存在的 Fact。
- 容错降级不崩：认知内核任一环失败，agent run 退回「至少能跑」状态，绝不让 run 报错失败。
- Schema 单源：所有实体 schema 定义在 `packages/shared/src/schemas.ts`，store/工具复用，不重复定义类型。
- 工具模式：`make<Name>Tool(caseId, writer): ToolDescriptor`，写操作走注入接口（便于单测）。ToolDescriptor 形状见 `packages/extension/src/tool.ts`：`{ name, description, inputSchema, risk: "normal"|"command", source, execute }`。
- Store 模式：构造接 `Db`，方法内 `Schema.parse(...)` 后 insert/select，select 后再 parse 回。样板见 `apps/server/src/stores/observer-store.ts`。
- 内部状态工具（update_session_state/record_hypothesis/resolve_hypothesis）risk=normal（不对外发包，不过 ApprovalGate）。
- 提交信息结尾加 `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`。

---

## File Structure

**新建 schema（shared）：** `packages/shared/src/schemas.ts` 追加 SessionStateSchema / HypothesisSchema / ContextSummarySchema。

**新建库表（server）：** `apps/server/src/db/schema.ts` 追加 sessionState / hypotheses / contextSummaries；`apps/server/src/db/client.ts` 追加 CREATE TABLE。

**新建 store（server）：**
- `apps/server/src/stores/session-state-store.ts` — get/upsert SessionState（每 case 一行）
- `apps/server/src/stores/hypothesis-store.ts` — create/getById/update/listByCase
- `apps/server/src/stores/context-summary-store.ts` — append/listByCase/latestSeq

**新建工具（extension）：** `packages/extension/src/cognitive-tools.ts` — update_session_state / record_hypothesis / resolve_hypothesis 三工具 + 注入接口。

**新建认知核心（reasoning-core）：**
- `packages/reasoning-core/src/relevance.ts` — relevanceScore + topK
- `packages/reasoning-core/src/token-estimate.ts` — 字符估算 token
- `packages/reasoning-core/src/memory-assembler.ts` — 近期对话 + Facts 检索拼装
- `packages/reasoning-core/src/compressor.ts` — LLM 摘要 + 规则回退
- `packages/reasoning-core/src/context-builder.ts` — 三层组装 + 预算降级
- `packages/reasoning-core/src/index.ts` — 导出

**接线（server）：** `apps/server/src/routes.ts` 的 agent/run 用 ContextBuilder 替换单句 goal + 注册 3 工具。

---

## Task A1: SessionState schema + 表

**Files:**
- Modify: `packages/shared/src/schemas.ts`（文件末尾追加）
- Modify: `apps/server/src/db/schema.ts`（在 observerWarnings 之后追加）
- Modify: `apps/server/src/db/client.ts`（在 agent_events CREATE 之后追加）
- Test: `packages/shared/src/cognitive-schemas.test.ts`

**Interfaces:**
- Produces: `SessionStateSchema`、`type SessionState = { caseId; currentGoal; phase; focus; activeHypothesisIds; updatedAt }`

- [ ] **Step 1: 写失败测试**

```ts
// packages/shared/src/cognitive-schemas.test.ts
import { describe, it, expect } from "vitest";
import { SessionStateSchema } from "./schemas.js";

describe("SessionStateSchema", () => {
  it("parses with defaults and closed phase enum", () => {
    const s = SessionStateSchema.parse({ caseId: "c1", updatedAt: "t" });
    expect(s.phase).toBe("recon");
    expect(s.currentGoal).toBe("");
    expect(s.focus).toEqual({});
    expect(s.activeHypothesisIds).toEqual([]);
  });
  it("rejects invalid phase", () => {
    expect(() => SessionStateSchema.parse({ caseId: "c1", phase: "hacking", updatedAt: "t" })).toThrow();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @traceforge/shared exec vitest run src/cognitive-schemas.test.ts`
Expected: FAIL（SessionStateSchema 未导出）

- [ ] **Step 3: 实现 schema**

在 `packages/shared/src/schemas.ts` 末尾追加：

```ts
export const SessionStateSchema = z.object({
  caseId: z.string(),
  currentGoal: z.string().default(""),
  phase: z.enum(["recon", "analyze", "exploit", "report"]).default("recon"),
  focus: z.object({
    host: z.string().optional(),
    url: z.string().optional(),
    note: z.string().optional(),
  }).default({}),
  activeHypothesisIds: z.array(z.string()).default([]),
  updatedAt: z.string(),
});
export type SessionState = z.infer<typeof SessionStateSchema>;
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @traceforge/shared exec vitest run src/cognitive-schemas.test.ts`
Expected: PASS

- [ ] **Step 5: 加库表**

在 `apps/server/src/db/schema.ts` 的 observerWarnings 定义之后追加：

```ts
export const sessionState = sqliteTable("session_state", {
  caseId: text("case_id").primaryKey(),
  currentGoal: text("current_goal").notNull(),
  phase: text("phase").notNull(),
  focusJson: text("focus_json").notNull(),
  activeHypothesisIdsJson: text("active_hypothesis_ids_json").notNull(),
  updatedAt: text("updated_at").notNull(),
});
```

在 `apps/server/src/db/client.ts` 的 agent_events CREATE INDEX 之后追加（在同一 exec 模板字符串内）：

```sql
    CREATE TABLE IF NOT EXISTS session_state (
      case_id TEXT PRIMARY KEY,
      current_goal TEXT NOT NULL, phase TEXT NOT NULL,
      focus_json TEXT NOT NULL, active_hypothesis_ids_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
```

- [ ] **Step 6: build 确认编译**

Run: `pnpm --filter @traceforge/shared build && pnpm --filter @traceforge/server build`
Expected: 两个都 exit 0

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/schemas.ts packages/shared/src/cognitive-schemas.test.ts apps/server/src/db/schema.ts apps/server/src/db/client.ts
git commit -m "feat(cognitive): SessionState schema + session_state 表"
```

---

## Task A2: SessionStateStore（get/upsert，每 case 一行）

**Files:**
- Create: `apps/server/src/stores/session-state-store.ts`
- Test: `apps/server/src/stores/session-state-store.test.ts`

**Interfaces:**
- Consumes: `SessionState`、`SessionStateSchema`（Task A1）、`sessionState` 表（Task A1）、`createDb`（`apps/server/src/db/client.ts`）
- Produces: `class SessionStateStore { constructor(db: Db); get(caseId: string): SessionState | undefined; upsert(caseId: string, patch: Partial<Pick<SessionState, "currentGoal"|"phase"|"focus"|"activeHypothesisIds">>): SessionState }`

- [ ] **Step 1: 写失败测试**

```ts
// apps/server/src/stores/session-state-store.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { createDb } from "../db/client.js";
import { SessionStateStore } from "./session-state-store.js";

let store: SessionStateStore;
beforeEach(() => { store = new SessionStateStore(createDb(":memory:")); });

describe("SessionStateStore", () => {
  it("returns undefined before any upsert", () => {
    expect(store.get("c1")).toBeUndefined();
  });
  it("upsert creates then updates the single row", () => {
    const a = store.upsert("c1", { currentGoal: "测越权", phase: "analyze" });
    expect(a.currentGoal).toBe("测越权");
    expect(a.phase).toBe("analyze");
    const b = store.upsert("c1", { focus: { host: "x.com" } });
    expect(b.currentGoal).toBe("测越权"); // 保留旧值
    expect(b.focus).toEqual({ host: "x.com" });
    expect(store.get("c1")?.phase).toBe("analyze");
  });
  it("isolates by case", () => {
    store.upsert("c1", { currentGoal: "a" });
    expect(store.get("c2")).toBeUndefined();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @traceforge/server exec vitest run src/stores/session-state-store.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 store**

```ts
// apps/server/src/stores/session-state-store.ts
import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { sessionState } from "../db/schema.js";
import { type SessionState, SessionStateSchema } from "@traceforge/shared";

export class SessionStateStore {
  constructor(private db: Db) {}

  get(caseId: string): SessionState | undefined {
    const row = this.db.select().from(sessionState).where(eq(sessionState.caseId, caseId)).get();
    if (!row) return undefined;
    return SessionStateSchema.parse({
      caseId: row.caseId, currentGoal: row.currentGoal, phase: row.phase,
      focus: JSON.parse(row.focusJson), activeHypothesisIds: JSON.parse(row.activeHypothesisIdsJson),
      updatedAt: row.updatedAt,
    });
  }

  upsert(
    caseId: string,
    patch: Partial<Pick<SessionState, "currentGoal" | "phase" | "focus" | "activeHypothesisIds">>,
  ): SessionState {
    const cur = this.get(caseId);
    const next = SessionStateSchema.parse({
      caseId,
      currentGoal: patch.currentGoal ?? cur?.currentGoal ?? "",
      phase: patch.phase ?? cur?.phase ?? "recon",
      focus: patch.focus ?? cur?.focus ?? {},
      activeHypothesisIds: patch.activeHypothesisIds ?? cur?.activeHypothesisIds ?? [],
      updatedAt: new Date().toISOString(),
    });
    const values = {
      caseId, currentGoal: next.currentGoal, phase: next.phase,
      focusJson: JSON.stringify(next.focus),
      activeHypothesisIdsJson: JSON.stringify(next.activeHypothesisIds),
      updatedAt: next.updatedAt,
    };
    this.db.insert(sessionState).values(values)
      .onConflictDoUpdate({ target: sessionState.caseId, set: values }).run();
    return next;
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @traceforge/server exec vitest run src/stores/session-state-store.test.ts`
Expected: PASS（3 tests）

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/stores/session-state-store.ts apps/server/src/stores/session-state-store.test.ts
git commit -m "feat(cognitive): SessionStateStore get/upsert"
```

---

## Task B1: Hypothesis schema + 表

**Files:**
- Modify: `packages/shared/src/schemas.ts`（末尾追加）
- Modify: `apps/server/src/db/schema.ts`（sessionState 之后追加）
- Modify: `apps/server/src/db/client.ts`（session_state CREATE 之后追加）
- Test: `packages/shared/src/cognitive-schemas.test.ts`（追加 describe）

**Interfaces:**
- Produces: `HypothesisSchema`、`type Hypothesis = { id; caseId; statement; status; basedOnFactIds; relatedTaskIds; createdAt; updatedAt; updateCount }`

- [ ] **Step 1: 追加失败测试**

在 `packages/shared/src/cognitive-schemas.test.ts` 追加：

```ts
import { HypothesisSchema } from "./schemas.js";

describe("HypothesisSchema", () => {
  it("parses with defaults", () => {
    const h = HypothesisSchema.parse({ id: "h1", caseId: "c1", statement: "可能越权", basedOnFactIds: ["f1"], createdAt: "t", updatedAt: "t" });
    expect(h.status).toBe("open");
    expect(h.relatedTaskIds).toEqual([]);
    expect(h.updateCount).toBe(0);
  });
  it("rejects invalid status", () => {
    expect(() => HypothesisSchema.parse({ id: "h1", caseId: "c1", statement: "x", basedOnFactIds: ["f1"], status: "maybe", createdAt: "t", updatedAt: "t" })).toThrow();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @traceforge/shared exec vitest run src/cognitive-schemas.test.ts`
Expected: FAIL（HypothesisSchema 未导出）

- [ ] **Step 3: 实现 schema**

在 `packages/shared/src/schemas.ts` 末尾追加：

```ts
export const HypothesisSchema = z.object({
  id: z.string(),
  caseId: z.string(),
  statement: z.string().min(1),
  status: z.enum(["open", "confirmed", "refuted"]).default("open"),
  basedOnFactIds: z.array(z.string()),
  relatedTaskIds: z.array(z.string()).default([]),
  createdAt: z.string(),
  updatedAt: z.string(),
  updateCount: z.number().default(0),
});
export type Hypothesis = z.infer<typeof HypothesisSchema>;
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @traceforge/shared exec vitest run src/cognitive-schemas.test.ts`
Expected: PASS

- [ ] **Step 5: 加库表**

`apps/server/src/db/schema.ts` 追加：

```ts
export const hypotheses = sqliteTable("hypotheses", {
  id: text("id").primaryKey(),
  caseId: text("case_id").notNull(),
  statement: text("statement").notNull(),
  status: text("status").notNull(),
  basedOnFactIdsJson: text("based_on_fact_ids_json").notNull(),
  relatedTaskIdsJson: text("related_task_ids_json").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  updateCount: integer("update_count").notNull(),
});
```

`apps/server/src/db/client.ts` 追加：

```sql
    CREATE TABLE IF NOT EXISTS hypotheses (
      id TEXT PRIMARY KEY, case_id TEXT NOT NULL, statement TEXT NOT NULL,
      status TEXT NOT NULL, based_on_fact_ids_json TEXT NOT NULL,
      related_task_ids_json TEXT NOT NULL, created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL, update_count INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_hypotheses_case ON hypotheses(case_id);
```

- [ ] **Step 6: build 确认**

Run: `pnpm --filter @traceforge/shared build && pnpm --filter @traceforge/server build`
Expected: exit 0

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/schemas.ts packages/shared/src/cognitive-schemas.test.ts apps/server/src/db/schema.ts apps/server/src/db/client.ts
git commit -m "feat(cognitive): Hypothesis schema + hypotheses 表"
```

---

## Task B2: HypothesisStore（create/getById/update/listByCase）

**Files:**
- Create: `apps/server/src/stores/hypothesis-store.ts`
- Test: `apps/server/src/stores/hypothesis-store.test.ts`

**Interfaces:**
- Consumes: `Hypothesis`、`HypothesisSchema`、`hypotheses` 表、`createDb`
- Produces: `class HypothesisStore { constructor(db: Db); create(caseId, input: { statement; basedOnFactIds; relatedTaskIds? }): Hypothesis; getById(id): Hypothesis | undefined; update(id, patch: Partial<Pick<Hypothesis,"status"|"relatedTaskIds"|"statement">>): Hypothesis | undefined; listByCase(caseId): Hypothesis[] }`

- [ ] **Step 1: 写失败测试**

```ts
// apps/server/src/stores/hypothesis-store.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { createDb } from "../db/client.js";
import { HypothesisStore } from "./hypothesis-store.js";

let store: HypothesisStore;
beforeEach(() => { store = new HypothesisStore(createDb(":memory:")); });

describe("HypothesisStore", () => {
  it("create assigns id, defaults status open + updateCount 0", () => {
    const h = store.create("c1", { statement: "越权", basedOnFactIds: ["f1"] });
    expect(h.id).toMatch(/^hyp_/);
    expect(h.status).toBe("open");
    expect(h.updateCount).toBe(0);
    expect(store.getById(h.id)?.statement).toBe("越权");
  });
  it("update changes status and bumps updateCount", () => {
    const h = store.create("c1", { statement: "x", basedOnFactIds: ["f1"] });
    const u = store.update(h.id, { status: "confirmed" });
    expect(u?.status).toBe("confirmed");
    expect(u?.updateCount).toBe(1);
  });
  it("listByCase isolates", () => {
    store.create("c1", { statement: "a", basedOnFactIds: ["f1"] });
    store.create("c2", { statement: "b", basedOnFactIds: ["f2"] });
    expect(store.listByCase("c1")).toHaveLength(1);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @traceforge/server exec vitest run src/stores/hypothesis-store.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 store**

```ts
// apps/server/src/stores/hypothesis-store.ts
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { hypotheses } from "../db/schema.js";
import { type Hypothesis, HypothesisSchema } from "@traceforge/shared";

export class HypothesisStore {
  constructor(private db: Db) {}

  private rowToH(row: typeof hypotheses.$inferSelect): Hypothesis {
    return HypothesisSchema.parse({
      id: row.id, caseId: row.caseId, statement: row.statement, status: row.status,
      basedOnFactIds: JSON.parse(row.basedOnFactIdsJson),
      relatedTaskIds: JSON.parse(row.relatedTaskIdsJson),
      createdAt: row.createdAt, updatedAt: row.updatedAt, updateCount: row.updateCount,
    });
  }

  create(caseId: string, input: { statement: string; basedOnFactIds: string[]; relatedTaskIds?: string[] }): Hypothesis {
    const now = new Date().toISOString();
    const h = HypothesisSchema.parse({
      id: `hyp_${randomUUID()}`, caseId, statement: input.statement,
      basedOnFactIds: input.basedOnFactIds, relatedTaskIds: input.relatedTaskIds ?? [],
      createdAt: now, updatedAt: now, updateCount: 0,
    });
    this.db.insert(hypotheses).values({
      id: h.id, caseId, statement: h.statement, status: h.status,
      basedOnFactIdsJson: JSON.stringify(h.basedOnFactIds),
      relatedTaskIdsJson: JSON.stringify(h.relatedTaskIds),
      createdAt: now, updatedAt: now, updateCount: 0,
    }).run();
    return h;
  }

  getById(id: string): Hypothesis | undefined {
    const row = this.db.select().from(hypotheses).where(eq(hypotheses.id, id)).get();
    return row ? this.rowToH(row) : undefined;
  }

  update(id: string, patch: Partial<Pick<Hypothesis, "status" | "relatedTaskIds" | "statement">>): Hypothesis | undefined {
    const cur = this.getById(id);
    if (!cur) return undefined;
    const next: Hypothesis = {
      ...cur,
      statement: patch.statement ?? cur.statement,
      status: patch.status ?? cur.status,
      relatedTaskIds: patch.relatedTaskIds ?? cur.relatedTaskIds,
      updatedAt: new Date().toISOString(),
      updateCount: cur.updateCount + 1,
    };
    this.db.update(hypotheses).set({
      statement: next.statement, status: next.status,
      relatedTaskIdsJson: JSON.stringify(next.relatedTaskIds),
      updatedAt: next.updatedAt, updateCount: next.updateCount,
    }).where(eq(hypotheses.id, id)).run();
    return next;
  }

  listByCase(caseId: string): Hypothesis[] {
    return this.db.select().from(hypotheses).where(eq(hypotheses.caseId, caseId)).all().map((r) => this.rowToH(r));
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @traceforge/server exec vitest run src/stores/hypothesis-store.test.ts`
Expected: PASS（3 tests）

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/stores/hypothesis-store.ts apps/server/src/stores/hypothesis-store.test.ts
git commit -m "feat(cognitive): HypothesisStore CRUD"
```

---

## Task B3: 认知工具（update_session_state / record_hypothesis / resolve_hypothesis）

**Files:**
- Create: `packages/extension/src/cognitive-tools.ts`
- Test: `packages/extension/src/cognitive-tools.test.ts`

**Interfaces:**
- Consumes: `ToolDescriptor`（`./tool.js`）；注入接口（store 的子集，便于单测）
- Produces:
  - `interface SessionStateWriter { upsert(caseId, patch): { phase: string } }`
  - `interface HypothesisWriter { create(caseId, input): { id: string }; getById(id): { id; status: string } | undefined; update(id, patch): { id; status: string } | undefined }`
  - `interface FactReader { getById(id): { id: string } | undefined }`
  - `makeUpdateSessionStateTool(caseId, ss: SessionStateWriter): ToolDescriptor`
  - `makeRecordHypothesisTool(caseId, hyp: HypothesisWriter, facts: FactReader): ToolDescriptor`
  - `makeResolveHypothesisTool(caseId, hyp: HypothesisWriter, facts: FactReader): ToolDescriptor`

- [ ] **Step 1: 写失败测试**

```ts
// packages/extension/src/cognitive-tools.test.ts
import { describe, it, expect } from "vitest";
import { makeUpdateSessionStateTool, makeRecordHypothesisTool, makeResolveHypothesisTool } from "./cognitive-tools.js";

const facts = { getById: (id: string) => (id === "f1" ? { id: "f1" } : undefined) };

describe("update_session_state tool", () => {
  it("upserts goal/phase/focus", async () => {
    const calls: unknown[] = [];
    const ss = { upsert: (_c: string, p: unknown) => { calls.push(p); return { phase: "analyze" }; } };
    const t = makeUpdateSessionStateTool("c1", ss);
    const r = await t.execute({ currentGoal: "测越权", phase: "analyze" });
    expect(r.ok).toBe(true);
    expect(calls[0]).toMatchObject({ currentGoal: "测越权", phase: "analyze" });
  });
});

describe("record_hypothesis tool", () => {
  it("rejects empty basedOnFactIds", async () => {
    const hyp = { create: () => ({ id: "h1" }), getById: () => undefined, update: () => undefined };
    const t = makeRecordHypothesisTool("c1", hyp, facts);
    const r = await t.execute({ statement: "x", basedOnFactIds: [] });
    expect(r.ok).toBe(false);
    expect(r.content).toContain("基于");
  });
  it("rejects basedOnFactIds referencing non-existent fact", async () => {
    const hyp = { create: () => ({ id: "h1" }), getById: () => undefined, update: () => undefined };
    const t = makeRecordHypothesisTool("c1", hyp, facts);
    const r = await t.execute({ statement: "x", basedOnFactIds: ["nope"] });
    expect(r.ok).toBe(false);
  });
  it("creates when facts exist", async () => {
    const hyp = { create: () => ({ id: "h1" }), getById: () => undefined, update: () => undefined };
    const t = makeRecordHypothesisTool("c1", hyp, facts);
    const r = await t.execute({ statement: "x", basedOnFactIds: ["f1"] });
    expect(r.ok).toBe(true);
    expect(r.content).toContain("h1");
  });
});

describe("resolve_hypothesis tool", () => {
  it("confirmed requires a confirming fact id", async () => {
    const hyp = { create: () => ({ id: "h1" }), getById: () => ({ id: "h1", status: "open" }), update: () => ({ id: "h1", status: "confirmed" }) };
    const t = makeResolveHypothesisTool("c1", hyp, facts);
    const bad = await t.execute({ id: "h1", status: "confirmed" });
    expect(bad.ok).toBe(false);
    const good = await t.execute({ id: "h1", status: "confirmed", confirmingFactId: "f1" });
    expect(good.ok).toBe(true);
  });
  it("refuted does not require a fact", async () => {
    const hyp = { create: () => ({ id: "h1" }), getById: () => ({ id: "h1", status: "open" }), update: () => ({ id: "h1", status: "refuted" }) };
    const t = makeResolveHypothesisTool("c1", hyp, facts);
    const r = await t.execute({ id: "h1", status: "refuted" });
    expect(r.ok).toBe(true);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @traceforge/extension exec vitest run src/cognitive-tools.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现工具**

```ts
// packages/extension/src/cognitive-tools.ts
import type { ToolDescriptor } from "./tool.js";

export interface SessionStateWriter {
  upsert(caseId: string, patch: { currentGoal?: string; phase?: string; focus?: { host?: string; url?: string; note?: string }; activeHypothesisIds?: string[] }): { phase: string };
}
export interface HypothesisWriter {
  create(caseId: string, input: { statement: string; basedOnFactIds: string[]; relatedTaskIds?: string[] }): { id: string };
  getById(id: string): { id: string; status: string } | undefined;
  update(id: string, patch: { status?: string; relatedTaskIds?: string[]; statement?: string }): { id: string; status: string } | undefined;
}
export interface FactReader {
  getById(id: string): { id: string } | undefined;
}

export function makeUpdateSessionStateTool(caseId: string, ss: SessionStateWriter): ToolDescriptor {
  return {
    name: "update_session_state",
    description: "更新当前会话状态：currentGoal（你正在追的目标）、phase（recon/analyze/exploit/report）、focus（当前关注的 host/url/说明）。在目标或关注点变化时调用，帮助你和系统对齐当前在做什么。",
    inputSchema: {
      type: "object",
      properties: {
        currentGoal: { type: "string" },
        phase: { type: "string", enum: ["recon", "analyze", "exploit", "report"] },
        focus: { type: "object", properties: { host: { type: "string" }, url: { type: "string" }, note: { type: "string" } } },
      },
    },
    risk: "normal",
    source: "builtin",
    execute: async (input) => {
      const p = (input ?? {}) as Parameters<SessionStateWriter["upsert"]>[1];
      const r = ss.upsert(caseId, p);
      return { ok: true, content: `会话状态已更新（phase=${r.phase}）` };
    },
  };
}

export function makeRecordHypothesisTool(caseId: string, hyp: HypothesisWriter, facts: FactReader): ToolDescriptor {
  return {
    name: "record_hypothesis",
    description: "记录一个可验证的假设（如「订单接口可能存在越权」）。必须基于已记录的 Fact（basedOnFactIds 非空且引用真实 Fact）——无证据的猜测会被拒绝。记录后应建 Task 去验证它。",
    inputSchema: {
      type: "object",
      properties: {
        statement: { type: "string" },
        basedOnFactIds: { type: "array", items: { type: "string" } },
        relatedTaskIds: { type: "array", items: { type: "string" } },
      },
      required: ["statement", "basedOnFactIds"],
    },
    risk: "normal",
    source: "builtin",
    execute: async (input) => {
      const { statement, basedOnFactIds, relatedTaskIds } = (input ?? {}) as { statement?: string; basedOnFactIds?: string[]; relatedTaskIds?: string[] };
      if (!statement) return { ok: false, content: "缺少 statement" };
      if (!basedOnFactIds || basedOnFactIds.length === 0) return { ok: false, content: "假设必须基于已记录的 Fact：basedOnFactIds 不能为空。" };
      const missing = basedOnFactIds.filter((id) => !facts.getById(id));
      if (missing.length > 0) return { ok: false, content: `basedOnFactIds 引用了不存在的 Fact：${missing.join(", ")}` };
      const h = hyp.create(caseId, { statement, basedOnFactIds, relatedTaskIds });
      return { ok: true, content: `已记录假设 ${h.id}：${statement}` };
    },
  };
}

export function makeResolveHypothesisTool(caseId: string, hyp: HypothesisWriter, facts: FactReader): ToolDescriptor {
  void caseId;
  return {
    name: "resolve_hypothesis",
    description: "对一个假设下结论：confirmed（已证实，须用 confirmingFactId 引用证实它的新 Fact）或 refuted（已排除）。证实的假设应转为 finding Fact 并生成 Action Card。",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        status: { type: "string", enum: ["confirmed", "refuted"] },
        confirmingFactId: { type: "string" },
      },
      required: ["id", "status"],
    },
    risk: "normal",
    source: "builtin",
    execute: async (input) => {
      const { id, status, confirmingFactId } = (input ?? {}) as { id?: string; status?: "confirmed" | "refuted"; confirmingFactId?: string };
      if (!id || !status) return { ok: false, content: "缺少 id 或 status" };
      if (!hyp.getById(id)) return { ok: false, content: `未找到假设 ${id}` };
      if (status === "confirmed") {
        if (!confirmingFactId || !facts.getById(confirmingFactId)) {
          return { ok: false, content: "确认假设须用 confirmingFactId 引用一个已记录的、证实它的 Fact。" };
        }
      }
      const r = hyp.update(id, { status });
      return { ok: true, content: `假设 ${id} → ${r?.status}` };
    },
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @traceforge/extension exec vitest run src/cognitive-tools.test.ts`
Expected: PASS（6 tests）

- [ ] **Step 5: 从 index 导出**

在 `packages/extension/src/index.ts` 追加：

```ts
export * from "./cognitive-tools.js";
```

- [ ] **Step 6: Commit**

```bash
git add packages/extension/src/cognitive-tools.ts packages/extension/src/cognitive-tools.test.ts packages/extension/src/index.ts
git commit -m "feat(cognitive): 3 认知工具（session-state/hypothesis）含证据驱动校验"
```

---

## Task C1: token 估算

**Files:**
- Create: `packages/reasoning-core/src/token-estimate.ts`
- Test: `packages/reasoning-core/src/token-estimate.test.ts`

**Interfaces:**
- Produces: `estimateTokens(text: string): number`（字符估算：ASCII 约 4 字符/token，CJK 约 1.5 字符/token）

- [ ] **Step 1: 写失败测试**

```ts
// packages/reasoning-core/src/token-estimate.test.ts
import { describe, it, expect } from "vitest";
import { estimateTokens } from "./token-estimate.js";

describe("estimateTokens", () => {
  it("empty is 0", () => { expect(estimateTokens("")).toBe(0); });
  it("ascii ~ chars/4", () => {
    expect(estimateTokens("a".repeat(40))).toBe(10);
  });
  it("cjk weighs more than ascii of same length", () => {
    expect(estimateTokens("你".repeat(40))).toBeGreaterThan(estimateTokens("a".repeat(40)));
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @traceforge/reasoning-core exec vitest run src/token-estimate.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

```ts
// packages/reasoning-core/src/token-estimate.ts
// 字符估算 token，无需 tokenizer 库。CJK 字符信息密度高，按更高权重计。
// 偏差走保守方向（宁可高估→少塞内容→不爆窗口）。
export function estimateTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    if (/[　-鿿＀-￯]/.test(ch)) cjk++;
    else other++;
  }
  return Math.ceil(cjk / 1.5 + other / 4);
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @traceforge/reasoning-core exec vitest run src/token-estimate.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/reasoning-core/src/token-estimate.ts packages/reasoning-core/src/token-estimate.test.ts
git commit -m "feat(cognitive): token 字符估算"
```

---

## Task C2: 相关性检索（relevance.topK）

**Files:**
- Create: `packages/reasoning-core/src/relevance.ts`
- Test: `packages/reasoning-core/src/relevance.test.ts`

**Interfaces:**
- Consumes: `Fact`（`@traceforge/shared`）
- Produces:
  - `interface Focus { host?: string; url?: string; note?: string; goal?: string }`
  - `interface ConsumedSet { has(factId: string): boolean }`
  - `relevanceScore(fact: Fact, focus: Focus, consumed?: ConsumedSet): number`
  - `topK(facts: Fact[], focus: Focus, k: number, consumed?: ConsumedSet): Fact[]`（跨 scope=host 不匹配的 fact score 置 0 并排除）

> 简化说明（符合 spec §7 YAGNI）：spec §3.1 的「图距离」因子第一版不实现（需 graph 子图，成本高收益边际）。本版用 host 匹配 + 关键词命中 + 新鲜度 + 已消费惩罚四因子，已足够驱动 Top-K。`RelevanceStrategy` 的可替换性体现在 relevanceScore 是纯函数，日后可加图距离/向量而不改调用方。

- [ ] **Step 1: 写失败测试**

```ts
// packages/reasoning-core/src/relevance.test.ts
import { describe, it, expect } from "vitest";
import { relevanceScore, topK } from "./relevance.js";
import type { Fact } from "@traceforge/shared";

function fact(p: Partial<Fact>): Fact {
  return { id: "f", caseId: "c", type: "note", title: "t", value: {}, source: { type: "manual", ref: "x" }, confidence: 1, tags: [], createdAt: "2026-01-01T00:00:00Z", updateCount: 0, updatedAt: "", validity: "valid", ...p } as Fact;
}

describe("relevanceScore", () => {
  it("same-host fact scores higher than cross-host", () => {
    const focus = { host: "a.com" };
    const same = relevanceScore(fact({ title: "login on a.com", tags: ["host:a.com"] }), focus);
    const cross = relevanceScore(fact({ title: "x on b.com", tags: ["host:b.com"] }), focus);
    expect(same).toBeGreaterThan(cross);
  });
  it("goal keyword match raises score", () => {
    const focus = { goal: "测试登录越权" };
    const hit = relevanceScore(fact({ type: "login_endpoint", title: "登录接口" }), focus);
    const miss = relevanceScore(fact({ type: "note", title: "无关页面" }), focus);
    expect(hit).toBeGreaterThan(miss);
  });
  it("consumed exploratory fact is penalized", () => {
    const focus = { host: "a.com" };
    const f = fact({ id: "f1", title: "x on a.com", tags: ["host:a.com"] });
    const normal = relevanceScore(f, focus);
    const penalized = relevanceScore(f, focus, { has: (id) => id === "f1" });
    expect(penalized).toBeLessThan(normal);
  });
});

describe("topK", () => {
  it("returns top k by score, drops cross-scope", () => {
    const focus = { host: "a.com" };
    const facts = [
      fact({ id: "1", title: "a.com login", tags: ["host:a.com"] }),
      fact({ id: "2", title: "b.com thing", tags: ["host:b.com"] }),
      fact({ id: "3", title: "a.com api", tags: ["host:a.com"] }),
    ];
    const res = topK(facts, focus, 2);
    expect(res.map((f) => f.id)).not.toContain("2");
    expect(res.length).toBeLessThanOrEqual(2);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @traceforge/reasoning-core exec vitest run src/relevance.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

```ts
// packages/reasoning-core/src/relevance.ts
import type { Fact } from "@traceforge/shared";

export interface Focus { host?: string; url?: string; note?: string; goal?: string }
export interface ConsumedSet { has(factId: string): boolean }

function hostOf(fact: Fact): string | undefined {
  const tag = fact.tags.find((t) => t.startsWith("host:"));
  return tag ? tag.slice(5) : undefined;
}

// 跨 scope（host 已知且不匹配）置 0；其余按类型/关键词/新鲜度/已消费综合打分。
export function relevanceScore(fact: Fact, focus: Focus, consumed?: ConsumedSet): number {
  const fHost = hostOf(fact);
  if (focus.host && fHost && fHost !== focus.host) return 0; // 跨 scope 直接 0

  let score = 1; // 基础分
  if (focus.host && fHost === focus.host) score += 3; // 同 host

  // 关键词命中：goal/note 文本与 fact 的 type+title 重叠
  const focusText = `${focus.goal ?? ""} ${focus.note ?? ""}`.toLowerCase();
  const factText = `${fact.type} ${fact.title}`.toLowerCase();
  if (focusText && factText) {
    const tokens = focusText.split(/[\s,，。/]+/).filter((w) => w.length >= 2);
    const hits = tokens.filter((w) => factText.includes(w)).length;
    score += hits * 2;
  }

  // 时间新鲜度：越新越高（confirmed 关键事实不衰减——validity=valid 且 confidence≥1 视为关键）
  const ageMs = Date.now() - new Date(fact.createdAt).getTime();
  const ageDays = ageMs / 86_400_000;
  const isKey = fact.validity === "valid" && fact.confidence >= 1;
  if (!isKey) score += Math.max(0, 2 - ageDays * 0.1);

  // 已消费惩罚（已被采纳进成功 Action 的探索性 fact 降权）
  if (consumed?.has(fact.id)) score -= 2;

  return score;
}

export function topK(facts: Fact[], focus: Focus, k: number, consumed?: ConsumedSet): Fact[] {
  return facts
    .map((f) => ({ f, s: relevanceScore(f, focus, consumed) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, k)
    .map((x) => x.f);
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @traceforge/reasoning-core exec vitest run src/relevance.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/reasoning-core/src/relevance.ts packages/reasoning-core/src/relevance.test.ts
git commit -m "feat(cognitive): 相关性检索 relevanceScore + topK"
```

---

## Task D1: ContextBuilder 三层组装 + 预算降级

**Files:**
- Create: `packages/reasoning-core/src/context-builder.ts`
- Test: `packages/reasoning-core/src/context-builder.test.ts`
- Modify: `packages/reasoning-core/src/index.ts`（导出）

**Interfaces:**
- Consumes: `estimateTokens`（C1）、`topK`/`Focus`（C2）、`Fact`/`Task`/`SessionState`/`Hypothesis`（shared）、`TurnMessage`（从 `@traceforge/extension` 的 provider 类型；本计划在 reasoning-core 内重新声明结构等价的 `BuiltMessage` 以避免反向依赖）
- Produces:
  - `interface ConvoEntry { role: "user" | "assistant"; text: string }`
  - `interface ContextInput { goal: string; state?: SessionState; recentConvo: ConvoEntry[]; facts: Fact[]; activeHypotheses: Hypothesis[]; activeTasks: Task[]; doneTaskSummaries: string[]; farSummary?: string; scopeHosts: string[]; protectedFactIds: Set<string> }`
  - `interface ContextBudget { maxTokens: number; focusReserve: number }`
  - `interface BuiltMessage { role: "user" | "assistant"; content: string }`
  - `interface BuildResult { messages: BuiltMessage[]; injectedFactIds: string[]; estimatedTokens: number; degraded: string[] }`
  - `buildContext(input: ContextInput, budget: ContextBudget): BuildResult`

设计要点（实现时遵守）：
- Layer1（焦点）永不裁剪：state 摘要 + scopeHosts + 最近对话 + 活跃 task。
- Layer2：topK facts（受预算调 K）+ 活跃 hypotheses。
- Layer3：farSummary + doneTaskSummaries。
- protectedFactIds 中的 fact（被 Action evidenceRefs 引用）即使不在 topK 也必须保留进 Layer2。
- 降级顺序：超预算时先砍 Layer3 → 再降 Layer2 的 K → 仍超则截断 Layer1 长文本；每步记入 `degraded`。
- 输出 messages：把三层拼成一条 system-like 的 user 上下文消息 + 把 recentConvo 展开为真实 user/assistant 轮次（让"同意/继续"有真实对话结构）。

- [ ] **Step 1: 写失败测试**

```ts
// packages/reasoning-core/src/context-builder.test.ts
import { describe, it, expect } from "vitest";
import { buildContext, type ContextInput, type ContextBudget } from "./context-builder.js";
import type { Fact } from "@traceforge/shared";

function fact(id: string, title: string, host: string): Fact {
  return { id, caseId: "c", type: "api_endpoint", title, value: {}, source: { type: "manual", ref: "x" }, confidence: 1, tags: [`host:${host}`], createdAt: "2026-06-01T00:00:00Z", updateCount: 0, updatedAt: "", validity: "valid" } as Fact;
}

const base: ContextInput = {
  goal: "测越权", state: undefined,
  recentConvo: [{ role: "user", text: "测 a.com" }, { role: "assistant", text: "已提议纳入 a.com" }],
  facts: [fact("f1", "a.com order api", "a.com")],
  activeHypotheses: [], activeTasks: [], doneTaskSummaries: [], farSummary: undefined,
  scopeHosts: ["a.com"], protectedFactIds: new Set(),
};
const budget: ContextBudget = { maxTokens: 100000, focusReserve: 2000 };

describe("buildContext", () => {
  it("expands recent conversation into real user/assistant turns", () => {
    const r = buildContext(base, budget);
    const roles = r.messages.map((m) => m.role);
    expect(roles).toContain("user");
    expect(roles).toContain("assistant");
    // 最后一条是当前 goal（user）
    expect(r.messages.at(-1)).toMatchObject({ role: "user" });
    expect(r.messages.at(-1)!.content).toContain("测越权");
  });
  it("includes in-scope fact id and records injectedFactIds", () => {
    const r = buildContext(base, budget);
    expect(r.injectedFactIds).toContain("f1");
  });
  it("protected fact is kept even when topK would drop it", () => {
    const many = Array.from({ length: 50 }, (_, i) => fact(`x${i}`, `api ${i}`, "a.com"));
    const input = { ...base, facts: [...many, fact("keep", "rare", "a.com")], protectedFactIds: new Set(["keep"]) };
    const r = buildContext(input, { maxTokens: 100000, focusReserve: 2000 });
    expect(r.injectedFactIds).toContain("keep");
  });
  it("degrades when over budget", () => {
    const huge = { ...base, doneTaskSummaries: Array.from({ length: 200 }, (_, i) => `task ${i} 结论很长很长很长很长`), farSummary: "x".repeat(5000) };
    const r = buildContext(huge, { maxTokens: 300, focusReserve: 150 });
    expect(r.degraded.length).toBeGreaterThan(0);
    expect(r.estimatedTokens).toBeLessThanOrEqual(300 + 200); // 降级后接近预算（允许 Layer1 保底超一点）
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @traceforge/reasoning-core exec vitest run src/context-builder.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

```ts
// packages/reasoning-core/src/context-builder.ts
import type { Fact, Task, SessionState, Hypothesis } from "@traceforge/shared";
import { estimateTokens } from "./token-estimate.js";
import { topK, type Focus } from "./relevance.js";

export interface ConvoEntry { role: "user" | "assistant"; text: string }
export interface ContextInput {
  goal: string;
  state?: SessionState;
  recentConvo: ConvoEntry[];
  facts: Fact[];
  activeHypotheses: Hypothesis[];
  activeTasks: Task[];
  doneTaskSummaries: string[];
  farSummary?: string;
  scopeHosts: string[];
  protectedFactIds: Set<string>;
}
export interface ContextBudget { maxTokens: number; focusReserve: number }
export interface BuiltMessage { role: "user" | "assistant"; content: string }
export interface BuildResult { messages: BuiltMessage[]; injectedFactIds: string[]; estimatedTokens: number; degraded: string[] }

function focusFrom(input: ContextInput): Focus {
  return { host: input.state?.focus.host, url: input.state?.focus.url, note: input.state?.focus.note, goal: input.goal };
}

export function buildContext(input: ContextInput, budget: ContextBudget): BuildResult {
  const degraded: string[] = [];
  const focus = focusFrom(input);

  // ---- Layer 1 焦点（永不裁剪，仅长文本可截断）----
  const stateLine = input.state
    ? `当前目标：${input.state.currentGoal || input.goal}；阶段：${input.state.phase}；焦点：${JSON.stringify(input.state.focus)}`
    : `当前目标：${input.goal}`;
  const scopeLine = `已授权范围 host：${input.scopeHosts.length ? input.scopeHosts.join(", ") : "（空，需先 propose_scope_expansion 提议并经人批准）"}`;
  const taskLine = input.activeTasks.length
    ? `活跃任务：\n${input.activeTasks.map((t) => `- [${t.status}] ${t.title}`).join("\n")}`
    : "活跃任务：（无）";

  // ---- Layer 2 相关（受预算调 K）----
  let k = 12;
  const buildLayer2 = (kk: number): { text: string; ids: string[] } => {
    const picked = topK(input.facts, focus, kk);
    const ids = new Set(picked.map((f) => f.id));
    // protected 必含
    for (const f of input.facts) if (input.protectedFactIds.has(f.id)) ids.add(f.id);
    const chosen = input.facts.filter((f) => ids.has(f.id));
    const factText = chosen.length ? chosen.map((f) => `- ${f.id} [${f.type}] ${f.title}`).join("\n") : "（无相关 Fact）";
    const hypoText = input.activeHypotheses.length ? input.activeHypotheses.map((h) => `- ${h.id} [${h.status}] ${h.statement}`).join("\n") : "";
    const text = `相关 Fact：\n${factText}` + (hypoText ? `\n活跃假设：\n${hypoText}` : "");
    return { text, ids: chosen.map((f) => f.id) };
  };

  // ---- Layer 3 摘要（最先被砍）----
  let layer3 = "";
  const buildLayer3 = (): string => {
    const parts: string[] = [];
    if (input.farSummary) parts.push(`早期工作摘要：${input.farSummary}`);
    if (input.doneTaskSummaries.length) parts.push(`已完成任务结论：\n${input.doneTaskSummaries.map((s) => `- ${s}`).join("\n")}`);
    return parts.join("\n");
  };
  layer3 = buildLayer3();

  // 组装 + 预算降级
  let l2 = buildLayer2(k);
  const assemble = (): { ctxText: string } => {
    const sections = [stateLine, scopeLine, taskLine, l2.text];
    if (layer3) sections.push(layer3);
    return { ctxText: sections.join("\n\n") };
  };
  let ctx = assemble().ctxText;

  const total = () => estimateTokens(ctx) + input.recentConvo.reduce((a, c) => a + estimateTokens(c.text), 0) + estimateTokens(input.goal);

  // 降级 1：砍 Layer3
  if (total() > budget.maxTokens && layer3) { layer3 = ""; degraded.push("dropped-layer3"); ctx = assemble().ctxText; }
  // 降级 2：降 K
  while (total() > budget.maxTokens && k > 3) { k -= 3; l2 = buildLayer2(k); degraded.push(`reduced-k-${k}`); ctx = assemble().ctxText; }
  // 降级 3：截断焦点长文本（这里仅截断整体上下文尾部，保留 Layer1 头部 focusReserve）
  if (total() > budget.maxTokens) {
    const reserveChars = budget.focusReserve * 4;
    if (ctx.length > reserveChars) { ctx = ctx.slice(0, reserveChars) + "\n…（上下文已截断）"; degraded.push("truncated-context"); }
  }

  // 输出 messages：上下文作为开场 user 提示 + 展开历史对话 + 当前 goal
  const messages: BuiltMessage[] = [{ role: "user", content: `【会话上下文】\n${ctx}` }];
  for (const c of input.recentConvo) messages.push({ role: c.role, content: c.text });
  messages.push({ role: "user", content: input.goal });

  return { messages, injectedFactIds: l2.ids, estimatedTokens: total(), degraded };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @traceforge/reasoning-core exec vitest run src/context-builder.test.ts`
Expected: PASS（4 tests）

- [ ] **Step 5: 导出 + Commit**

在 `packages/reasoning-core/src/index.ts` 追加：

```ts
export * from "./token-estimate.js";
export * from "./relevance.js";
export * from "./context-builder.js";
```

```bash
git add packages/reasoning-core/src/context-builder.ts packages/reasoning-core/src/context-builder.test.ts packages/reasoning-core/src/index.ts
git commit -m "feat(cognitive): ContextBuilder 三层组装 + 预算降级"
```

---

## Task E1: Compressor（LLM 摘要 + 规则回退）

**Files:**
- Create: `packages/reasoning-core/src/compressor.ts`
- Test: `packages/reasoning-core/src/compressor.test.ts`
- Modify: `packages/reasoning-core/src/index.ts`（导出）

**Interfaces:**
- Consumes:
  - `interface SummarizerLlm { extractJson(args: { system: string; user: string; schema: Record<string, unknown> }): Promise<unknown> }`（结构与 `LlmProvider` 子集一致，便于注入 mock）
- Produces:
  - `interface CompressInput { convoText: string; doneTaskLines: string[] }`
  - `compressFar(input: CompressInput, llm?: SummarizerLlm): Promise<string>`（有 llm 用 LLM 摘要；无 llm 或抛错则规则回退：取首尾 + done 任务计数）

- [ ] **Step 1: 写失败测试**

```ts
// packages/reasoning-core/src/compressor.test.ts
import { describe, it, expect } from "vitest";
import { compressFar } from "./compressor.js";

describe("compressFar", () => {
  it("falls back to rule-based when no llm", async () => {
    const r = await compressFar({ convoText: "很多对话".repeat(50), doneTaskLines: ["t1", "t2", "t3"] });
    expect(r).toContain("3"); // done 任务计数
    expect(r.length).toBeLessThan("很多对话".repeat(50).length);
  });
  it("uses llm summary when provided", async () => {
    const llm = { extractJson: async () => ({ summary: "LLM 摘要结论" }) };
    const r = await compressFar({ convoText: "x".repeat(100), doneTaskLines: [] }, llm);
    expect(r).toBe("LLM 摘要结论");
  });
  it("falls back when llm throws", async () => {
    const llm = { extractJson: async () => { throw new Error("network"); } };
    const r = await compressFar({ convoText: "abc", doneTaskLines: ["t1"] }, llm);
    expect(r).toContain("1");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @traceforge/reasoning-core exec vitest run src/compressor.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

```ts
// packages/reasoning-core/src/compressor.ts
export interface SummarizerLlm {
  extractJson(args: { system: string; user: string; schema: Record<string, unknown> }): Promise<unknown>;
}
export interface CompressInput { convoText: string; doneTaskLines: string[] }

function ruleFallback(input: CompressInput): string {
  const head = input.convoText.slice(0, 300);
  const tail = input.convoText.length > 600 ? input.convoText.slice(-300) : "";
  const doneCount = input.doneTaskLines.length;
  return `【早期摘要(规则)】对话首段：${head}${tail ? ` … 近段：${tail}` : ""}；已完成任务 ${doneCount} 个。`;
}

// 远期对话+done任务压缩成结论摘要。有 llm 用 LLM；无 llm 或失败则规则回退（降级不崩）。
export async function compressFar(input: CompressInput, llm?: SummarizerLlm): Promise<string> {
  if (!llm) return ruleFallback(input);
  try {
    const res = await llm.extractJson({
      system: "你是渗透测试记录摘要器。把给定的早期对话与已完成任务压缩成一段简洁的结论性摘要，只保留对后续测试有用的事实与进展，去除寒暄与过程。输出 JSON {summary}。",
      user: `早期对话：\n${input.convoText}\n\n已完成任务：\n${input.doneTaskLines.join("\n")}`,
      schema: { type: "object", properties: { summary: { type: "string" } }, required: ["summary"] },
    });
    const summary = (res as { summary?: string })?.summary;
    if (typeof summary === "string" && summary.trim()) return summary.trim();
    return ruleFallback(input);
  } catch {
    return ruleFallback(input);
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @traceforge/reasoning-core exec vitest run src/compressor.test.ts`
Expected: PASS（3 tests）

- [ ] **Step 5: 导出 + Commit**

`packages/reasoning-core/src/index.ts` 追加 `export * from "./compressor.js";`

```bash
git add packages/reasoning-core/src/compressor.ts packages/reasoning-core/src/compressor.test.ts packages/reasoning-core/src/index.ts
git commit -m "feat(cognitive): Compressor LLM 摘要 + 规则回退"
```

---

## Task E2: ContextSummary 表 + Store（增量缓存）

**Files:**
- Modify: `packages/shared/src/schemas.ts`、`apps/server/src/db/schema.ts`、`apps/server/src/db/client.ts`
- Create: `apps/server/src/stores/context-summary-store.ts`
- Test: `apps/server/src/stores/context-summary-store.test.ts`、`packages/shared/src/cognitive-schemas.test.ts`（追加）

**Interfaces:**
- Produces:
  - `ContextSummarySchema`、`type ContextSummary = { id; caseId; coversUpToEventSeq; content; createdAt }`
  - `class ContextSummaryStore { constructor(db); append(caseId, coversUpToEventSeq, content): ContextSummary; latest(caseId): ContextSummary | undefined }`

- [ ] **Step 1: 写失败测试（schema + store）**

`packages/shared/src/cognitive-schemas.test.ts` 追加：

```ts
import { ContextSummarySchema } from "./schemas.js";
describe("ContextSummarySchema", () => {
  it("parses", () => {
    const s = ContextSummarySchema.parse({ id: "s1", caseId: "c1", coversUpToEventSeq: 5, content: "x", createdAt: "t" });
    expect(s.coversUpToEventSeq).toBe(5);
  });
});
```

```ts
// apps/server/src/stores/context-summary-store.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { createDb } from "../db/client.js";
import { ContextSummaryStore } from "./context-summary-store.js";

let store: ContextSummaryStore;
beforeEach(() => { store = new ContextSummaryStore(createDb(":memory:")); });

describe("ContextSummaryStore", () => {
  it("latest returns undefined initially", () => { expect(store.latest("c1")).toBeUndefined(); });
  it("append then latest returns most recent by seq", () => {
    store.append("c1", 3, "early");
    store.append("c1", 8, "later");
    expect(store.latest("c1")?.content).toBe("later");
    expect(store.latest("c1")?.coversUpToEventSeq).toBe(8);
  });
  it("isolates by case", () => {
    store.append("c1", 3, "x");
    expect(store.latest("c2")).toBeUndefined();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @traceforge/shared exec vitest run src/cognitive-schemas.test.ts && pnpm --filter @traceforge/server exec vitest run src/stores/context-summary-store.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 schema + 表 + store**

`packages/shared/src/schemas.ts` 追加：

```ts
export const ContextSummarySchema = z.object({
  id: z.string(),
  caseId: z.string(),
  coversUpToEventSeq: z.number(),
  content: z.string(),
  createdAt: z.string(),
});
export type ContextSummary = z.infer<typeof ContextSummarySchema>;
```

`apps/server/src/db/schema.ts` 追加：

```ts
export const contextSummaries = sqliteTable("context_summaries", {
  seq: integer("seq").primaryKey({ autoIncrement: true }),
  id: text("id").notNull(),
  caseId: text("case_id").notNull(),
  coversUpToEventSeq: integer("covers_up_to_event_seq").notNull(),
  content: text("content").notNull(),
  createdAt: text("created_at").notNull(),
});
```

`apps/server/src/db/client.ts` 追加：

```sql
    CREATE TABLE IF NOT EXISTS context_summaries (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL, case_id TEXT NOT NULL,
      covers_up_to_event_seq INTEGER NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_context_summaries_case ON context_summaries(case_id);
```

```ts
// apps/server/src/stores/context-summary-store.ts
import { randomUUID } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { contextSummaries } from "../db/schema.js";
import { type ContextSummary, ContextSummarySchema } from "@traceforge/shared";

export class ContextSummaryStore {
  constructor(private db: Db) {}

  append(caseId: string, coversUpToEventSeq: number, content: string): ContextSummary {
    const s = ContextSummarySchema.parse({
      id: `cs_${randomUUID()}`, caseId, coversUpToEventSeq, content, createdAt: new Date().toISOString(),
    });
    this.db.insert(contextSummaries).values({
      id: s.id, caseId, coversUpToEventSeq, content, createdAt: s.createdAt,
    }).run();
    return s;
  }

  latest(caseId: string): ContextSummary | undefined {
    const row = this.db.select().from(contextSummaries)
      .where(eq(contextSummaries.caseId, caseId)).orderBy(desc(contextSummaries.seq)).get();
    if (!row) return undefined;
    return ContextSummarySchema.parse({
      id: row.id, caseId: row.caseId, coversUpToEventSeq: row.coversUpToEventSeq,
      content: row.content, createdAt: row.createdAt,
    });
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @traceforge/shared exec vitest run src/cognitive-schemas.test.ts && pnpm --filter @traceforge/server exec vitest run src/stores/context-summary-store.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/schemas.ts packages/shared/src/cognitive-schemas.test.ts apps/server/src/db/schema.ts apps/server/src/db/client.ts apps/server/src/stores/context-summary-store.ts apps/server/src/stores/context-summary-store.test.ts
git commit -m "feat(cognitive): ContextSummary 表 + Store 增量缓存"
```

---

## Task F1: 接线 agent/run（用 ContextBuilder + 注册认知工具）

**Files:**
- Modify: `apps/server/src/routes.ts`（agent/run handler + store 构造）
- Test: `apps/server/src/routes-cognitive.test.ts`

**Interfaces:**
- Consumes: 全部前述 store + `buildContext`（reasoning-core）+ 3 认知工具（extension）+ `AgentEventStore`（已有，提供历史对话）
- Produces: agent/run 第二轮能读到第一轮对话；新会话状态/假设入库

实现要点：
1. 在 `registerRoutes` 顶部构造 `sessionStore`/`hypothesisStore`/`contextSummaryStore`。
2. agent/run 中：
   - 从 `agentEventStore.listByCase(id)` 取历史，映射成 `recentConvo`（kind=user→user；kind=done→assistant），取最近 N=10 轮。
   - 构造 `ContextInput`：goal、state=sessionStore.get(id)、facts=factStore.listByCase(id)、activeHypotheses=hypothesisStore.listByCase(id).filter(status open)、activeTasks=taskStore.listByCase(id).filter(open/blocked/running)、doneTaskSummaries=done 任务 `title → reason`、farSummary=contextSummaryStore.latest(id)?.content、scopeHosts=c.scopeRules.flatMap(allowHosts)、protectedFactIds=从 actionStore 收集 evidenceRefs。
   - `const built = buildContext(input, { maxTokens: 60000, focusReserve: 3000 })`。
   - 把 `built.messages` 传给 AgentRuntime（见 F2 改 run 签名）。
   - 注册 3 认知工具：`makeUpdateSessionStateTool(id, sessionStore)`、`makeRecordHypothesisTool(id, hypothesisStore, factStore)`、`makeResolveHypothesisTool(id, hypothesisStore, factStore)`。
   - run 结束后（在 Observer 之前）：把 injectedFactIds + estimatedTokens 记入 timeline（`timelineStore.append(id, "context_built", \`注入 ${built.injectedFactIds.length} facts, ~${built.estimatedTokens} tokens, 降级:${built.degraded.join(",")||"无"}\`)`）。

- [ ] **Step 1: 写失败集成测试**

```ts
// apps/server/src/routes-cognitive.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { createDb } from "./db/client.js";
import { EventBus } from "./event-bus.js";
import { registerRoutes } from "./routes.js";
import { MockProvider } from "@traceforge/llm";

let app: FastifyInstance;
let caseId: string;

beforeEach(async () => {
  app = Fastify();
  const db = createDb(":memory:");
  const bus = new EventBus();
  // 两轮：第一轮 agent 回 "已提议纳入"，第二轮必须能看到第一轮对话
  const provider = new MockProvider({}, [
    { text: "已提议纳入 a.com，等你批准", toolCalls: [], done: true },
    { text: "好的，基于你刚才的同意我开始", toolCalls: [], done: true },
  ]);
  registerRoutes(app, db, bus, provider);
  await app.ready();
  caseId = (await app.inject({ method: "POST", url: "/api/cases", payload: { name: "d", allowHosts: [] } })).json().id;
});

describe("cognitive context across runs", () => {
  it("second run sees first run conversation in history", async () => {
    await app.inject({ method: "POST", url: `/api/cases/${caseId}/agent/run`, payload: { goal: "测 a.com" } });
    await app.inject({ method: "POST", url: `/api/cases/${caseId}/agent/run`, payload: { goal: "同意" } });
    const events = (await app.inject({ url: `/api/cases/${caseId}/agent/events` })).json();
    const userTexts = events.filter((e: { kind: string }) => e.kind === "user").map((e: { text: string }) => e.text);
    expect(userTexts).toContain("测 a.com");
    expect(userTexts).toContain("同意");
    // 第二轮 agent 的回复存在（说明 run 成功跑完，未因无上下文报错）
    const doneTexts = events.filter((e: { kind: string }) => e.kind === "done").map((e: { text: string }) => e.text);
    expect(doneTexts.length).toBeGreaterThanOrEqual(2);
  });
});
```

> 注：MockProvider 第二参数为「按顺序返回的 turn 列表」。确认其构造签名与 `apps/server/src/routes-agent-events.test.ts` 中用法一致（`new MockProvider({}, [...turns])`）；若签名不同，按该文件实际用法调整。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @traceforge/server exec vitest run src/routes-cognitive.test.ts`
Expected: FAIL（当前 agent/run 不传历史，第二轮无上下文；或编译错因 buildContext 未接入）

- [ ] **Step 3: 实现接线**

按上方「实现要点」修改 `apps/server/src/routes.ts`。关键片段（替换现有 `new AgentRuntime(...).run(system, goal, ...)` 调用处，goal 来源不变）：

```ts
// 顶部 store 构造区追加：
const sessionStore = new SessionStateStore(db);
const hypothesisStore = new HypothesisStore(db);
const contextSummaryStore = new ContextSummaryStore(db);

// agent/run 内，注册工具区追加：
registry.register(makeUpdateSessionStateTool(id, sessionStore));
registry.register(makeRecordHypothesisTool(id, hypothesisStore, factStore));
registry.register(makeResolveHypothesisTool(id, hypothesisStore, factStore));

// 组装上下文（替换原先「单句 goal」）：
const history = agentEventStore.listByCase(id);
const recentConvo = history
  .filter((e) => e.kind === "user" || e.kind === "done")
  .slice(-20)
  .map((e) => ({ role: e.kind === "user" ? ("user" as const) : ("assistant" as const), text: e.text }));
const evidenceRefIds = new Set(actionStore.listByCase(id).flatMap((a) => a.evidenceRefs));
const built = buildContext({
  goal,
  state: sessionStore.get(id),
  recentConvo,
  facts: factStore.listByCase(id),
  activeHypotheses: hypothesisStore.listByCase(id).filter((h) => h.status === "open"),
  activeTasks: taskStore.listByCase(id).filter((t) => ["open", "blocked", "running", "recheck_candidate"].includes(t.status)),
  doneTaskSummaries: taskStore.listByCase(id).filter((t) => t.status === "done").map((t) => `${t.title}：${t.reason || "完成"}`),
  farSummary: contextSummaryStore.latest(id)?.content,
  scopeHosts: c.scopeRules.flatMap((r) => r.allowHosts),
  protectedFactIds: evidenceRefIds,
}, { maxTokens: 60000, focusReserve: 3000 });

// run（注意：AgentRuntime.run 第二参数在 F2 改为接收预组装 messages）
await new AgentRuntime(llm, registry, gate).run(system, built.messages, (e) => { /* 原有 onEvent 不变 */ });

// run 后、Observer 前，记上下文审计：
timelineStore.append(id, "context_built", `注入 ${built.injectedFactIds.length} facts, ~${built.estimatedTokens} tokens, 降级:${built.degraded.join(",") || "无"}`);
```

import 区追加：

```ts
import { SessionStateStore } from "./stores/session-state-store.js";
import { HypothesisStore } from "./stores/hypothesis-store.js";
import { ContextSummaryStore } from "./stores/context-summary-store.js";
import { buildContext } from "@traceforge/reasoning-core";
import { makeUpdateSessionStateTool, makeRecordHypothesisTool, makeResolveHypothesisTool } from "@traceforge/extension";
```

并把 `apps/server/package.json` 的 dependencies 加上 `"@traceforge/reasoning-core": "workspace:*"`（若尚未依赖）。

- [ ] **Step 4: 跑测试确认通过 + 全量回归**

Run: `pnpm --filter @traceforge/server exec vitest run src/routes-cognitive.test.ts && pnpm test`
Expected: 新测试 PASS，全量 177+ 全过

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/routes.ts apps/server/src/routes-cognitive.test.ts apps/server/package.json
git commit -m "feat(cognitive): agent/run 接入 ContextBuilder + 认知工具（跨轮记忆生效）"
```

---

## Task F2: AgentRuntime.run 接收预组装 messages

**Files:**
- Modify: `packages/extension/src/agent-runtime.ts:16-17`
- Test: `packages/extension/src/agent-runtime.test.ts`（追加）

**Interfaces:**
- 改 `run(system: string, userGoal: string, onEvent)` → `run(system: string, initial: string | { role: "user" | "assistant"; content: string }[], onEvent)`。string 时等价旧行为（`[{role:"user",content:goal}]`），数组时直接作为初始 messages。向后兼容现有调用。

- [ ] **Step 1: 追加失败测试**

```ts
// packages/extension/src/agent-runtime.test.ts 追加
it("accepts pre-assembled messages array as initial context", async () => {
  const provider = { extractJson: async () => ({}), runTools: async (a: { messages: unknown[] }) => { seen = a.messages; return { text: "ok", toolCalls: [], done: true }; } };
  let seen: unknown[] = [];
  const reg = { toLlmTools: () => [], get: () => undefined } as never;
  const gate = { check: async () => "approved" } as never;
  await new AgentRuntime(provider as never, reg, gate).run("sys", [{ role: "user", content: "a" }, { role: "assistant", content: "b" }, { role: "user", content: "c" }], () => {});
  expect((seen as { content: string }[]).map((m) => m.content)).toEqual(["a", "b", "c"]);
});
```

> 注：若现有 agent-runtime.test.ts 的 mock provider/registry 结构与此不同，复用该文件已有的 mock 工厂，仅断言 messages 透传。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @traceforge/extension exec vitest run src/agent-runtime.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

`packages/extension/src/agent-runtime.ts` 改 run 开头：

```ts
async run(
  system: string,
  initial: string | { role: "user" | "assistant"; content: string }[],
  onEvent: (e: AgentEvent) => void,
): Promise<void> {
  const messages: TurnMessage[] = typeof initial === "string"
    ? [{ role: "user", content: initial }]
    : initial.map((m) => ({ role: m.role, content: m.content }));
  // ……（其余循环体不变）
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @traceforge/extension exec vitest run src/agent-runtime.test.ts`
Expected: PASS

- [ ] **Step 5: 全量回归 + Commit**

Run: `pnpm test && pnpm -r build`
Expected: 全过、build exit 0

```bash
git add packages/extension/src/agent-runtime.ts packages/extension/src/agent-runtime.test.ts
git commit -m "feat(cognitive): AgentRuntime.run 支持预组装 messages（向后兼容）"
```

---

## 收尾验证（全部任务完成后）

- [ ] `pnpm test` 全过（预计 177 + 约 25 新测试）
- [ ] `pnpm -r build` 全量 exit 0
- [ ] 手测：建空范围 Case → 「测 X」→ agent 提议 → 「同意」→ agent 接上下文（不再重复追问）→ 刷新后历史在
- [ ] 更新 README 进度段 + traceforge-plan-execution 记忆 + 设计文档 §31 勾选「认知内核」

> F2 应在 F1 之前或同批执行（F1 的 run 调用依赖 F2 的新签名）。建议执行顺序：A1→A2→B1→B2→B3→C1→C2→D1→E1→E2→F2→F1。


