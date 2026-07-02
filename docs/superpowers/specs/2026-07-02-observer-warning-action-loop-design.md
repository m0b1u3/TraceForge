# Observer Warning Action Loop Design

## 1. Goal

Upgrade Observer warnings from passive review notes into human-approved correction entry points.

Today, Observer runs after an Agent run, stores warnings, and the web UI only displays them in the Observer tab. This design adds a minimal action loop:

- continue a new Agent run from a warning;
- convert a warning into a tracked Task;
- dismiss a warning when the user decides no action is needed.

The first iteration remains human-in-the-loop. Observer does not automatically interrupt, steer, or launch runs.

## 2. Current Implementation

Current code path:

1. `apps/server/src/routes.ts` runs the main `AgentRuntime`.
2. After the run, it calls `new Observer(llm).review(...)`.
3. Each returned `ObserverWarning` is stored with `ObserverWarningStore.create(...)`.
4. The server emits `observer_warning`.
5. `apps/web/src/store.ts` receives the event and appends it to `warnings`.
6. `apps/web/src/components/knowledge/ObserverTab.tsx` renders warning text and suggested action.

Current warning fields:

```ts
level
title
description
relatedFacts
relatedTasks
suggestedAction
createdAt
```

Current limitation: after display, the warning has no state, no run provenance, and no built-in way to become a next action.

## 3. Non-Goals

- Do not build real-time Observer interception.
- Do not let Observer automatically stop or steer the active Agent.
- Do not add sub-agents.
- Do not replace the existing Task model.
- Do not create a separate correction-agent runtime.
- Do not require new LLM behavior for this first pass.

## 4. Data Model

Extend `ObserverWarningSchema` with:

```ts
status: z.enum(["open", "accepted", "dismissed", "converted_to_task"]).default("open")
relatedRunId: z.string().nullable().default(null)
suggestedGoal: z.string().default("")
resolvedAt: z.string().nullable().default(null)
```

Field meaning:

- `status`: user handling state.
- `relatedRunId`: Agent run that produced the warning.
- `suggestedGoal`: safe goal text for continuing from this warning.
- `resolvedAt`: time when the warning moved out of `open`.

Default behavior for old rows/payloads:

- `status` defaults to `open`.
- `relatedRunId` defaults to `null`.
- `suggestedGoal` defaults to `suggestedAction` at store/write boundaries when missing.
- `resolvedAt` defaults to `null`.

## 5. Server Behavior

### 5.1 Warning Creation

When `routes.ts` receives warnings from `Observer.review(...)`, it enriches each warning before storing:

```ts
{
  ...warning,
  relatedRunId: runId,
  status: "open",
  suggestedGoal: warning.suggestedGoal || `[Observer correction]\n${warning.suggestedAction}`,
  resolvedAt: null
}
```

This keeps Observer itself simple and avoids making LLM output responsible for workflow state.

### 5.2 Dismiss Warning

Add endpoint:

```http
POST /api/observer/warnings/:warningId/dismiss
```

Behavior:

- If warning does not exist, return `404`.
- If warning exists, mark:

```ts
status: "dismissed"
resolvedAt: now
```

- Emit a runtime event so the current web store can update without refresh:

```ts
{ type: "observer_warning_updated"; warning }
```

### 5.3 Accept Warning For Continue

Add endpoint:

```http
POST /api/observer/warnings/:warningId/accept
```

Behavior:

- If warning does not exist, return `404`.
- Mark:

```ts
status: "accepted"
resolvedAt: now
```

- Emit `observer_warning_updated`.

The endpoint does not start the Agent run by itself. The web app will call the existing `runAgent(caseId, warning.suggestedGoal)` first, then mark the warning accepted after run start succeeds. This keeps Agent run creation on the existing route and avoids duplicating active-run conflict logic.

### 5.4 Convert Warning To Task

Add endpoint:

```http
POST /api/observer/warnings/:warningId/convert-task
```

Behavior:

- If warning does not exist, return `404`.
- Create a Task using existing `TaskStore.create(...)`:

```ts
{
  title: warning.title,
  status: "open",
  reason: `${warning.description}\n\nObserver 建议：${warning.suggestedAction}`,
  blockedBy: [],
  triggerWhen: [],
  relatedFacts: warning.relatedFacts,
  priority: warning.level === "critical" ? "high" : warning.level === "warning" ? "medium" : "low"
}
```

- Emit existing `task_created` and `timeline_appended` events.
- Mark warning:

```ts
status: "converted_to_task"
resolvedAt: now
```

- Emit `observer_warning_updated`.
- Return `{ warning, task }`.

## 6. Frontend Behavior

Observer tab keeps current text display and adds actions for `open` warnings:

- `继续运行`
- `创建 Task`
- `忽略`

Button behavior:

- `继续运行`:
  1. call `runAgent(warning.caseId, warning.suggestedGoal || warning.suggestedAction)`;
  2. if run starts, call `acceptObserverWarning(warning.id)`;
  3. active run and agent busy state update through existing Agent event handling.
- `创建 Task`:
  1. call `convertObserverWarningToTask(warning.id)`;
  2. task appears through existing `task_created` runtime event;
  3. warning updates through `observer_warning_updated`.
- `忽略`:
  1. call `dismissObserverWarning(warning.id)`;
  2. warning updates through `observer_warning_updated`.

Resolved warnings remain visible but show a small status label:

- `accepted`: 已继续
- `converted_to_task`: 已转 Task
- `dismissed`: 已忽略

## 7. Runtime Events

Add shared event:

```ts
| { type: "observer_warning_updated"; warning: ObserverWarning }
```

Web store handling:

- If `warning.caseId` is current case, replace the existing warning by id.
- If it is not already present, append it.

## 8. Error Handling

- Continue action can fail if another Agent run is active. In that case, show the existing toast error and leave warning `open`.
- Convert-to-task can fail if warning id is invalid. Return `404` and leave UI unchanged.
- Dismiss can fail if warning id is invalid. Return `404`.
- If WebSocket update is missed, refreshing the case reloads updated warning state from `GET /api/cases/:id/warnings`.

## 9. Testing Strategy

Shared tests:

- `ObserverWarningSchema` defaults new fields for old payloads.
- `RuntimeEvent` accepts `observer_warning_updated`.

Server tests:

- Observer-generated warnings include `status: "open"`, `relatedRunId`, and `suggestedGoal`.
- `POST /api/observer/warnings/:warningId/dismiss` marks warning dismissed and emits update.
- `POST /api/observer/warnings/:warningId/accept` marks warning accepted and emits update.
- `POST /api/observer/warnings/:warningId/convert-task` creates a Task, emits task/timeline/update events, and marks warning converted.

Web tests:

- Store handles `observer_warning_updated` by replacing an existing warning.
- Observer tab shows action buttons only for `open` warnings.
- Clicking continue calls `runAgent` then `acceptObserverWarning`.
- Clicking create task calls `convertObserverWarningToTask`.
- Clicking ignore calls `dismissObserverWarning`.

## 10. Acceptance Criteria

- Observer warning no longer dead-ends after display.
- User can continue a run from a warning.
- User can convert a warning into a tracked Task.
- User can dismiss a warning.
- All actions are human-triggered.
- Existing Observer display still works for old warnings.
- Focused tests, full tests, build, and real LLM validation are recorded.
