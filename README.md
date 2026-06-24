# TraceForge

证据驱动的人机协同红队推理工作台。详见 [设计文档](TraceForge_design.md)。

## 开发启动

```bash
pnpm install
pnpm --filter @traceforge/server exec playwright install chromium
pnpm dev:server   # 后端 :4000
pnpm dev:web      # 前端 :5173
```

打开 `http://localhost:5173`：创建 Case（指定 allow hosts）→ 输入范围内 URL 点击 Open → Traffic Panel 经 WebSocket 实时显示捕获的请求。越界 URL 会被 Scope Guard 拦截（403），不产生流量。

## 配置 LLM（可选，启用 AI 提取）

拷贝模板并按需修改 provider/model/baseUrl，再设置对应 API key 环境变量：

```bash
cp config/llm.example.json config/llm.json
# DeepSeek（OpenAI 兼容）示例：
export DEEPSEEK_API_KEY=sk-...
# 或 Anthropic：把 config/llm.json 改为 anthropic provider，并
export ANTHROPIC_API_KEY=sk-ant-...
```

`config/llm.json` 不纳入版本控制；未配置时 AI 提取返回空候选（其余功能不受影响）。

## 当前进度（阶段 0-4 + 通用重放引擎 + 扩展地基 Plan A + agent 交互 E1/E2 + 共享浏览器 F1/F2）

- pnpm monorepo 骨架
- Scope Guard 安全地基（deny-by-default + 通配符，单元测试覆盖）
- SQLite 存储（Case / Traffic / Fact / Task / Timeline / ActionCard / Decision，case_id 隔离）
- WebSocket 事件总线
- Playwright 抓包 + 实时 Traffic Panel
- Facts / Tasks / Timeline：手动标记请求为 Fact、创建挂起（blocked）Task、Timeline 实时回放
- AI 事实提取：从流量提取候选 Fact（带 prompt injection 数据边界防护），人工 confirm/reject 后入库。LLM 多 Provider 可配置（Anthropic / OpenAI 兼容，后者覆盖 DeepSeek 等），模型与 baseURL 由 config/llm.json 决定
- Action Card：AI 基于已确认 Facts 生成候选动作（每个动作必须引用至少一个 fact_id，无证据依据的动作被拒），人工 approve/reject，批准时记录 Decision
- 通用 HTTP 重放引擎（@traceforge/tools）：重发任意请求 + 改任意参数为任意值 + 客观对比（状态码/长度，body 原样返回）。不内置漏洞专用探测器，漏洞测试变体由 AI 生成
- 扩展地基 Plan A（@traceforge/extension）：统一 ToolRegistry + LLM 原生 tool-calling AgentRuntime（LLM 自主多轮调工具）+ 两道门（ApprovalGate 只拦系统命令、Scope Guard 守发包授权边界）+ 内置工具（http_replay、propose_scope_expansion）。MCP / 工具插件 / Skills 在此地基上后续接入
- agent 驱动交互（Plan E1 后端）：人给目标，AgentRuntime 自主多轮调工具（看流量 / 记 Fact-Task-Action / 重放），写库直接落库（normal 风险），只有系统命令类才经确认门。取代旧的单轮候选确认模式（FactExtractor/ActionPlanner 已移除）
- agent 前端对话流（Plan E2）：人在对话区给目标启动 agent，事件流实时显示 agent 调工具活动，危险动作弹确认；Facts/Tasks/Timeline 面板实时刷新。旧候选确认 UI 已移除
- 人机共享浏览器（Plan F1 后端）：持久有头 Chromium 会话（每 Case 一个）+ 控制权锁（LLM 默认探索，人随时接管/交回）+ 浏览器工具（navigate/click/fill/extract_links/get_page_text 纳入 agent 工具集，navigate 过 Scope Guard）。人和 LLM 共享同一会话，流量自动进库。取代旧的一次性无头 /open
- 人机共享浏览器（Plan F2 前端）：浏览器控制区（启动/停止/接管/交回）+ 控制权状态条（LLM/人 + 当前 URL）替换旧的一次性 Open UI。Traffic 面板靠 response_captured 事件实时刷新（人和 LLM 操作产生的流量都出现）

## 测试

```bash
pnpm test     # 90 个单元测试
pnpm -r build # 全量构建
```
