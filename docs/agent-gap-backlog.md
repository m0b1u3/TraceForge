# Agent 能力差距优化清单（vs Claude Code 等成熟 agent）

> 记录于 2026-06-29。对比对象：Claude Code / Codex 类成熟编码 / 调查 agent。
> 用途：后续依次 brainstorm → 计划 → 真实 LLM 验证（铁律：凡 LLM 行为一律真实 LLM 测，不用 mock 下结论）。
> 当前 agent 形态：单 agent 多轮循环（AgentRuntime，显式 `DEFAULT_RUN_BUDGET`），已支持 OpenAI-compatible 原生流式、fallback 流式、运行中 steering、interrupt、LLM transient retry、工具错误恢复、显式只读工具并行执行、预算耗尽 continuation 状态与一键续跑、同 Case 单 Run 互斥、Run/Token/成本持久化与崩溃恢复；暂无子 agent。

## 优先级总览

| # | 缺口 | 档位 | 状态 |
|---|---|---|---|
| 0 | 上下文语义检索（中英盲区：搜「越权」匹不到「IDOR」） | 已知 | ✅ 第一阶段完成 |
| 1 | 流式输出（streaming） | 🔴 最高 | ✅ 已完成 |
| 2 | 运行中人工中断 / 转向（interrupt / steering） | 🔴 最高 | ✅ 已完成 |
| 3 | 工具并行调用 | 🟠 高 | ✅ 已完成 |
| 4 | 重试 / 错误恢复 | 🟠 高 | ✅ 已完成 |
| 5 | 动态轮次（去掉固定 MAX_TURNS=25 硬停） | 🟠 中 | ✅ 已完成 |
| 6 | 子 agent / 任务分解并行执行 | 🟠 看需求 | 待做 |
| 7 | 真 tokenizer（替代 chars/4 字符估算） | 🟠 中 | 待做 |
| 8 | 成本 / 用量追踪（每轮 token 与花费） | 🟡 中 | ✅ 已完成 |
| 9 | 跨会话项目级记忆文件（类 CLAUDE.md 偏好层） | 🟡 低 | 待做 |
| 10 | 并发 Case 隔离运行时保护 + 崩溃恢复（设计 §29，P1） | 🟡 看需求 | ✅ 本地单进程模型已完成 |
| 11 | Observer 实时守护（当前为 run 后旁路，非运行中拦截） | 🟡 中 | 待做 |

---

## 详细说明

### 0. 上下文向量语义检索
- **现状**：✅ 第一阶段完成。`search_facts` / `recall_conversation` 先让 LLM 做 Query Expansion，再用现有 `keywordScore` 多词检索、去重排序，并在结果里标出 `matched` 扩展词。真实 LLM E2E 已验证：`search_facts({"query":"越权"})` 命中只写了 `IDOR` 的 Fact。
- **边界**：本阶段不上 embedding、不建向量表、不写死漏洞同义词表。DeepSeek 当前不支持 `json_schema` response_format，`LlmQueryExpander` 会先试 `extractJson`，失败后走普通 JSON 文本 fallback，再失败才退回原始 query。
- **后续**：如果真实任务里扩词召回仍不够，再进入第二阶段 embedding / 向量语义索引。

### 1. 流式输出（streaming）🔴
- **现状**：provider.runTools 一次性等整轮生成完才返回；前端干等数秒~数十秒，看不到 agent 实时思考。`grep stream` 在 llm/agent-runtime 无结果。
- **目标**：逐 token 流式，前端实时显示 agent 边想边说、边调工具。
- **影响**：长任务体验差；且**是 #2 中断的前提**——看不到才无从介入。

### 2. 运行中人工中断 / 转向 🔴（最该先做，直击产品定位矛盾）
- **现状**：agent run 一旦开始，跑完 25 轮或自己结束前，人**插不进话**，无法中途纠偏。AgentRuntime.run 无 abort / steering 机制。
- **目标**：run 期间人可随时打断、追加指示、改方向（ESC 或追加消息）。
- **影响**：**与产品核心定位直接冲突**——设计强调「人随时介入、把关方向」，但当前 run 期间人被锁在外面。#1+#2 是一对，应一起做。

### 3. 工具并行调用 🟠
- **现状**：✅ 已完成。ToolDescriptor 增加 `executionMode?: "parallel" | "serial"`；`AgentRuntime` 会把连续的显式只读工具调用分批 `Promise.all` 并发执行，同时按原始 tool_call 顺序写回 tool_result。`risk: "command"` 与未知工具强制串行。
- **已覆盖工具**：`list_traffic` / `get_traffic` / `search_facts` / `get_fact_detail` / `search_traffic` / `recall_conversation` / `extract_links` / `get_page_text`。
- **影响**：多接口查询、证据检索、页面只读提取可并发，写库/导航/点击/填表/命令类动作仍保持顺序与审批边界。

### 4. 重试 / 错误恢复 🟠
- **现状**：工具失败只把错误字符串塞回 LLM；LLM 调用失败（限流/超时）直接整轮 500。无自动重试 / 退避。
- **目标**：网络抖动重试、限流退避、工具失败有恢复策略。
- **影响**：真实网络下脆（已踩到 fetch failed 直接挂）。

### 5. 动态轮次 🟠
- **现状**：✅ 已完成。Dynamic run budget is explicit: the runtime warns near exhaustion and reports `needs_continuation` instead of `completed` when the budget is spent. 工作台会显示可刷新的 Continue run 操作，以旧 Run 目标启动新 Run，并复用现有 Case 对话、Facts、Tasks 与工具结果上下文，不会向已终止 Run 发送 steering。
- **目标**：动态判断、可继续、agent 自判该收尾。
- **影响**：复杂深度侦察不会再被伪装成 completed；预算耗尽会作为非成功终态暴露给 UI 和后续继续运行能力。

### 6. 子 agent / 任务分解并行 🟠
- **现状**：单 agent 线性跑，不能派子 agent 并行做独立子任务。
- **目标**：类 Task 工具，派子 agent 隔离上下文并行探索（如同时扫多个子域）。
- **影响**：大范围侦察慢且占满主上下文。

### 7. 真 tokenizer 🟠
- **现状**：token-estimate.ts 用 chars/4 + CJK 加权估算，降级决策不准。
- **目标**：精确 token 计数（tiktoken 类）+ 模型 usage 反馈闭环。

### 8. 成本 / 用量追踪 🟡
- **现状**：✅ Provider 返回的每轮 input/output/total token 已写入 SQLite `agent_run_usage`，Run 状态与累计 token 写入 `agent_runs`；服务重启后可恢复，运行中崩溃的 Run 会标记为 interrupted。LLM 设置支持可选 ISO 币种与每百万输入/输出 Token 单价；每轮成本以整数微单位随 usage 一起持久化，保证计算稳定且价格调整不改写历史账目。工作台 Token 弹窗展示累计成本和逐轮成本；未配置价格的历史或新 Run 明确显示未计价。

### 9. 跨会话项目级记忆文件 🟡
- **现状**：有 SQLite 存对话/Facts（case 级），无项目级长期偏好/约定层。
- **目标**：类 CLAUDE.md 的项目记忆（红队偏好、常用目标约定等）。

### 10. 并发 / 崩溃恢复 🟡（设计 §29，P1）
- **现状**：✅ 在当前本地单进程部署模型内，`AgentRunRegistry` 对同一 Case 强制单活动 Run，不同 Case 可独立运行；重复启动返回 HTTP 409。Run 和逐轮 usage 持久化到 SQLite，服务启动时遗留的非终态 Run 会恢复为 `interrupted`，而不是继续显示为运行中。
- **边界**：若未来支持多个后端进程共同写同一数据库，还需要数据库级租约/唯一约束；当前个人本地单服务部署不需要跨进程锁。

### 11. Observer 实时守护 🟡
- **现状**：Observer 在 run 结束后旁路审查，不能在 agent 跑偏的当下拦截。
- **目标**：运行中实时监督 + 必要时拦截/告警。

---

## 推进顺序建议

1. **#1 + #2（流式 + 中断/转向）** —— 一对，最高优先，直击「人机协同、随时把关」产品定位矛盾。
2. **#4 重试/错误恢复** —— 真实网络稳健性，已踩坑。
3. **#0 向量检索** —— 语义召回（独立、可随时插入）。
5. 其余按需（#5/#7/#8 成熟度，#6/#10 规模上来再做，#11 安全深化）。

> 每项推进都走：代码审计 → 实现 → **真实 LLM 端到端验证**（不用 mock 下结论）。
