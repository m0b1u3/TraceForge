# Agent 认知内核（Cognitive Core）设计

> 状态：设计已确认，待写实现计划。
> 蓝本：TraceForge_design.md §14（规划器）、§25（上下文与证据检索管理，P0）。
> 最高原则：第 3.0 节「LLM 主导、零硬编码」——领域决策走 LLM + 工具，代码不写死规则。

## 1. 背景与问题

当前 `AgentRuntime` 是**无状态工具循环**：每次 `agent/run` 从 `[{role:"user", content:goal}]` 单句起步，不读历史。后果：

- **跨轮无记忆**：用户说「同意/继续」，agent 不知道在同意什么，反复追问目标（已实测复现）。
- **无上下文管理**：Facts/Tasks 不回喂 LLM；长 Case 要么爆 context、要么丢信息。§25（P0）完全未实现。
- **无规划**：没有目标分解、假设（hypothesis）、阶段。agent 是应激式工具调用器，而设计目标是「有规划、有记忆、能长期连续作业的红队搭档」。
- **无会话状态**：每轮 system prompt 现拼 scopeRules，脆弱。

本设计把**记忆、上下文压缩、规划、会话状态**作为一个完整子系统（认知内核）一次性设计，落地 §14/§25。

## 2. 整体架构

在 `AgentRuntime` 与 LLM 之间插入**认知层**：负责「run 之前组装上下文、run 之后更新状态」。AgentRuntime 本身基本不变（仍是工具循环），改的是**喂给它的 messages 怎么来**。

全部归 `packages/reasoning-core`（当前仅 index.ts）：

```
packages/reasoning-core/src/
  session-state.ts      会话状态机：SessionState（currentGoal/phase/focus/activeHypotheses）
  hypothesis.ts         假设实体 + 状态机
  memory-assembler.ts   双层记忆：近期对话(原文) + 远期摘要 + Facts/Tasks 检索
  relevance.ts          §25.3 规则+关键词 Top-K 检索（无向量库）
  context-builder.ts    §25 三层上下文组装 + token 预算降级（核心）
  compressor.ts         §25.4/25.5 超预算时 LLM 摘要远期对话/已done任务
```

**数据流（一次 agent/run）**：

```
1. ContextBuilder.build(caseId, userGoal) → messages
     ├─ Layer1 Focus：SessionState.focus + 最近N轮原始对话 + 活跃Task + 最新Observer warning + scopeRules
     ├─ Layer2 Relevant：relevance.topK(facts / 活跃hypotheses / recheck_candidate tasks)
     ├─ Layer3 Summary：compressor 远期摘要 + done任务一行结论 + 同类Fact聚合摘要
     └─ 受 ContextBudget 约束，超预算按 §25.4 逐级降级
2. AgentRuntime.run(system, messages, ...)   ← 不再是单句 goal
3. run 结束：LLM 经工具更新 SessionState / 记录 hypothesis；若对话超长，compressor 增量生成摘要存库
```

**边界**：
- ContextBuilder 只读、纯组装，可单测（喂假 facts/state → 验证 messages 结构与裁剪）。
- SessionState / Hypothesis 转换由 **LLM 经工具**驱动，不写死规则。
- Compressor 失败/无 LLM 降级不崩（回退规则截断），沿用 Observer 容错模式。

**新增库表**（均 case_id 隔离）：`session_state`（每 Case 一行）、`hypotheses`、`context_summaries`。Facts/Tasks 表不动。

## 3. 三层上下文（§25 核心）

```
Layer 1 Focus 焦点层 —— 必含，永不裁剪
  · SessionState：currentGoal / phase / focus(host/url/note)
  · 最近 N 轮原始对话（user + agent 回复，保连贯，"同意/继续"靠这层）
  · 当前活跃 Task + 其 relatedFacts
  · 最新一条未处理的 Observer warning
  · 已确认的 scopeRules（agent 永远知道当前能测什么）

Layer 2 Relevant 相关层 —— 按相关性 Top-K 检索
  · 与 focus 相关的 Facts（relevance.topK）
  · 活跃 hypotheses（未验证假设）
  · recheck_candidate Tasks

Layer 3 Summary 摘要层 —— 压缩，不含原文
  · compressor 远期对话摘要
  · done/rejected/out_of_scope 任务一行结论
  · 同类 Fact 超阈值的聚合摘要（"已发现 12 个 API，3 个含敏感参数"）
```

### 3.1 相关性检索（§25.3，规则+关键词，无向量库）

```
relevanceScore(fact, focus) =
    类型相关性    (focus 是 login 时 credential/token/session 高权)
  + scope 匹配    (同 host 加权；跨 scope 置 0)
  + 图距离        (graph 上距焦点节点越近越高，超 N 跳衰减)
  + 时间新鲜度    (越新越高；confirmed 关键 fact 不衰减)
  - 已消费惩罚    (已被某成功 Action 采纳的探索性 fact 降权)
```

预留 `RetrievalStrategy` 接口，日后可换向量检索（embedding fact.title + value 摘要），第一版不引入向量库。

### 3.2 Token 预算与降级（§25.4）

```ts
interface ContextBudget {
  maxTokens: number      // 模型窗口安全比例，如 60%
  focusReserve: number   // Layer 1 始终保留的最小预算
  perLayerRatio: [number, number, number]  // 三层默认分配
}
```

超预算时按顺序降级（每步重算，够了即停）：

```
1. 压缩 Layer 3 摘要（聚合更狠）
2. 降低 Layer 2 的 K
3. 缩小 graph 子图跳数 N
4. 截断 Layer 1 长响应体（保留 header / 错误信息 / JSON 骨架）
5. 仍超 → 发 Observer warning：上下文过载，建议人工拆 Case
```

**token 计数**：第一版用字符数估算（`chars/4 ≈ tokens`，中文按 ~1.5 字符/token 调系数），不引入 tokenizer 库。估算偏差走保守方向（宁可少塞），不会爆窗口。预留接口可换真 tokenizer。

### 3.3 硬规则（§25.6，不可违反）

```
1. 被现存 Action Card.evidenceRefs 引用的 fact，禁止裁剪出上下文。
2. 跨 scope 的 fact 默认不进当前焦点。
3. 每次组装记录"注入了哪些 fact_id + token 用量"到 timeline（成本审计 + 调试）。
```

## 4. 规划器 + 会话状态（§14）

### 4.1 SessionState（每 Case 一行，LLM 经工具维护）

```ts
interface SessionState {
  caseId: string
  currentGoal: string        // 当前在追的目标（开放字符串）
  phase: "recon" | "analyze" | "exploit" | "report"  // 闭枚举：系统状态机
  focus: { host?: string; url?: string; note?: string }  // note 开放字符串
  activeHypothesisIds: string[]
  updatedAt: string
}
```

- `phase` 闭枚举（有限阶段）；`currentGoal` / `focus.note` 开放字符串（LLM 自由表达）——遵循开闭枚举原则。
- 转换由 LLM 经工具 `update_session_state` 驱动；代码不写"何时进入 exploit 阶段"这类规则。

### 4.2 Hypothesis（规划核心产物，case_id 隔离）

```ts
interface Hypothesis {
  id: string
  caseId: string
  statement: string          // "psp.zilueit.com 的订单接口可能存在越权"
  status: "open" | "confirmed" | "refuted"   // 闭枚举：验证状态机
  basedOnFactIds: string[]   // 基于哪些已记录 Fact（证据驱动，非空硬规则）
  relatedTaskIds: string[]   // 为验证它而建的 Task
  createdAt: string
  updatedAt: string
  updateCount: number
}
```

**假设驱动的工作循环**（有规划的红队）：

```
1. 看证据 → record_hypothesis("X 可能越权", basedOnFactIds=[...])
2. 为验证 → record_task("重放订单接口换 user_id", relatedHypothesis=hX)
3. 测完 → resolve_hypothesis(hX, "confirmed"/"refuted", 引用新 Fact 为据)
4. confirmed → 转 finding Fact + Action Card；refuted → 关闭，不再占上下文
```

### 4.3 新增 4 个 agent 工具（LLM 自主调，延续 case-tools 体系）

| 工具 | risk | 作用 |
|---|---|---|
| `update_session_state` | normal | 更新当前目标/阶段/焦点 |
| `record_hypothesis` | normal | 记录假设；**强制 basedOnFactIds 引用已存 Fact**（无证据猜测被拒，延续 evidenceRefs 硬规则） |
| `resolve_hypothesis` | normal | confirmed/refuted；confirmed 须引用验证它的新 Fact |
| （查询）hypotheses 入上下文 | — | 活跃假设进 Layer 2 |

全部 risk=normal（只改内部状态、不对外发包，故不过 ApprovalGate）。

### 4.4 与现有重评估衔接

已有 `reopen_task` / `revert_done_task`（§13）继续用。新假设/新 Fact 入库时，沿用现有「LLM 判断是否重启相关 Task」机制，不新增硬编码触发规则。

## 5. 压缩、容错、测试

### 5.1 Compressor（§25.4/25.5，LLM 摘要）

**触发**：ContextBuilder 组装时 Layer 3 仍超预算 → 调 compressor。
**做法**：独立 LLM 调用（旁路，像 Observer），把「远期对话 + done 任务」压成结论摘要，存表复用。
**增量**：只摘要「上次摘要点之后」的新内容，旧摘要滚动合并，避免重复花钱。

```ts
interface ContextSummary {
  id: string
  caseId: string
  coversUpToEventSeq: number   // 摘要覆盖到 agent_events 哪条（增量边界）
  content: string
  createdAt: string
}
```

### 5.2 容错（降级不崩）

```
· Compressor 失败/无 LLM       → 回退规则截断（留对话首尾 + Facts 计数聚合），run 继续
· SessionState 读不到          → 空状态起步（等价当前行为），不阻断
· ContextBuilder 子步异常      → 兜底返回 Layer1 最小上下文，记 Observer warning
· token 估算偏差               → 降级保守（宁可少塞），不爆窗口
```

认知内核是增强，任何一环挂掉，agent 退回「至少能跑」状态，绝不让 run 失败。

### 5.3 测试（TDD，vitest，注入 mock 不打真 LLM）

| 单元 | 测什么 |
|---|---|
| `relevance.ts` | 同 host 加权、跨 scope 置 0、新鲜度衰减、已消费降权 → score 排序 |
| `context-builder.ts` | 三层组装结构、硬规则（evidenceRefs 引用的 fact 不被裁）、超预算逐级降级 |
| `compressor.ts` | 增量边界（只摘要新内容）、失败回退规则截断 |
| `session-state.ts` | phase 闭枚举校验、focus 开放字符串、LLM 工具更新 |
| `memory-assembler.ts` | 近期原文 + 远期摘要 + Facts 检索拼装 |
| 新 4 工具 | record_hypothesis 拒空 basedOnFactIds、resolve confirmed 须引新 Fact |
| 集成 | agent/run 第二轮能读到第一轮对话（"同意"能理解） |

## 6. 实现分期（A→F，每期独立 TDD 可测）

```
A. SessionState 表 + update_session_state 工具 + store        （地基）
B. Hypothesis（hypothesis.ts 实体/状态机）+ 表 + record/resolve_hypothesis 工具 + store （规划）
C. relevance + memory-assembler                               （检索/记忆）
D. context-builder 三层 + ContextBudget 降级                  （核心组装）
E. compressor + context_summaries 表                          （压缩）
F. 接线 routes.ts agent/run（用 ContextBuilder 替换单句 goal）+ 前端展示  （集成）
```

F 完成时，「同意/继续不认」根治——它是整个内核落地的自然结果，不是单独补丁。

## 7. 非目标（YAGNI）

- 不引入向量库 / embedding（留 RetrievalStrategy 接口）。
- 不引入精确 tokenizer（字符估算够驱动降级）。
- 不做置信度传播（§27，独立模块，后续）。
- 不做并发/崩溃恢复（§29，独立模块，后续）。
- 前端不做假设图谱可视化（先让数据跑通，可视化后续接 Graph）。
