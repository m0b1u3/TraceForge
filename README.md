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

DeepSeek 这类只支持 JSON Object 的 OpenAI 兼容端点，需要在 `config/llm.json` 里保留 `"jsonMode": "json_object"`。

`config/llm.json` 不纳入版本控制；未配置时 AI 提取返回空候选（其余功能不受影响）。

## 当前进度（阶段 0-4 + 通用重放引擎 + 扩展地基 A + agent 交互 E1/E2 + 共享浏览器 F1/F2 + MCP 集成 C + 工作台 UI + PoC MCP server + LLM 重评估 + Observer 监督 + Agent 认知内核 + Pull 式记忆检索 + Agent Run Control + LLM/Tool Reliability + Tool Parallelism + LLM Query Expansion Retrieval + Dynamic Run Budget + Observer Warning Action Loop）

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
- MCP 集成（Plan C）：server 启动时连接 config/mcp.json 声明的 stdio MCP server，动态发现其工具并纳入 agent 工具集（命名空间 mcp__<server>__<tool>，默认 risk=command 过确认门，可逐 server 降为 normal）。领域工具留在进程外、零侵入核心——「特定领域知识走 MCP 扩展」原则的主载体。GET /api/mcp/tools 可查当前工具池。单 server 连接失败/无配置不影响 TraceForge 启动（降级不崩）
- 整体工作台 UI（修订路线第 1 项）：三栏多面板工作台（终端美学深色主题）——顶栏（Case 切换/新建 + 控制权状态）+ 左栏（共享浏览器控制 + 流量）+ 中栏（Agent 对话，事件流 + 审批）+ 右栏（Facts/Tasks/Timeline/MCP/Graph 五 Tab）。Graph 用 React Flow 把 Facts/Tasks/Actions 渲染为证据关系图谱（边=evidenceRefs，即「每个动作都有证据依据」的可视化），可嵌入小图 + 点击放大全屏缩放拖拽；放大视图里点节点弹详情侧栏（meta 全字段 + 关联边）。取代旧裸占位 UI，后端零改动
- Terminal/PoC MCP server（@traceforge/mcp-poc-server，修订路线第 2 项）：独立 stdio MCP server，暴露 exec_command/write_file/read_file/list_dir 四个原子工具，按 caseId 锁进 workspace/<caseId>/（路径逃逸拒绝 + 命令超时 + 输出截断）。让 agent 写 PoC、跑命令、装依赖、读输出——装依赖=exec pip/npm、跑脚本=write+exec、分析=LLM 读输出自判，零硬编码。命令执行 risk=command 过 ApprovalGate 人工确认。core 零改动，经 config/mcp.json 接入（见 mcp.example.json）
- LLM 驱动的重评估（修订路线第 4 项）：两个 agent 工具 reopen_task（重启未完成的旧任务，normal）与 revert_done_task（打回已完成结论，command 过 ApprovalGate 人工确认），都转为 recheck_candidate。新 Fact 入库后 LLM 自主判断哪些旧任务该复活/翻案——Fact↔Task 关联完全由 LLM 决定，代码不写 factTypeToTriggers 等映射表（第 27 章双向重评估的去硬编码最小闭环）。两工具强制 evidenceRefs 引用已记录 Fact
- Observer 监督（修订路线第 5 项）：agent 一轮 run 结束后系统自动发一次独立 LLM 调用（旁路监督，不干预），把轨迹 + Facts/Tasks 摘要交给它判断 agent 有无无依据猜测/忽略已有信息/偏离目标/过早结束等问题，产出 ObserverWarning（level=info/warning/critical）存库 + 工作台 Observer Tab 展示。10 个检查项是 prompt 指引而非代码 if 规则（零硬编码）；只提醒、纠偏决定权留给人。轨迹用 <untrusted_data> 边界防注入；Observer 失败不影响 agent run（降级不崩）
- 实时实体数据机制（工作流图谱重做 第 1 轮 / 共 3 轮）：Fact/Task 加 updateCount/updatedAt/validity；record_fact/record_task 入参可带 id 实现 upsert（带=更新该实体并 updateCount+1、emit fact_updated/task_updated；不带=新建），LLM 自主决定。为后续工作流图谱的「节点实时计数+状态变化」提供数据地基
- 工作流图谱引擎（图谱重做 第 2 轮 / 共 3 轮）：GraphView 换 @xyflow/react v12 + elkjs 自动布局，照 BreachWeave 风做成浅色白卡片节点（类型徽章 + 标题 + body + N updates，validity=superseded 置灰划线）+ 流动贝塞尔连线 + 最新 updatedAt 节点自动聚焦。节点随真实 agent 事件实时出现/更新
- 整体 demo 风样式（图谱重做 第 3 轮 / 共 3 轮 · 收尾）：以 BreachWeave demo 的 styles.css 为基底重做整个工作台为浅色专业风（.app-shell/.topbar/.workspace/.panel/.request-row/.message/.composer），各组件结构对齐 demo；演示专用部分（重放/假导航/写死 id）换成真功能（Case 选择/控制权状态/真事件流）；去图谱作用域整体浅色统一。保留 Geist + 思源黑字体
- Agent 认知内核（packages/reasoning-core）：给 agent 加跨轮记忆 + 上下文管理 + 规划 + 会话状态，把无状态工具循环升级为有记忆能连续作业的红队搭档。落地设计文档 §14（规划器）+ §25（上下文与证据检索，P0）。① 会话状态 SessionState（currentGoal/phase 闭枚举/focus，LLM 经 update_session_state 工具维护）② 假设驱动规划 Hypothesis（statement/status，record_hypothesis 强制 basedOnFactIds 引用已存 Fact—证据驱动硬规则；resolve confirmed 须引证实 Fact）③ 三层上下文 ContextBuilder（Focus 焦点不裁 + Relevant 相关性 Top-K 检索 + Summary 远期摘要）受 token 预算约束，超预算逐级降级（砍摘要→降 K→截断）④ 相关性检索 relevanceScore（同 host/关键词 bigram/新鲜度/已消费，跨 scope 置 0，无向量库）⑤ token 字符估算（无 tokenizer 库）⑥ Compressor 远期对话增量 LLM 摘要（失败回退规则截断，存 context_summaries 复用）。agent/run 前用 ContextBuilder 把历史对话+相关证据+会话状态组装成三层 messages 传给 LLM，run 后 LLM 经工具更新状态——根治「发新对话不认上文（同意/继续）」。容错：认知层任一环失败降级不崩，agent run 退回至少能跑。零硬编码：状态/假设转换全由 LLM 决定，代码不写领域规则
- Pull 式记忆检索（packages/extension/memory-tools + reasoning-core/keyword-search）：把认知内核的 push 式 Fact 预塑（ContextBuilder 用 relevanceScore 替 LLM 猜 12 个 Fact 塞进 context）改为 pull 式——给 agent 检索工具自己拉，向 Claude Code「系统提示轻量 + 工具按需拉取」形态靠拢，把「哪些 Fact 相关」的决策权从代码规则交还 LLM。① 4 个检索工具 search_facts（搜 type/title/value/tags，命中返摘要）/ get_fact_detail（拉完整 value）/ search_traffic（搜 url/method）/ recall_conversation（搜远期对话+摘要），均复用现有 store 方法、risk=normal、结果带「下一步提示」② keywordScore 公共 bigram 打分纯函数（支持中文连续串，留 embedding 升级接口）③ ContextBuilder 瘦身：删 Layer2 Fact 预塑，Layer1 改放「资源清单」行（告诉 agent 有 N 个 Fact/流量/远期摘要可查 + 提示用检索工具），入参 facts[]→count。混合式：轻量确定性上下文（目标/host/近期对话）仍 push，大量证据按需 pull。第一版关键词检索（中英文不互通是已知盲区，留向量语义为后续迭代）
- Agent Run Control（Streaming + Interrupt/Steering）：agent run 升级为可管理后台运行对象，启动后返回 runId；前端通过 stream 事件实时显示输出，运行中可追加 steering 指令并可停止当前 run。OpenAI-compatible provider 优先真流式，其它 provider 走统一 fallback；真实 LLM 验证见 `docs/superpowers/plans/2026-06-30-agent-run-control-real-llm-check.md`。
- LLM/Tool Reliability：LLM provider 调用增加中断感知 transient retry（429/5xx/网络抖动，abort 不重试），runtime 把工具异常转成 `[tool_error]` tool_result 交还 LLM 自主恢复，并通过 `agent_retrying` 事件向工作台显示重试状态。真实 OpenAI-compatible 流式和 interrupt E2E 已验证，结果见 `docs/superpowers/plans/2026-07-01-llm-tool-reliability.md`。
- Tool Parallelism：工具描述增加 `executionMode` 并默认串行；显式标记的只读工具（流量读取、记忆检索、页面文本/链接提取）会在同一 LLM 轮次内按连续批次并发执行，`risk=command`、未知工具、写库/导航/点击/填表工具保持串行。runtime 并发执行但按原始 tool_call 顺序回写 tool_result，避免破坏 LLM tool-calling 协议。验证结果见 `docs/superpowers/plans/2026-07-01-tool-parallelism.md`。
- LLM Query Expansion Retrieval：`search_facts` / `recall_conversation` 在关键词检索前调用 LLM 扩写相关检索词（中英术语、缩写、相邻安全表达），再复用 `keywordScore` 多词检索并显示 matched 扩展词；扩词失败自动退回原始 query。本阶段不上 embedding、不建向量表、不写死漏洞同义词表。真实 DeepSeek/OpenAI-compatible E2E 已验证 `search_facts("越权")` 能召回仅写有 `IDOR` 的 Fact，结果见 `docs/superpowers/plans/2026-07-01-llm-query-expansion-retrieval.md`。
- Dynamic Run Budget：Agent runs use an explicit turn budget. If the model spends the budget before finishing, the run ends with `needs_continuation` instead of `completed`, and clients receive `agent_run_needs_continuation`. The optional `/api/cases/:id/agent/run` request field `budget` supports `maxTurns` and `warningTurnsRemaining`; omitted values use the runtime default.
- Observer Warning Action Loop：Observer warning 不再只是展示，可由人工一键继续运行、转换成 Task 或忽略；转换 Task 会进入现有 Tasks 工作流，继续运行复用现有 agent/run。Observer 仍不自动干预，所有纠偏动作由人触发。OpenAI-compatible `extractJson` 在兼容端点不支持 `json_schema` response_format 时会降级为普通 JSON prompt，避免真实 Observer 因 schema 模式不可用静默失效。

## 测试

```bash
pnpm test     # 309 个单元测试
pnpm -r build # 全量构建
```
