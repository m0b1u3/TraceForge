# TraceForge LLM 驱动的重评估机制 设计文档

> 状态：设计已确认，待转 writing-plans。对应设计文档第 31.3 节修订路线第 4 项（原阶段 8 / 第 27 章双向重评估的去硬编码最小闭环）。

## 1. 目标与定位

实现设计文档第 27 章「双向重评估」的**去硬编码最小闭环**——让**新信息能重新影响旧任务**（新 Fact 入库时让相关旧 Task 复活/翻案），但「哪个 Fact 该影响哪个 Task」**完全由 LLM 判断**，代码里**不写** `factTypeToTriggers` / `canFactUnblockTask` / `taskMinConfidence` 那类领域映射表（第 27.4 节的写死规则违反第 3.0 节零硬编码最高原则）。

**本版范围（YAGNI）**：只做 LLM 驱动的「重启/打回已有 Task」最小闭环。置信度传播（27.1）、证据失效时效 validity/staleAt（27.2）、置信度沿证据链回退留作后续。**不含新建 Task**——agent 已能用现有 `record_task` 工具新建，重评估只补「让已存在的旧任务因新信息复活」这一缺口。

## 2. 形态：两个 agent 工具

加进 `@traceforge/extension` 的 case-tools 体系（与 record_fact/record_task 同源），server agent run 路由注册：

| 工具 | risk | 做什么 |
|---|---|---|
| `reopen_task` | normal | 把一个**未完成**的 Task（blocked/recheck_candidate/failed/open）重启为 `recheck_candidate`，带 reason + evidenceRefs。不卡门。 |
| `revert_done_task` | command | 把一个 **done** 的 Task 打回 `recheck_candidate`（推翻已完成结论），带 reason + evidenceRefs。过 ApprovalGate 人工确认。 |

**LLM 主导**：agent 在循环里记完新 Fact 后，自己判断有没有旧任务该复活/翻案，自己选调哪个工具、传哪个 taskId。代码不替它决定 Fact↔Task 关联。

**证据驱动**：两工具都要求 `evidenceRefs` 非空且引用已知 Fact id（复用 record_action 那条硬规则）——重评估必须有证据依据。

**安全分级**：靠**拆成两个工具**实现「按目标状态分风险」——未完成任务低风险（reopen=normal），已完成任务高风险（revert=command 过门）。风险分级编译期固定，用现有 ApprovalGate 机制，**零改动安全核心**。

## 3. 工具契约与状态流转

### reopen_task（risk=normal）
```
入参: { taskId: string, reason: string, evidenceRefs: string[] }
前置校验（任一失败返回 {ok:false}）:
  1. taskId 存在于本 case
  2. evidenceRefs 非空且都引用已知 Fact id
  3. 目标 task 当前状态 ≠ "done"（若 done 提示用 revert_done_task）
效果:
  updateStatus(taskId, "recheck_candidate", reason)
  + timeline 追加 "task_reopened: <title> ← <reason>"
  + emit task_updated
返回: {ok:true, content:"Task <title> 已重启为 recheck_candidate"}
```

### revert_done_task（risk=command，过 ApprovalGate）
```
入参: { taskId: string, reason: string, evidenceRefs: string[] }
前置校验（任一失败返回 {ok:false}）:
  1. taskId 存在
  2. evidenceRefs 非空且都引用已知 Fact id
  3. 目标 task 当前状态 === "done"（若非 done 提示用 reopen_task）
效果（人工批准后才执行，校验在 execute 内、ApprovalGate 在工具调用层）:
  updateStatus(taskId, "recheck_candidate", reason)
  + timeline 追加 "task_reverted: <title>（done→recheck）← <reason>"
  + emit task_updated
返回: {ok:true, content:"Task <title> 已打回 recheck_candidate"}
```

### 状态流转（都汇到 recheck_candidate）
```
blocked / failed / open / recheck_candidate  --reopen_task-->        recheck_candidate
done                                          --revert_done_task(确认)--> recheck_candidate
```
`recheck_candidate` 是现有 status enum 里已有、目前未用上的值，语义正是「待重测」。都进它而非直接 running——重评估只标记「该重新看了」，不直接执行，保持人/agent 再决定怎么测的余地（证据驱动不蛮干）。

**关键点**：两工具靠校验目标状态互斥（reopen 拒 done，revert 只收 done）——LLM 选错会被工具纠正，不会误操作。

## 4. 实现结构

复用现有 case-tools 体系：
- `packages/extension/src/case-tools.ts` 新增 `makeReopenTaskTool` 和 `makeRevertDoneTaskTool`，与 `makeRecordTaskTool` 同文件同模式。
- 注入依赖（结构接口，extension 不依赖 server）：
  ```ts
  interface TaskStatusReader { getById(taskId: string): { id: string; title: string; status: string } | undefined }
  interface FactExistChecker { has(factId: string): boolean }   // 验 evidenceRefs
  // 复用现有 TaskWriter(updateStatus)、TimelineWriter、Emit
  ```
- `apps/server`：`TaskStore` 补 `getById(id): Task | undefined`；`FactStore` 补 `has(id): boolean`（或用现有 listByCase 派生）；routes.ts agent run 注册处加这两个工具（在 record_task 之后），注入 store 适配。

## 5. 错误处理（都返回 {ok:false} 不抛）

| 场景 | 行为 |
|---|---|
| taskId 不存在 | `{ok:false, content:"task not found: <id>"}` |
| evidenceRefs 空/含未知 fact | `{ok:false, content:"evidenceRefs 必须非空且都引用已记录的 Fact"}` |
| reopen 目标已是 done | `{ok:false, content:"已完成任务请用 revert_done_task"}` |
| revert 目标非 done | `{ok:false, content:"未完成任务请用 reopen_task"}` |
| revert 被人工拒绝 | ApprovalGate 返回 rejected → 工具不执行，agent 看到拒绝 |

## 6. 测试

纯逻辑单测，注入 mock reader/writer：
- `reopen_task`：重启 blocked 任务 → updateStatus 收到 recheck_candidate + timeline + emit；目标已 done → 拒绝；evidenceRefs 空 → 拒绝；含未知 fact → 拒绝；taskId 不存在 → 拒绝；risk === "normal"。
- `revert_done_task`：打回 done 任务 → 状态变更 recheck_candidate；目标非 done → 拒绝；evidenceRefs 校验同上；risk === "command"。
- **端到端手动（可选）**：真 LLM agent 记新 Fact 后自主调 reopen_task 重启旧任务；revert_done_task 弹审批卡（经现有 ApprovalGate）。

## 7. 核心理念落点（自检）

- **零硬编码**：代码不含 factTypeToTriggers 等映射表；Fact↔Task 关联完全由 LLM 在 agent 循环里判断。这正是第 27.4 写死规则的去硬编码替代。
- **LLM 主导**：重评估是 LLM 自主调的工具，不是系统自动触发的规则引擎。
- **证据驱动**：两工具强制 evidenceRefs 非空且引用已知 Fact——翻动任务必须有证据。
- **安全分级**：reopen（未完成，normal）顺畅放行；revert（推翻已完成结论，command）过人工确认门——落地第 27.6 硬规则「打回 done task 必须人工复核」，且零改动 ApprovalGate。
- **新信息影响旧任务**：补上设计文档反复强调的灵魂——blocked 任务因新 Fact 复活、done 结论因矛盾证据翻案。

## 8. 实现分解（单一 plan）

聚焦单一子系统（重评估两工具），适合一个实施计划，预计任务：
1. extension：`makeReopenTaskTool` + 单测（含状态互斥、evidenceRefs 校验、risk=normal）
2. extension：`makeRevertDoneTaskTool` + 单测（含 done 校验、risk=command）
3. server：TaskStore.getById + FactStore.has + routes 注册两工具 + 路由/集成校验
4. 收尾：全量测试/构建 + 端到端手测 + README + 设计文档第 31 章进度勾选
```