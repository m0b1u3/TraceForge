# TraceForge 实时实体数据机制 设计文档（工作流图谱重做 · 第 1 轮 / 共 3 轮）

> 状态：设计已确认，待转 writing-plans。这是「参照 flow/ demo 重做工作流图谱」三轮工程的第 1 轮（后端数据地基）。后两轮：图谱引擎替换（@xyflow/react + elk）、整体浅色化三栏。

## 1. 范围与定位

给 Fact/Task 加上「被反复更新」的能力，让图谱节点能实时反映 `updateCount`（更新次数）、`updatedAt`（时间）、`status`（状态流转）——这是 demo（flow/src/App.tsx）那种「节点活态变化（N updates、TESTING→FACT）」的数据根基。

**本轮范围（纯后端 + agent 工具）**：
- Fact/Task 数据模型加字段（updateCount/updatedAt/validity）。
- `record_fact`/`record_task` 入参加可选 `id`：不带=新建，带已知 id=更新该实体（upsert）。
- 新增 `fact_updated` 事件；`task_updated`（已有）在 update 时 emit。
- FactStore/TaskStore 加 getById/update。

**不含**（后两轮）：前端图谱引擎替换、整体浅色化。前端这轮只需能收到 `fact_updated` 事件不报错（真正消费在下一轮）。

**不动**：ActionCard（已有 status + updatedAt，足够图谱用）。

## 2. 数据模型改动（@traceforge/shared）

**FactSchema 加三字段**（都有默认值，不破坏现有数据）：
```ts
updateCount: z.number().default(0),
updatedAt: z.string().default(""),          // 空则视同 createdAt
validity: z.enum(["valid", "superseded"]).default("valid"),  // 闭枚举（系统状态）
```

**TaskSchema 加一字段**（已有 status/updatedAt）：
```ts
updateCount: z.number().default(0),
```

**create 语义**：Fact/Task 的 create 设 `updateCount=0`、`updatedAt=createdAt`。

## 3. store 契约

**FactStore**（apps/server/src/stores/fact-store.ts，已有 create/listByCase）新增：
```ts
getById(id: string): Fact | undefined
update(id: string, patch: Partial<Pick<Fact, "type"|"title"|"value"|"confidence"|"tags"|"validity">>): Fact | undefined
//  找到：合并 patch + updateCount+1 + updatedAt=now，写回，返回更新后 Fact；找不到返回 undefined
```

**TaskStore**（已有 create/listByCase/getById/updateStatus）新增：
```ts
update(id: string, patch: Partial<Pick<Task, "title"|"status"|"reason"|"priority"|"blockedBy"|"triggerWhen"|"relatedFacts">>): Task | undefined
//  找到：合并 patch + updateCount+1 + updatedAt=now，写回；找不到返回 undefined
```

**建表**（apps/server/src/db/client.ts）：facts 表加列 `update_count INTEGER`、`updated_at TEXT`、`validity TEXT`；tasks 表加列 `update_count INTEGER`。**开发期直接删 live.sqlite 重建**（无生产数据需迁移，不写 ALTER——YAGNI；将来上生产再做正经 migration）。store 读列时对缺列容错（用 schema 默认值）。

## 4. 工具改动（@traceforge/extension case-tools）

注入接口扩展：`FactWriter` 加 `getById(id)` 与 `update(id, patch)`；`TaskWriter` 加 `getById(id)` 与 `update(id, patch)`（结构接口，server 的 store 满足）。

**makeRecordFactTool** 入参加可选 `id`：
```
不带 id  → facts.create(...)（updateCount=0，现有行为）+ emit fact_created
带 id：
  - id 不存在该 case → { ok:false, content:"fact <id> 不存在，新建请去掉 id" }
  - 存在 → facts.update(id, patch) → emit fact_updated → { ok:true, content:"已更新 Fact <id>（第 N 次）" }
```

**makeRecordTaskTool** 同理加可选 `id`：不带新建（emit task_created）、带已知 id → tasks.update → emit task_updated。

## 5. 事件（@traceforge/shared events）

- 新增 `fact_updated`：`{ type: "fact_updated"; fact: Fact }`
- `task_updated`（已有）：update 时 emit
- 新建仍走 `fact_created`/`task_created`（已有）

## 6. 错误处理（都 {ok:false} 不崩）

| 场景 | 行为 |
|---|---|
| record_fact 带不存在的 id | `{ok:false}`，提示新建去掉 id |
| record_task 带不存在的 id | 同上 |
| update patch 校验失败 | `{ok:false}`，Zod 错误信息 |
| store update 不存在 id | 返回 undefined（工具据此返回 {ok:false}） |

## 7. 测试

- **shared schema 单测**：Fact/Task 加字段后默认值正确（updateCount=0、validity=valid、updatedAt 默认空）。
- **FactStore 单测**：getById 取到/取不到；update 改字段 + updateCount+1 + updatedAt 刷新；update 不存在 id → undefined。
- **TaskStore 单测**：update 改字段 + updateCount+1；不存在 id → undefined。
- **工具单测**（extension，mock 注入）：record_fact 不带 id→新建 updateCount=0；带已知 id→update 且 updateCount 递增、emit fact_updated；带未知 id→{ok:false}。record_task 同理（emit task_updated）。
- **events 单测**：fact_updated 事件类型可构造。
- **端到端（可选）**：真 agent 记一个 fact，再带同 id 调 record_fact 改 confidence → updateCount=1、emit fact_updated。

## 8. 核心理念落点（自检）

- **零硬编码**：upsert 由 LLM 自主决定（带不带 id），代码不判「何时该更新」；validity 是 LLM 可标的轻量状态。
- **开闭枚举**：validity 闭 enum（系统状态机消费，前端节点据此显示）；不引入开 string 领域字段。
- **复用现有**：复用 record_fact/record_task 工具（不加新工具）、复用 task_updated 事件、复用 store 模式。
- **降级不崩**：带错 id、校验失败都返回 {ok:false}，不抛。
- **为下一轮铺路**：updateCount/updatedAt/validity + fact_updated 事件是图谱节点「实时计数 + 状态变化」的数据来源，本轮就绪后第 2 轮前端图谱才能真正活起来。

## 9. 实现分解（单一 plan）

聚焦单一子系统（后端实时数据），适合一个实施计划，预计任务：
1. shared：Fact/Task schema 加字段 + fact_updated 事件 + 单测
2. server：db 建表加列 + FactStore.getById/update + TaskStore.update + 单测
3. extension：record_fact/record_task 加可选 id（upsert）+ 注入接口扩展 + 单测
4. server：routes 工具注入适配（store 传 getById/update）+ 全量校验
5. 收尾：全量测试/构建 + 删 live.sqlite 重建 + README + 设计文档进度
