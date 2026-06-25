# TraceForge Observer（监督 agent）设计文档

> 状态：设计已确认，待转 writing-plans。对应设计文档第 31.3 节修订路线第 5 项（原阶段 9 / 第 15 章 Observer 的去硬编码实现）。

## 1. 目标与定位

Observer 是**旁路监督角色**（设计文档 §5.3）。agent 一轮 run 跑完后，系统自动发一次**独立 LLM 调用**，把 agent 的轨迹 + 当前 Facts/Tasks 摘要 + 原始 goal 交给它，判断 agent 有没有「无依据猜测、忽略已有信息、偏离目标、过早结束」等问题，产出 `ObserverWarning[]` 提示人。**Observer 不直接干预 agent**——只观察、只提醒，纠偏决定权留给人。

**去硬编码核心**：设计文档 §15.1 的 10 个检查项（缺证据依据、无依据爆破、忽略 Facts/blocked tasks、把工具输出当结论、偏离目标、低收益、过早结束等）**不写成代码 if 规则**，而是作为 Observer 的 **prompt 指引**，由 LLM 对照轨迹判断。代码不预设「什么算低效/偏离」——这些是 LLM 的判断。

## 2. 数据流

```
agent run 结束（routes /agent/run 跑完 AgentRuntime.run）
  → 收集本次 run 轨迹（agentEvents 拼文本）+ 当前 Facts/Tasks 摘要 + goal
  → Observer.review(...) 发一次独立 LLM 调用（extractJson 结构化产出）
  → 解析为 ObserverWarning[]（level 闭 enum，校验）
  → 每条存 SQLite（带 case_id）+ emit observer_warning 事件
  → WS 推前端 → 工作台 Observer Tab 按 level 着色列出
  → 全程 try/catch：Observer 失败只记日志，不影响已完成的 agent run
```

**新增单元**：
- `packages/extension/src/observer.ts` —— `Observer.review(...)`（LLM 调用 + 解析，注入 LlmProvider，可单测）。
- `@traceforge/shared`：`ObserverWarning` schema + `observer_warning` 事件。
- `apps/server`：`ObserverWarningStore`（存/列，带 case_id）+ agent run 路由结束后触发 Observer + `GET /api/cases/:id/warnings`。
- `apps/web`：工作台知识面板加 Observer Tab。

**为什么 Observer 在 extension 而非 agent 工具**：它是系统触发的旁路调用，不是 agent 工具集成员（agent 不该自己叫监督者）。放 extension 因依赖 LlmProvider（已在 extension）。

## 3. ObserverWarning 数据结构

`@traceforge/shared`（沿用设计文档 §15.2，补 caseId）：
```ts
ObserverWarning = {
  id: string
  caseId: string
  level: "info" | "warning" | "critical"   // 闭 enum（前端着色档位，系统消费）
  title: string                              // 一句话问题（自由文本）
  description: string                        // 详细说明
  relatedFacts: string[]                     // 关联 Fact id（可空）
  relatedTasks: string[]                     // 关联 Task id（可空）
  suggestedAction: string                    // 建议怎么纠偏
  createdAt: string
}
```
`level` 闭 enum——它是给前端着色/排序的固定档位（系统状态机消费），不是 LLM 自由表达的领域语义，符合开闭原则（对比 Fact.type 是开 string）。

## 4. Observer.review 契约

`packages/extension/src/observer.ts`：
```ts
interface ReviewInput {
  goal: string                               // 本次 run 的原始目标
  trajectory: string                         // 本次 run 轨迹（agentEvents 拼成文本）
  factsSummary: string                       // 当前 Facts 摘要（id + type + title）
  tasksSummary: string                       // 当前 Tasks 摘要（id + status + title）
}
class Observer {
  constructor(provider: LlmProvider)
  async review(caseId: string, input: ReviewInput): Promise<ObserverWarning[]>
}
```

**review 内部**：
1. 拼 system prompt：把 §15.1 的 10 个检查项作为「你要警惕的问题清单」写进去（指引，非代码规则），并用 `<untrusted_data>` 边界包住 trajectory（轨迹含目标响应，是不可信数据，防 prompt injection）。
2. 调 `provider.extractJson({ schema: {warnings:[...]} , ... })` 让 LLM 产出结构化数组。
3. 校验每条：`level` 必须是三档之一（非法归 `info`）；补 `id`/`caseId`/`createdAt`；缺失数组字段补 `[]`。
4. **降级**：LLM 无配置/调用抛错/解析失败 → 返回 `[]`；LLM 判断「没问题」→ 也返回 `[]`。

**关键点**：
- Observer 只产出 warning，不写 Fact/Task，不调任何工具——纯只读审视。
- `relatedFacts`/`relatedTasks` 让 warning 能在前端关联具体 Fact/Task。
- 轨迹作为不可信数据进 prompt，用数据边界防护。

## 5. server 集成

- `ObserverWarningStore`（`apps/server/src/stores/observer-store.ts`）：`create(caseId, input)` / `listByCase(caseId)`，带 case_id 隔离，模式同现有 stores。新建表 `observer_warnings`（db/schema.ts）。
- agent run 路由在 `AgentRuntime.run` 跑完后、`return { ok: true }` 前追加：
  ```
  在 run 的 onEvent 回调里累积 trajectory 文本（text/tool_call/tool_result/done）
  run 完 → factsSummary（factStore.listByCase）+ tasksSummary（taskStore.listByCase）
  → try { const warnings = await new Observer(llm).review(id, {...});
           for (w of warnings) { observerStore.create(...); bus.emit({type:"observer_warning", warning}); } }
    catch (e) { console.error("[observer]", e) }   // 不影响已完成的 run
  ```
- `GET /api/cases/:id/warnings` → `observerStore.listByCase(id)`。
- 新事件 `observer_warning`（events.ts）：`{ type: "observer_warning"; warning: ObserverWarning }`。

## 6. 前端（工作台 Observer Tab）

- `store.ts`：加 `warnings: ObserverWarning[]`；`enterCase` 拉 `GET /warnings`；WS 处理 `observer_warning` 追加。
- `KnowledgePanel`：Tabs 加 `Observer`（放 Graph 后）；`ObserverTab.tsx` 按 level 着色列出（critical 红/warning 黄/info 灰），显示 title + description + suggestedAction。
- `api.ts`：加 `listWarnings(caseId)`。

## 7. 错误处理（全程降级不崩）

| 场景 | 行为 |
|---|---|
| LLM 无配置/调用抛错 | review 返回 `[]`，run 结果不受影响 |
| LLM 产出非法 JSON | 解析失败 → `[]` |
| 单条 level 非法 | 归 `info`，不丢整条 |
| Observer 整体抛错 | 路由 catch + console.error，run 已返回成功 |

## 8. 测试

- **Observer.review 单测**（mock provider）：provider 返回两条 warning → review 产出 2 条带 id/caseId/level；provider 返回非法 level → 归 info；provider 抛错 → 返回 `[]`；provider 返回空 → `[]`。
- **ObserverWarningStore 单测**：create + listByCase，case_id 隔离。
- **路由集成**（inject + mock provider）：agent run 后 `GET /warnings` 返回 Observer 产出的 warnings；Observer 抛错时 run 仍返回 200。
- **前端**：build + tsc（无前端测试框架，沿用 + 端到端手测）。

## 9. 核心理念落点（自检）

- **零硬编码**：10 个检查项是 prompt 指引，不是代码 if 规则；什么算「无依据/偏离/低效」由 LLM 判断。
- **自我审视 + 人把关**：系统具备旁路监督能力（Observer），但只产出提示，纠偏决定权留给人——落地「像有经验的搭档：不蛮干、不乱猜、每步有依据」。
- **只读不干预**：Observer 不写 Fact/Task、不调工具，纯审视。
- **安全**：trajectory 作为不可信数据用 `<untrusted_data>` 边界进 prompt（防 injection）；warnings 带 case_id 隔离。
- **降级不崩**：Observer 失败/无 LLM 不影响 agent run 主流程。

## 10. 实现分解（单一 plan）

聚焦单一子系统（Observer），适合一个实施计划，预计任务：
1. shared：ObserverWarning schema + observer_warning 事件 + 单测
2. extension：Observer.review（LLM 调用 + 解析 + 降级）+ mock provider 单测
3. server：ObserverWarningStore + 表 + 路由触发 Observer + GET /warnings + 集成单测
4. web：store/api 扩展 + Observer Tab（用 frontend-design skill）
5. 收尾：全量测试/构建 + 端到端 + README + 设计文档第 31 章进度勾选
```