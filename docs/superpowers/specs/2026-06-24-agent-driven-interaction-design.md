# TraceForge agent 驱动交互模型重构 设计文档

> 状态：设计已确认，待拆分为 Plan E1（后端）与 Plan E2（前端）两个实施计划。

## 1. 目标与背景

把交互模型从"单轮提取 + 逐个候选确认"（阶段 3/4）重构为"agent 自主多轮 + 危险才确认"（基于 Plan A 的 AgentRuntime）。**人给目标，agent 自主调工具完成，只有危险动作（执行系统命令）才停下等确认；人可随时插话引导/接管。** 这彻底贯彻「LLM 主导、零硬编码」最高原则（设计文档 3.0）。

**核心边界（风险可控的关键）：** 所有 store（fact/task/timeline/action/decision/case/traffic）一行不改——变的只是"谁调 store"。旧模式是路由在人确认后调；新模式是 agent 通过工具调。数据层稳定，只换上层交互。

## 2. 整体交互模型

```
旧（阶段3/4）                      新（agent 重构）
人点"提取" → AI 出候选            人在对话区给目标
→ 人逐个 confirm/reject          → AgentRuntime 自主多轮跑（Plan A）
→ 才落库                          → LLM 自己调工具：读流量/记Fact/记Task/记Action/重放
                                  → 直接落库（normal 风险不卡人）
                                  → 只有 command 类（Plan B）才停下确认
                                  → 人随时插话引导
                                  → Facts/Tasks/Timeline 面板实时显示 agent 写入
```

**谁变谁不变：**

- **不变（复用）**：所有 store、event-bus、scope guard、db、Plan A 的 AgentRuntime/ToolRegistry/ApprovalGate。
- **替换（废弃）**：
  - reasoning-core：`fact-extractor.ts`、`action-planner.ts`（及其测试）删除。
  - server：`candidate-store.ts`、`action-candidate-store.ts` 删除；routes.ts 中 extract / plan-actions / 候选 confirm/reject / action-candidate approve/reject 路由删除；对应 routes-phase3/4 候选测试删除。
  - 前端：候选确认 UI 删除。
- **新增**：case 工具集（写库/读流量工具）、agent 启动/插话/确认路由、对话流前端。

**人的介入：** 人给目标后 agent 自主跑；写库类动作（记 Fact/Task/Action）直接落库不卡人；只有 command 类工具（Plan B 的 sqlmap/终端等）触发 ApprovalGate 停下等人确认。Action 不再"提议→确认"两步——agent 想记就记，真正的危险确认由 command 门统一管。`ActionCard.requiresHumanApproval` 字段在新模型中退化（保留 schema，但 agent 记录的 action 默认 status 直接为已记录态）。

## 3. case 工具集（在现有能力上包装成 agent 工具）

新增 `packages/extension/src/case-tools.ts`。全部 `risk: "normal"`（直接执行，不卡人）。每个工具是**工厂函数**，server 启动 agent 时按当前 case 装配（注入 caseId + 对应 store + bus）。

| 工具 | 做什么 | 调用 |
|---|---|---|
| `list_traffic` | 列出某 case 已抓的请求摘要 | `TrafficStore.listByCase` |
| `get_traffic` | 取单条请求详情（含 body） | `TrafficStore`（按 id 过滤 listByCase） |
| `record_fact` | 记一个 Fact（type 开放字符串，source.type=ai） | `FactStore.create` + Timeline + emit |
| `record_task` | 记一个 Task（可 blocked + triggerWhen） | `TaskStore.create` + Timeline + emit |
| `record_action` | 记一个 Action（evidenceRefs 必填且须为已知 fact_id） | `ActionCardStore.create` + Decision + Timeline + emit |
| `http_replay` | 重放请求（Scope Guard 守） | Plan A 已有 `makeHttpReplayTool` |
| `propose_scope_expansion` | 提议扩范围（不发包） | Plan A 已有 `makeProposeScopeExpansionTool` |

**装配示例（server 启动 agent 时）：**

```ts
function buildCaseToolset(caseId, stores, scopeRules, bus): ToolDescriptor[] {
  return [
    makeListTrafficTool(caseId, stores.traffic),
    makeGetTrafficTool(caseId, stores.traffic),
    makeRecordFactTool(caseId, stores.fact, stores.timeline, bus),
    makeRecordTaskTool(caseId, stores.task, stores.timeline, bus),
    makeRecordActionTool(caseId, stores.fact, stores.action, stores.decision, stores.timeline, bus),
    makeHttpReplayTool(scopeRules),
    makeProposeScopeExpansionTool((host, reason) => { /* emit scope_expansion_proposed */ }),
  ];
}
```

**写库工具内置"三连联动"**（复用阶段 2 硬约束）：每个 `record_*` 工具 execute 内：(1) 写 store；(2) append Timeline；(3) emit RuntimeEvent。前端 Facts/Tasks/Timeline 面板通过现有 WebSocket 事件**自动刷新**——面板代码几乎不改。

**evidenceRefs 硬规则**（搬自阶段 4 ActionPlanner）：`record_action` 工具校验 evidenceRefs 非空且都是已知 fact_id；不满足则工具返回 `{ ok:false, content: "evidenceRefs 必须引用已存在的 fact" }`，LLM 看到错误自己重来（不崩、不静默丢弃）。

## 4. server 集成

**新增路由：**

```
POST /api/cases/:id/agent/run        body: { goal: string }
  → buildCaseToolset 装配工具注册进新建 ToolRegistry
  → 构造 ApprovalGate（接 WebSocket 确认门）
  → loadLlmConfig + createProviderOrMock 装配 provider（复用，已端到端验证）
  → AgentRuntime.run(system, goal, onEvent)
  → onEvent 每步 → Timeline + emit RuntimeEvent → WebSocket 推前端
  → 返回 agent 本次运行的结束状态

POST /api/cases/:id/agent/message    body: { text: string }
  → 往运行中（或下一次）agent 注入一条用户消息（人插话引导）

POST /api/agent/approvals/:id        body: { decision: "approved"|"rejected" }
  → 前端对 approval_requested 的回应，解挂对应 ApprovalGate
```

**ApprovalGate 接 WebSocket（Plan A 占位现在接实）：** command 类工具被调时，asker：(1) emit `approval_requested`（带 tool 名/输入 + approvalId）→ WebSocket 推前端；(2) 挂起等前端 POST `/api/agent/approvals/:id`；(3) 拿到决定返回 approved/rejected。本轮工具集全 normal 不触发确认门，但机制建好——**Plan B 加 sqlmap 立刻可用**。

**新增事件类型（events.ts）：**
- `agent_started` / `agent_tool_call` / `agent_tool_result` / `agent_text` / `agent_done` / `agent_error`
- `approval_requested` / `approval_resolved`
- `action_recorded`（替代旧 `action_approved`）、`scope_expansion_proposed`

**人插话/中断：** 第一版 agent 跑完一轮自然停，人插话影响下一轮（`/agent/message`）。强制中断留待需要时加。

## 5. 前端（apps/web）

- **删除**：候选确认 UI（候选 Fact/Action 列表 + confirm/reject）。
- **新增对话区**：输入框给目标 → `/agent/run`；事件流列表显示 agent 实时活动（`agent_text`/`agent_tool_call`/`agent_tool_result`）；`approval_requested` 时弹 confirm/reject → `/api/agent/approvals/:id`；插话输入框 → `/agent/message`。
- **保留**：Facts/Tasks/Timeline 面板（只读，现有 WebSocket 事件实时刷新）、Traffic 面板。
- store.ts：删候选 state，加 `agentEvents` + 对应 WS 处理。

## 6. 错误处理

- 工具 execute 出错 → 返回 `{ ok:false, content }`，LLM 自己重试/换路（Plan A 已验证）。
- provider 调用失败（网络/key）→ agent run 路由捕获，emit `agent_error`，前端显示。
- `record_action` evidenceRefs 不合法 → 工具返回错误，LLM 重来。
- LLM 跑飞 → AgentRuntime MAX_TURNS=25 兜底（Plan A 已有）。

## 7. 测试

- **新工具单测**（`extension/src/case-tools.test.ts`，重构测试核心）：内存 db + 真实 store 验证每个工具——record_fact 写库+emit、record_action evidenceRefs 校验（合法落库 / 非法返回错误）、list_traffic 读取。
- **agent run 路由测试**（`server/src/routes-agent.test.ts`）：MockProvider 注入"调 record_fact → done"序列，Fastify inject 验证 Fact 落库 + 事件 emit + approval 流（command 工具注入时走 approval_requested → /approvals 解挂）。
- **删除**：routes-phase3/4 候选模式测试；fact-extractor/action-planner 测试（随模块删除）。
- 真实 LLM 不单测（沿用）；端到端扩展现有 e2e 脚本验证 agent 自主记 Fact + 重放。

## 8. 实现分解（两个独立 plan）

```
Plan E1（后端，先行）:
  case-tools.ts（list_traffic/get_traffic/record_fact/record_task/record_action 工具）
  + 新事件类型
  + agent run/message/approval 路由 + ApprovalGate 接 WS
  + 废弃旧候选路由/模块/测试
  + 工具单测 + agent 路由单测
  → 后端 agent 闭环，curl/脚本可验证

Plan E2（前端）:
  对话流 UI（给目标/事件流/插话/approval 弹窗）替换候选 UI
  + store 改造
  → 人能在前端驱动 agent
```

Plan E1 先做（后端闭环可独立验证），E2 在其上做前端。

## 9. 核心理念落点（自检）

- **LLM 主导**：人只给目标，agent 自主编排调工具，不写死流程。
- **零硬编码**：Fact.type 开放、工具领域无关、无漏洞专用逻辑。
- **证据驱动**：record_action 保留 evidenceRefs 非空 + 已知 fact_id 硬规则（搬进工具）。
- **安全两道门**：normal 工具直接执行；command 工具（Plan B）经 ApprovalGate；http_replay 经 Scope Guard。
- **数据层稳定**：store 不改，只换"谁调 store"，重构风险可控。
- **Timeline 即历史**：写库工具三连联动，agent 每步进 Timeline + 事件。
