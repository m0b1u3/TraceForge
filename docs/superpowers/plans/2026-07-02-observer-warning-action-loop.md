# Observer Warning Action Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn Observer warnings into human-approved correction entry points: continue a run, convert to Task, or dismiss.

**Architecture:** Extend the shared warning/event schema first, then add server persistence/update APIs, then wire the web store/API/Observer tab actions. The Observer remains post-run and advisory; all correction actions are initiated by the user.

**Tech Stack:** TypeScript, Zod, Drizzle SQLite schema, Fastify routes, Zustand store, React, Vitest, pnpm workspaces.

---

## File Structure

- Modify: `packages/shared/src/schemas.ts`
  - Add warning workflow fields: `status`, `relatedRunId`, `suggestedGoal`, `resolvedAt`.
- Modify: `packages/shared/src/events.ts`
  - Add `observer_warning_updated`.
- Modify: `packages/shared/src/observer-schema.test.ts`
  - Cover defaulted warning workflow fields and update event typing.
- Modify: `apps/server/src/db/schema.ts`
  - Add nullable/default columns to `observer_warnings`.
- Modify: `apps/server/src/stores/observer-store.ts`
  - Persist new fields.
  - Add `getById`, `updateStatus`, and normalize `suggestedGoal`.
- Modify: `apps/server/src/observer-routes.test.ts`
  - Cover enriched Observer-generated warnings and the three warning action endpoints.
- Modify: `apps/server/src/routes.ts`
  - Enrich Observer warnings with `relatedRunId` and `suggestedGoal`.
  - Add `accept`, `dismiss`, and `convert-task` endpoints.
- Modify: `apps/web/src/api.ts`
  - Add API helpers for accepting, dismissing, converting warnings.
- Modify: `apps/web/src/store.ts`
  - Add upsert warning handling and `observer_warning_updated` event handling.
- Modify: `apps/web/src/store.test.ts`
  - Cover warning update replacement.
- Modify: `apps/web/src/components/knowledge/ObserverTab.tsx`
  - Render action buttons for open warnings and status labels for resolved warnings.
- Create: `apps/web/src/components/knowledge/ObserverTab.test.tsx`
  - Cover continue/create-task/dismiss UI behavior.
- Modify: `docs/superpowers/plans/2026-07-02-observer-warning-action-loop.md`
  - Fill Result Log after implementation.

## Task 1: Shared Warning Workflow Schema And Event

**Files:**
- Modify: `packages/shared/src/schemas.ts`
- Modify: `packages/shared/src/events.ts`
- Modify: `packages/shared/src/observer-schema.test.ts`

- [ ] **Step 1: Write failing shared schema tests**

Add these tests to `packages/shared/src/observer-schema.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { ObserverWarningSchema } from "./schemas.js";
import type { RuntimeEvent } from "./events.js";

describe("ObserverWarningSchema workflow fields", () => {
  it("defaults workflow fields for older warning payloads", () => {
    const warning = ObserverWarningSchema.parse({
      id: "warn_1",
      caseId: "case_1",
      level: "warning",
      title: "过早结束",
      description: "还有重要线索没有检查",
      relatedFacts: ["fact_1"],
      relatedTasks: [],
      suggestedAction: "继续检查 admin/login",
      createdAt: "2026-07-02T00:00:00.000Z"
    });

    expect(warning.status).toBe("open");
    expect(warning.relatedRunId).toBeNull();
    expect(warning.suggestedGoal).toBe("");
    expect(warning.resolvedAt).toBeNull();
  });

  it("accepts observer warning update runtime events", () => {
    const event: RuntimeEvent = {
      type: "observer_warning_updated",
      warning: {
        id: "warn_1",
        caseId: "case_1",
        level: "warning",
        title: "过早结束",
        description: "还有重要线索没有检查",
        relatedFacts: ["fact_1"],
        relatedTasks: [],
        suggestedAction: "继续检查 admin/login",
        status: "accepted",
        relatedRunId: "run_1",
        suggestedGoal: "[Observer correction]\n继续检查 admin/login",
        resolvedAt: "2026-07-02T00:01:00.000Z",
        createdAt: "2026-07-02T00:00:00.000Z"
      }
    };

    expect(event.warning.status).toBe("accepted");
  });
});
```

If the file already imports `ObserverWarningSchema`, merge imports rather than duplicating them.

- [ ] **Step 2: Run shared tests to verify failure**

Run:

```bash
pnpm exec vitest run packages/shared/src/observer-schema.test.ts
```

Expected: FAIL because the schema does not expose workflow fields or the event type is missing.

- [ ] **Step 3: Add warning workflow fields**

In `packages/shared/src/schemas.ts`, update `ObserverWarningSchema`:

```ts
export const ObserverWarningSchema = z.object({
  id: z.string(),
  caseId: z.string(),
  level: z.enum(["info", "warning", "critical"]),
  title: z.string(),
  description: z.string(),
  relatedFacts: z.array(z.string()).default([]),
  relatedTasks: z.array(z.string()).default([]),
  suggestedAction: z.string(),
  status: z.enum(["open", "accepted", "dismissed", "converted_to_task"]).default("open"),
  relatedRunId: z.string().nullable().default(null),
  suggestedGoal: z.string().default(""),
  resolvedAt: z.string().nullable().default(null),
  createdAt: z.string(),
});
```

- [ ] **Step 4: Add runtime event**

In `packages/shared/src/events.ts`, add this union member near `observer_warning`:

```ts
| { type: "observer_warning_updated"; warning: ObserverWarning }
```

- [ ] **Step 5: Run shared tests**

Run:

```bash
pnpm exec vitest run packages/shared/src/observer-schema.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit shared work**

Run:

```bash
git add packages/shared/src/schemas.ts packages/shared/src/events.ts packages/shared/src/observer-schema.test.ts
git commit -m "feat(shared): add observer warning workflow state"
```

## Task 2: Server Warning Store And Action Routes

**Files:**
- Modify: `apps/server/src/db/schema.ts`
- Modify: `apps/server/src/stores/observer-store.ts`
- Modify: `apps/server/src/routes.ts`
- Modify: `apps/server/src/observer-routes.test.ts`

- [ ] **Step 1: Write failing server tests**

Extend `apps/server/src/observer-routes.test.ts` with tests for warning enrichment and action endpoints:

```ts
import type { RuntimeEvent } from "@traceforge/shared";

it("stores Observer warnings with workflow fields and related run id", async () => {
  const started = await app.inject({
    method: "POST",
    url: `/api/cases/${caseId}/agent/run`,
    payload: { goal: "测登录" }
  });
  const runId = started.json().run.id;

  const res = await waitForWarningCount(1);
  const [warning] = res.json();

  expect(warning.status).toBe("open");
  expect(warning.relatedRunId).toBe(runId);
  expect(warning.suggestedGoal).toBe("[Observer correction]\n继续测 X");
  expect(warning.resolvedAt).toBeNull();
});

it("dismisses an Observer warning and emits an update", async () => {
  const events: RuntimeEvent[] = [];
  const bus = new EventBus();
  bus.subscribe((event) => events.push(event));
  app = Fastify();
  const db = createDb(":memory:");
  const provider = new MockProvider(
    { warnings: [{ level: "warning", title: "过早结束", description: "还有点没测", suggestedAction: "继续测 X" }] },
    [{ text: "看一下", toolCalls: [], done: true }]
  );
  registerRoutes(app, db, bus, provider);
  await app.ready();
  caseId = (await app.inject({ method: "POST", url: "/api/cases", payload: { name: "d", allowHosts: ["t.com"] } })).json().id;

  await app.inject({ method: "POST", url: `/api/cases/${caseId}/agent/run`, payload: { goal: "测登录" } });
  const warningsRes = await waitForWarningCount(1);
  const warning = warningsRes.json()[0];

  const dismissed = await app.inject({ method: "POST", url: `/api/observer/warnings/${warning.id}/dismiss` });

  expect(dismissed.statusCode).toBe(200);
  expect(dismissed.json().warning.status).toBe("dismissed");
  expect(dismissed.json().warning.resolvedAt).toBeTruthy();
  expect(events.some((event) => event.type === "observer_warning_updated" && event.warning.status === "dismissed")).toBe(true);
});

it("accepts an Observer warning and emits an update", async () => {
  await app.inject({ method: "POST", url: `/api/cases/${caseId}/agent/run`, payload: { goal: "测登录" } });
  const warningsRes = await waitForWarningCount(1);
  const warning = warningsRes.json()[0];

  const accepted = await app.inject({ method: "POST", url: `/api/observer/warnings/${warning.id}/accept` });

  expect(accepted.statusCode).toBe(200);
  expect(accepted.json().warning.status).toBe("accepted");
  expect(accepted.json().warning.resolvedAt).toBeTruthy();
});

it("converts an Observer warning into a Task and marks it converted", async () => {
  const events: RuntimeEvent[] = [];
  const bus = new EventBus();
  bus.subscribe((event) => events.push(event));
  app = Fastify();
  const db = createDb(":memory:");
  const provider = new MockProvider(
    { warnings: [{ level: "critical", title: "忽略后台入口", description: "没有检查后台入口", relatedFacts: ["fact_1"], suggestedAction: "检查 /admin/login" }] },
    [{ text: "看一下", toolCalls: [], done: true }]
  );
  registerRoutes(app, db, bus, provider);
  await app.ready();
  caseId = (await app.inject({ method: "POST", url: "/api/cases", payload: { name: "d", allowHosts: ["t.com"] } })).json().id;

  await app.inject({ method: "POST", url: `/api/cases/${caseId}/agent/run`, payload: { goal: "测登录" } });
  const warningsRes = await waitForWarningCount(1);
  const warning = warningsRes.json()[0];

  const converted = await app.inject({ method: "POST", url: `/api/observer/warnings/${warning.id}/convert-task` });

  expect(converted.statusCode).toBe(200);
  expect(converted.json().warning.status).toBe("converted_to_task");
  expect(converted.json().task).toMatchObject({
    caseId,
    title: "忽略后台入口",
    status: "open",
    priority: "high",
    relatedFacts: ["fact_1"]
  });
  expect(converted.json().task.reason).toContain("Observer 建议：检查 /admin/login");
  expect(events.some((event) => event.type === "task_created" && event.task.title === "忽略后台入口")).toBe(true);
  expect(events.some((event) => event.type === "observer_warning_updated" && event.warning.status === "converted_to_task")).toBe(true);
});
```

If repeated app setup makes the file too noisy, extract a small helper inside the test file:

```ts
async function buildObserverApp(extractResult: unknown, events: RuntimeEvent[] = []) {
  const localApp = Fastify();
  const db = createDb(":memory:");
  const bus = new EventBus();
  bus.subscribe((event) => events.push(event));
  const provider = new MockProvider(extractResult, [{ text: "看一下", toolCalls: [], done: true }]);
  registerRoutes(localApp, db, bus, provider);
  await localApp.ready();
  const cid = (await localApp.inject({ method: "POST", url: "/api/cases", payload: { name: "d", allowHosts: ["t.com"] } })).json().id;
  return { app: localApp, caseId: cid };
}
```

- [ ] **Step 2: Run server tests to verify failure**

Run:

```bash
pnpm exec vitest run apps/server/src/observer-routes.test.ts
```

Expected: FAIL because new fields/endpoints do not exist.

- [ ] **Step 3: Extend database schema**

In `apps/server/src/db/schema.ts`, update `observerWarnings`:

```ts
export const observerWarnings = sqliteTable("observer_warnings", {
  id: text("id").primaryKey(),
  caseId: text("case_id").notNull(),
  level: text("level").notNull(),
  title: text("title").notNull(),
  description: text("description").notNull(),
  relatedFactsJson: text("related_facts_json").notNull(),
  relatedTasksJson: text("related_tasks_json").notNull(),
  suggestedAction: text("suggested_action").notNull(),
  status: text("status").notNull().default("open"),
  relatedRunId: text("related_run_id"),
  suggestedGoal: text("suggested_goal").notNull().default(""),
  resolvedAt: text("resolved_at"),
  createdAt: text("created_at").notNull(),
});
```

This project uses `createDb(":memory:")` and local SQLite schema creation in tests; if migrations exist, add the same columns there too.

- [ ] **Step 4: Update ObserverWarningStore**

In `apps/server/src/stores/observer-store.ts`, add a helper:

```ts
function normalizeSuggestedGoal(warning: ObserverWarning): string {
  return warning.suggestedGoal || `[Observer correction]\n${warning.suggestedAction}`;
}
```

Update `create` values:

```ts
const parsed = ObserverWarningSchema.parse({
  ...w,
  suggestedGoal: w.suggestedGoal || `[Observer correction]\n${w.suggestedAction}`,
});
this.db.insert(observerWarnings).values({
  id: parsed.id,
  caseId: parsed.caseId,
  level: parsed.level,
  title: parsed.title,
  description: parsed.description,
  relatedFactsJson: JSON.stringify(parsed.relatedFacts),
  relatedTasksJson: JSON.stringify(parsed.relatedTasks),
  suggestedAction: parsed.suggestedAction,
  status: parsed.status,
  relatedRunId: parsed.relatedRunId,
  suggestedGoal: normalizeSuggestedGoal(parsed),
  resolvedAt: parsed.resolvedAt,
  createdAt: parsed.createdAt,
}).run();
```

Add row parser:

```ts
private parseRow(row: typeof observerWarnings.$inferSelect): ObserverWarning {
  return ObserverWarningSchema.parse({
    id: row.id,
    caseId: row.caseId,
    level: row.level,
    title: row.title,
    description: row.description,
    relatedFacts: JSON.parse(row.relatedFactsJson),
    relatedTasks: JSON.parse(row.relatedTasksJson),
    suggestedAction: row.suggestedAction,
    status: row.status,
    relatedRunId: row.relatedRunId,
    suggestedGoal: row.suggestedGoal || `[Observer correction]\n${row.suggestedAction}`,
    resolvedAt: row.resolvedAt,
    createdAt: row.createdAt,
  });
}
```

Add methods:

```ts
getById(id: string): ObserverWarning | undefined {
  const row = this.db.select().from(observerWarnings).where(eq(observerWarnings.id, id)).get();
  return row ? this.parseRow(row) : undefined;
}

updateStatus(id: string, status: ObserverWarning["status"]): ObserverWarning | undefined {
  const current = this.getById(id);
  if (!current) return undefined;
  const resolvedAt = new Date().toISOString();
  this.db.update(observerWarnings)
    .set({ status, resolvedAt })
    .where(eq(observerWarnings.id, id))
    .run();
  return this.getById(id);
}
```

Update `listByCase` to use `this.parseRow(row)`.

- [ ] **Step 5: Enrich warnings in routes**

In `apps/server/src/routes.ts`, inside the `for (const w of warnings)` loop after Observer review:

```ts
const warning = observerStore.create({
  ...w,
  status: "open",
  relatedRunId: runId,
  suggestedGoal: w.suggestedGoal || `[Observer correction]\n${w.suggestedAction}`,
  resolvedAt: null,
});
bus.emit({ type: "observer_warning", warning });
```

Use the returned `warning`, not the raw `w`, for the event.

- [ ] **Step 6: Add warning action endpoints**

In `apps/server/src/routes.ts`, near `GET /api/cases/:id/warnings`, add:

```ts
app.post("/api/observer/warnings/:warningId/dismiss", async (req, reply) => {
  const { warningId } = req.params as { warningId: string };
  const warning = observerStore.updateStatus(warningId, "dismissed");
  if (!warning) return reply.code(404).send({ error: "warning not found" });
  bus.emit({ type: "observer_warning_updated", warning });
  return { warning };
});

app.post("/api/observer/warnings/:warningId/accept", async (req, reply) => {
  const { warningId } = req.params as { warningId: string };
  const warning = observerStore.updateStatus(warningId, "accepted");
  if (!warning) return reply.code(404).send({ error: "warning not found" });
  bus.emit({ type: "observer_warning_updated", warning });
  return { warning };
});

app.post("/api/observer/warnings/:warningId/convert-task", async (req, reply) => {
  const { warningId } = req.params as { warningId: string };
  const warning = observerStore.getById(warningId);
  if (!warning) return reply.code(404).send({ error: "warning not found" });

  const task = taskStore.create(warning.caseId, {
    title: warning.title,
    status: "open",
    reason: `${warning.description}\n\nObserver 建议：${warning.suggestedAction}`,
    blockedBy: [],
    triggerWhen: [],
    relatedFacts: warning.relatedFacts,
    priority: warning.level === "critical" ? "high" : warning.level === "warning" ? "medium" : "low",
  });
  const entry = timelineStore.append(warning.caseId, "task_created", `Task: ${task.title}`, task.id);
  bus.emit({ type: "task_created", task });
  bus.emit({ type: "timeline_appended", entry });

  const updated = observerStore.updateStatus(warningId, "converted_to_task");
  if (updated) bus.emit({ type: "observer_warning_updated", warning: updated });
  return { warning: updated, task };
});
```

If `TaskStore.create` already appends timeline in a route elsewhere, do not rely on that route; explicitly append timeline here as shown.

- [ ] **Step 7: Run server tests**

Run:

```bash
pnpm exec vitest run apps/server/src/observer-routes.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit server work**

Run:

```bash
git add apps/server/src/db/schema.ts apps/server/src/stores/observer-store.ts apps/server/src/routes.ts apps/server/src/observer-routes.test.ts
git commit -m "feat(server): add observer warning actions"
```

## Task 3: Web Store And API Wiring

**Files:**
- Modify: `apps/web/src/api.ts`
- Modify: `apps/web/src/store.ts`
- Modify: `apps/web/src/store.test.ts`

- [ ] **Step 1: Write failing store test**

In `apps/web/src/store.test.ts`, add:

```ts
it("replaces Observer warnings when observer_warning_updated arrives", () => {
  useStore.getState().setCase("case_1");
  useStore.setState({
    warnings: [{
      id: "warn_1",
      caseId: "case_1",
      level: "warning",
      title: "过早结束",
      description: "还有重要线索没有检查",
      relatedFacts: [],
      relatedTasks: [],
      suggestedAction: "继续检查",
      status: "open",
      relatedRunId: "run_1",
      suggestedGoal: "[Observer correction]\n继续检查",
      resolvedAt: null,
      createdAt: "2026-07-02T00:00:00.000Z"
    }]
  });

  useStore.getState().handleRuntimeEvent({
    type: "observer_warning_updated",
    warning: {
      id: "warn_1",
      caseId: "case_1",
      level: "warning",
      title: "过早结束",
      description: "还有重要线索没有检查",
      relatedFacts: [],
      relatedTasks: [],
      suggestedAction: "继续检查",
      status: "accepted",
      relatedRunId: "run_1",
      suggestedGoal: "[Observer correction]\n继续检查",
      resolvedAt: "2026-07-02T00:01:00.000Z",
      createdAt: "2026-07-02T00:00:00.000Z"
    }
  });

  expect(useStore.getState().warnings).toHaveLength(1);
  expect(useStore.getState().warnings[0].status).toBe("accepted");
});
```

- [ ] **Step 2: Run web store test to verify failure**

Run:

```bash
pnpm exec vitest run apps/web/src/store.test.ts
```

Expected: FAIL because `observer_warning_updated` is not handled.

- [ ] **Step 3: Add API helpers**

In `apps/web/src/api.ts`, add:

```ts
export async function acceptObserverWarning(warningId: string): Promise<ObserverWarning> {
  const r = await ensureOk(await fetch(`/api/observer/warnings/${warningId}/accept`, { method: "POST" }), "接受 Observer 提示");
  return (await r.json()).warning;
}

export async function dismissObserverWarning(warningId: string): Promise<ObserverWarning> {
  const r = await ensureOk(await fetch(`/api/observer/warnings/${warningId}/dismiss`, { method: "POST" }), "忽略 Observer 提示");
  return (await r.json()).warning;
}

export async function convertObserverWarningToTask(warningId: string): Promise<{ warning: ObserverWarning; task: Task }> {
  const r = await ensureOk(await fetch(`/api/observer/warnings/${warningId}/convert-task`, { method: "POST" }), "转换 Observer 提示为 Task");
  return r.json();
}
```

- [ ] **Step 4: Add warning upsert to store**

In `apps/web/src/store.ts`, extend `State`:

```ts
upsertWarning: (w: ObserverWarning) => void;
```

Add implementation:

```ts
upsertWarning: (w) =>
  set((s) => {
    const index = s.warnings.findIndex((x) => x.id === w.id);
    if (index === -1) return { warnings: [...s.warnings, w] };
    const warnings = s.warnings.slice();
    warnings[index] = w;
    return { warnings };
  }),
```

Update runtime event handling:

```ts
else if (event.type === "observer_warning_updated" && event.warning.caseId === cid) get().upsertWarning(event.warning);
```

Keep existing `observer_warning` behavior as `addWarning`.

- [ ] **Step 5: Run web store tests**

Run:

```bash
pnpm exec vitest run apps/web/src/store.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit web store/API work**

Run:

```bash
git add apps/web/src/api.ts apps/web/src/store.ts apps/web/src/store.test.ts
git commit -m "feat(web): handle observer warning updates"
```

## Task 4: Observer Tab Actions

**Files:**
- Modify: `apps/web/src/components/knowledge/ObserverTab.tsx`
- Create: `apps/web/src/components/knowledge/ObserverTab.test.tsx`

- [ ] **Step 1: Check test dependencies**

Inspect `apps/web/package.json`:

```bash
Get-Content -Encoding UTF8 apps/web/package.json
```

If React Testing Library is already installed, use it. If it is not installed, avoid adding a new dependency for this pass and test the component by extracting a pure helper instead.

Recommended low-dependency helper:

```ts
export function observerWarningStatusLabel(status: ObserverWarning["status"]): string {
  if (status === "accepted") return "已继续";
  if (status === "converted_to_task") return "已转 Task";
  if (status === "dismissed") return "已忽略";
  return "待处理";
}
```

- [ ] **Step 2: Write failing component/helper tests**

If React Testing Library exists, create `apps/web/src/components/knowledge/ObserverTab.test.tsx`:

```tsx
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ObserverTab } from "./ObserverTab.js";
import { useStore } from "../../store.js";

vi.mock("../../api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api.js")>();
  return {
    ...actual,
    runAgent: vi.fn(async () => ({
      id: "run_2",
      caseId: "case_1",
      goal: "continue",
      status: "running",
      createdAt: "t",
      startedAt: "t",
      finishedAt: null,
      interruptReason: null,
      completionReason: null,
      error: null
    })),
    acceptObserverWarning: vi.fn(async () => ({})),
    dismissObserverWarning: vi.fn(async () => ({})),
    convertObserverWarningToTask: vi.fn(async () => ({ warning: {}, task: {} })),
  };
});

import { runAgent, acceptObserverWarning, dismissObserverWarning, convertObserverWarningToTask } from "../../api.js";

beforeEach(() => {
  vi.clearAllMocks();
  useStore.setState({
    caseId: "case_1",
    warnings: [{
      id: "warn_1",
      caseId: "case_1",
      level: "warning",
      title: "过早结束",
      description: "还有重要线索没有检查",
      relatedFacts: [],
      relatedTasks: [],
      suggestedAction: "继续检查",
      status: "open",
      relatedRunId: "run_1",
      suggestedGoal: "[Observer correction]\n继续检查",
      resolvedAt: null,
      createdAt: "2026-07-02T00:00:00.000Z"
    }],
    toast: null
  });
});

describe("ObserverTab actions", () => {
  it("continues from an open warning then marks it accepted", async () => {
    render(<ObserverTab />);
    fireEvent.click(screen.getByRole("button", { name: "继续运行" }));

    await waitFor(() => expect(runAgent).toHaveBeenCalledWith("case_1", "[Observer correction]\n继续检查"));
    expect(acceptObserverWarning).toHaveBeenCalledWith("warn_1");
  });

  it("converts an open warning to task", async () => {
    render(<ObserverTab />);
    fireEvent.click(screen.getByRole("button", { name: "创建 Task" }));

    await waitFor(() => expect(convertObserverWarningToTask).toHaveBeenCalledWith("warn_1"));
  });

  it("dismisses an open warning", async () => {
    render(<ObserverTab />);
    fireEvent.click(screen.getByRole("button", { name: "忽略" }));

    await waitFor(() => expect(dismissObserverWarning).toHaveBeenCalledWith("warn_1"));
  });
});
```

If React Testing Library is not installed, add these tests to a new `ObserverTab.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { observerWarningStatusLabel } from "./ObserverTab.js";

describe("observerWarningStatusLabel", () => {
  it("labels warning workflow statuses", () => {
    expect(observerWarningStatusLabel("open")).toBe("待处理");
    expect(observerWarningStatusLabel("accepted")).toBe("已继续");
    expect(observerWarningStatusLabel("converted_to_task")).toBe("已转 Task");
    expect(observerWarningStatusLabel("dismissed")).toBe("已忽略");
  });
});
```

- [ ] **Step 3: Run component/helper tests to verify failure**

Run one of:

```bash
pnpm exec vitest run apps/web/src/components/knowledge/ObserverTab.test.tsx
pnpm exec vitest run apps/web/src/components/knowledge/ObserverTab.test.ts
```

Expected: FAIL because the actions/helper do not exist.

- [ ] **Step 4: Implement ObserverTab actions**

In `apps/web/src/components/knowledge/ObserverTab.tsx`, import:

```ts
import { runAgent, acceptObserverWarning, convertObserverWarningToTask, dismissObserverWarning } from "../../api.js";
```

Use store fields:

```ts
const { warnings, caseId, setAgentBusy, setActiveRun, showToast } = useStore((s) => ({
  warnings: s.warnings,
  caseId: s.caseId,
  setAgentBusy: s.setAgentBusy,
  setActiveRun: s.setActiveRun,
  showToast: s.showToast,
}));
```

Add helper:

```ts
export function observerWarningStatusLabel(status: ObserverWarning["status"]): string {
  if (status === "accepted") return "已继续";
  if (status === "converted_to_task") return "已转 Task";
  if (status === "dismissed") return "已忽略";
  return "待处理";
}
```

Add handlers:

```ts
const continueFromWarning = async (warning: ObserverWarning) => {
  if (!caseId) return;
  try {
    setAgentBusy(true);
    const run = await runAgent(caseId, warning.suggestedGoal || warning.suggestedAction);
    setActiveRun(run);
    await acceptObserverWarning(warning.id);
  } catch (error) {
    setAgentBusy(false);
    showToast((error as Error).message);
  }
};

const convertToTask = async (warning: ObserverWarning) => {
  try {
    await convertObserverWarningToTask(warning.id);
  } catch (error) {
    showToast((error as Error).message);
  }
};

const dismiss = async (warning: ObserverWarning) => {
  try {
    await dismissObserverWarning(warning.id);
  } catch (error) {
    showToast((error as Error).message);
  }
};
```

Render buttons only when `w.status === "open"`:

```tsx
{w.status === "open" ? (
  <div className="tf-confirm-actions" style={{ marginTop: 8 }}>
    <button className="tf-btn tf-btn-accent" onClick={() => continueFromWarning(w)}>继续运行</button>
    <button className="tf-btn" onClick={() => convertToTask(w)}>创建 Task</button>
    <button className="tf-btn tf-btn-ghost" onClick={() => dismiss(w)}>忽略</button>
  </div>
) : (
  <div style={{ color: "var(--faint)", marginTop: 6 }}>{observerWarningStatusLabel(w.status)}</div>
)}
```

- [ ] **Step 5: Run component/helper tests**

Run the test command used in Step 3.

Expected: PASS.

- [ ] **Step 6: Run web tests**

Run:

```bash
pnpm exec vitest run apps/web/src/store.test.ts apps/web/src/components/knowledge/ObserverTab.test.tsx
```

If the helper-only path was used:

```bash
pnpm exec vitest run apps/web/src/store.test.ts apps/web/src/components/knowledge/ObserverTab.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit Observer tab work**

Run:

```bash
git add apps/web/src/components/knowledge/ObserverTab.tsx apps/web/src/components/knowledge/ObserverTab.test.tsx
git commit -m "feat(web): add observer warning actions"
```

If using helper-only `.test.ts`, stage that file instead.

## Task 5: Verification, Docs, And Real LLM Validation

**Files:**
- Modify: `README.md`
- Modify: `TraceForge_design.md`
- Modify: `docs/superpowers/plans/2026-07-02-observer-warning-action-loop.md`

- [ ] **Step 1: Update README progress**

In `README.md`, append this bullet near current Agent/Observer progress bullets:

```md
- Observer Warning Action Loop：Observer warning 不再只是展示，可由人工一键继续运行、转换成 Task 或忽略；转换 Task 会进入现有 Tasks 工作流，继续运行复用现有 agent/run。Observer 仍不自动干预，所有纠偏动作由人触发。
```

- [ ] **Step 2: Update design progress**

In `TraceForge_design.md` section `31.3`, add:

```md
14. **Observer Warning Action Loop（监督提示纠偏闭环第一阶段）** — ✅ 已完成。Observer warning 从事后提示升级为可处理事项：人工可选择继续运行、转换为 Task 或忽略。继续运行复用现有 agent/run；转换 Task 进入现有 Tasks/上下文工作流；Observer 仍不自动打断或控制主 Agent。
```

- [ ] **Step 3: Run focused tests**

Run:

```bash
pnpm exec vitest run packages/shared/src/observer-schema.test.ts apps/server/src/observer-routes.test.ts apps/web/src/store.test.ts
```

Also run the ObserverTab test created in Task 4.

Expected: all PASS.

- [ ] **Step 4: Run full verification**

Run:

```bash
pnpm test
pnpm build
```

Expected: PASS. If `pnpm build` prints existing Vite warnings about browser-externalized Node modules from `undici`, record them as warnings, not failures.

- [ ] **Step 5: Real LLM validation**

Use the configured real OpenAI-compatible provider. Do not use mock for the real validation record.

Recommended validation path:

1. Start a real server with the configured provider.
2. Create a case.
3. Run Agent with a goal likely to produce an Observer warning, or directly verify an Observer warning produced by a real `Observer.review(...)` call over a synthetic trajectory.
4. Confirm the produced warning contains `status: "open"`, `relatedRunId`, and `suggestedGoal`.
5. Trigger `convert-task` against that warning and confirm a Task is created.

If the real Observer produces no warning for the synthetic trajectory, record that honestly and use deterministic integration tests for endpoint behavior. Do not claim real warning action E2E occurred unless the warning exists and one action endpoint succeeds.

- [ ] **Step 6: Fill Result Log**

Replace the `Result Log` section with:

```md
## Result Log

- Shared tests:
- Server tests:
- Web tests:
- Full test/build:
- Real LLM validation:
- Commits:
```

Fill every line with exact commands and observed results.

- [ ] **Step 7: Commit docs and validation record**

Run:

```bash
git add README.md TraceForge_design.md docs/superpowers/plans/2026-07-02-observer-warning-action-loop.md
git commit -m "docs: record observer warning action loop validation"
```

## Result Log

- Plan authored: pending execution.
