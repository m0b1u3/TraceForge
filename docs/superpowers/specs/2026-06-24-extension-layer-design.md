# TraceForge 统一扩展地基 设计文档

> 状态：设计已确认，待拆分为多个实施计划。这是**架构蓝图**，不是单个实施计划——实现时地基先行，MCP / 插件 / Skills 各自后续 plan。

## 1. 目标与定位

让 LLM 用**原生 tool-calling** 自主调用各种来源的工具（内置 / 外部工具插件 / MCP server），把领域知识彻底挡在核心代码之外。这是「LLM 主导、零硬编码」最高原则（设计文档 3.0）在执行层的落地：

- LLM 是主导思考、决定路线的大脑；扩展地基只是它的手脚。
- 三种扩展机制（工具插件 / MCP / Skills）共用一套统一抽象，LLM 只面对统一接口，不关心能力来自哪里。
- 领域知识（某框架/漏洞怎么测）活在可插拔的扩展层，核心代码保持通用、漏洞无关。

## 2. 整体分层

```
┌─────────────────────────────────────────────────────┐
│ Agent Runtime（@traceforge/llm 扩展）                 │
│ 原生 tool-calling loop：LLM 自主调工具→拿结果→再调     │
│ 多轮直到完成，LLM 自己决定并行/串联（我们不写编排逻辑） │
└───────────────────────┬─────────────────────────────┘
                        │ registry.toLlmTools() → 原生 tools 参数
┌───────────────────────▼─────────────────────────────┐
│ ToolRegistry（统一注册表）                            │
│ 持有所有工具统一描述；输出 LLM 原生 tools；            │
│ 执行时经两道门（ApprovalGate / Scope Guard）           │
└───┬──────────────┬──────────────┬───────────────────┘
    │ 适配器        │ 适配器        │ 适配器
┌───▼────┐   ┌─────▼──────┐  ┌────▼─────────┐
│ 内置工具 │   │ 工具插件     │  │ MCP 客户端    │
│(replay  │   │(sqlmap/     │  │(动态发现远程  │
│ 等)     │   │ nuclei/py)  │  │ MCP server)  │
└─────────┘   └────────────┘  └──────────────┘

         Skills（横切，不是工具）：
         按需把"参考资料"形式的方法论注入 LLM 上下文
```

## 3. 统一工具描述

任何来源的工具都归一成同一形状：

```ts
interface ToolDescriptor {
  name: string            // 唯一标识，如 "http_replay" / "sqlmap" / "mcp__github__search"
  description: string     // 给 LLM 看的用途说明（决定 LLM 何时调用）
  inputSchema: object     // JSON Schema，喂给 LLM 原生 tool-calling
  risk: "command" | "normal"  // 见 §6 风险门
  source: string          // "builtin" / "plugin:<name>" / "mcp:<server>"，开放字符串，仅审计用
  execute: (input: unknown) => Promise<ToolResult>  // 适配器提供的执行函数
}

interface ToolResult {
  ok: boolean
  content: string         // 回喂给 LLM 的结果文本
  meta?: Record<string, unknown>
}
```

- `risk` 只两档（YAGNI）；`source` 开放字符串（对齐零硬编码，MCP server 名无穷）。
- `execute` 把"怎么跑"封在适配器里：内置直接调、插件 spawn 进程、MCP 走协议——Registry 不关心。

## 4. ToolRegistry

内存注册表，职责单一：

```ts
class ToolRegistry {
  register(tool: ToolDescriptor): void       // 适配器调它注册（重名覆盖或报错，见下）
  unregister(name: string): void             // MCP server 断开时注销
  list(): ToolDescriptor[]
  get(name: string): ToolDescriptor | undefined
  toLlmTools(): NativeToolDef[]              // 转 Anthropic/OpenAI 原生 tools 参数
}
```

设计点：
- **动态性**：`register`/`unregister` 支持运行时变化——MCP server 接入注册其工具，断开注销。这是 MCP 动态发现的落点。
- **`toLlmTools()`** 转成各 provider 原生 `tools` 参数（`{ name, description, input_schema }`），直接喂 SDK——LLM 用训练时就会的方式调用，**不是自创 JSON 格式**。
- **重名策略**：同名工具注册时报错（不静默覆盖），避免 MCP 工具意外遮蔽内置工具；命名约定用前缀（`mcp__<server>__<tool>`）降低冲突。

## 5. Agent Runtime（原生 tool-calling loop）

`@traceforge/llm` 新增。跑多轮 agent loop：

```ts
class AgentRuntime {
  constructor(provider: LlmProvider, registry: ToolRegistry, gate: ApprovalGate, scope: ScopeChecker) {}

  async run(caseId: string, userGoal: string, onEvent: (e: RuntimeEvent) => void): Promise<void>
  // 1. registry.toLlmTools() 喂 provider 原生 tools 参数
  // 2. LLM 返回：文本，或一个/多个 tool_use（LLM 自主决定并行/串联）
  // 3. 对每个 tool_use：registry.get(name) → 经两道门 → execute → 结果回喂 LLM
  // 4. 循环直到 LLM 不再调工具（end_turn）
  // 每步 emit 事件 → Timeline + WebSocket
}
```

**扩展 `LlmProvider` 接口**：现有只有 `extractJson`（单轮）。新增支持原生 tools 的多轮方法（Anthropic 走 `messages.create` 的 tools 参数，OpenAI 走 `chat.completions` 的 tools 参数——两家都是原生 tool-calling）。

**LLM 自主编排**：loop 里不写"先调 A 再调 B"的编排——LLM 每轮自己决定调什么、并行几个、怎么串联。我们只负责"执行它要的、把结果还给它"。

## 6. 两道独立的安全门

两道门各管各的，互不替代：

### 6.1 ApprovalGate —— 只拦系统命令

```ts
class ApprovalGate {
  async check(tool: ToolDescriptor, input: unknown): Promise<"auto" | "approved" | "rejected">
  // tool.risk === "command" → emit 待确认事件，挂起等人工 confirm/reject
  // 其它（含 http_replay 对外请求、MCP 只读工具…）→ 立即 "auto"，直接执行
}
```

- `risk: "command"` 标识**会执行本地系统命令**的工具（terminal、sqlmap、nuclei、自定义 py 脚本——任何 spawn 子进程/跑 shell 的）→ 卡人工确认，防搞坏本机/失控。
- 其它一切（HTTP 重放发请求、查 Fact、看流量、MCP 只读）→ 不卡人工，流畅执行。
- 对齐设计文档 3.4（高风险才确认）+ 26.3（命令风险分级）。

### 6.2 Scope Guard —— 只守发包的授权边界（不限制思考）

**关键区分：思考 ≠ 发包。**

```
思考层（无限制）              发包层（守授权边界）
LLM 自由关联/判断/建议    →    实际向某 host 发请求
"target-cdn 可能相关"          必须该 host 在授权范围内
"这关联本身是发现"
"建议纳入测试"
```

- Scope Guard（已落地，`packages/tool-resolver`）只在**实际对外发包**前校验目标 host 是否在授权范围（越界自动拒，无需人工）。
- 它**绝不限制 LLM 思考**——LLM 想关联什么、判断什么、建议测什么，完全自由。
- 它把"决定扩大授权范围"变成一个**有意识的动作**，而非默默打过去（未授权发包=违法，不管目标多"相关"）。

**LLM 动态影响范围**——新增工具 `propose_scope_expansion(host, reason)`：

```
LLM 思考中发现 target-cdn.com，推理它与 target.com 相关
  → 不直接打它（越界违法）
  → 调 propose_scope_expansion("target-cdn.com", "同证书/同 IP 段/...")
  → 产出一个"扩范围建议"（这本身是有价值的资产测绘发现）
  → 人工一键确认加入 allowHosts
  → Scope Guard 自动放行，LLM 自由测它
```

`propose_scope_expansion` 是 `normal` 风险（只提议，不发包）。范围因此是"活的"，跟着 LLM 的发现长，而非创建 Case 时钉死。

## 7. 三种工具适配器

每种来源写一个适配器，把自己的能力转成 `ToolDescriptor` 注册进 Registry。

### 7.1 内置工具适配器
把已有的内置能力（http_replay 等）包装成 ToolDescriptor。`replay` 类 `risk: "normal"`；未来 terminal 类 `risk: "command"`。

### 7.2 工具插件适配器（sqlmap / nuclei / 自定义脚本）
- 外部工具以插件形式注册：声明 name/description/inputSchema + 如何 spawn（命令模板、参数映射）。
- 全部 `risk: "command"`（spawn 子进程）→ 走 ApprovalGate。
- 输出捕获回传为 ToolResult.content。
- 对齐设计文档 23.3「所有工具调用必须走动作卡/确认」。

### 7.3 MCP 客户端适配器
- 接入遵循 MCP 协议的外部 server，**运行时动态发现**其工具列表，逐个 `register` 进 Registry（server 断开时 `unregister`）。
- MCP 工具的 risk 默认 `normal`（多为只读/查询）；若某 MCP 工具会执行命令，标 `command`。
- 这是"LLM 运行时发现并用新工具，不需预先写死配置"的落点。

## 8. Skills（横切，严格限"参考资料"形式）

Skills 是**参考资料注入**，不是行为剧本。独立于工具地基，后续单独 plan。

**硬约束（设计契约）**：

```
✅ 允许（参考资料 / 赋能）:
- "Spring Boot 常见暴露点参考: Actuator 端点系列(heapdump 可提取内存敏感信息)…"
- "某框架已知历史漏洞清单、特征指纹、相关 CVE — 供 LLM 判断时参考"
- 措辞用"参考""常见""可能""供考虑"

❌ 禁止（命令式剧本 / 束缚）:
- "必须先扫 X 再扫 Y""按以下顺序执行""第一步…第二步…"
- 任何规定 LLM 必须怎么做、按什么固定流程的命令式表述
- 把方法论写成 LLM 只能照搬的固定步骤

机制:
- Skill = 一段带元数据的 Markdown，按相关性/人工选择注入 LLM 上下文
- LLM 完全自主决定用不用、怎么用、是否反着来 —— Skill 永不强制
```

理由：Skills 机制本身不约束（只是上下文文本），但内容若写成命令式剧本会软性束缚 LLM。本契约把它锁死在"参考"一侧——与「参考(common values 提示) vs 白名单(强制约束)」一贯的线一致。

## 9. 与现有架构的衔接

- **复用人工确认门**：ApprovalGate 复用阶段 3/4 已建的"候选→WebSocket 事件→人工 confirm/reject"模式。
- **复用 Scope Guard**：`packages/tool-resolver` 的 `checkScope` 不变，AgentRuntime 在 execute 前对发包类工具调它。
- **复用 Timeline/事件**：每个工具调用/结果/确认/扩范围建议都 emit RuntimeEvent，进 Timeline。
- **provider 抽象**：扩展 `LlmProvider` 加多轮 tool-calling 方法，Anthropic/OpenAI 两实现各自接原生 tools 参数（不硬编码模型）。

## 10. 实现分解（各自独立 plan）

```
Plan A（地基，先行）:
  ToolDescriptor + ToolRegistry + 扩展 LlmProvider 多轮 tool-calling
  + AgentRuntime loop + ApprovalGate（拦 command）
  + 内置工具适配器（用 http_replay 走通闭环）
  + propose_scope_expansion 工具

Plan B（工具插件）: 插件适配器 + sqlmap/nuclei/py 脚本注册 + spawn 执行 + 输出捕获
Plan C（MCP）: MCP 客户端适配器 + 动态发现/注册/注销 + 协议对接
Plan D（Skills）: Skill 加载 + 上下文注入 + 参考资料契约校验
```

Plan A 是核心闭环（LLM 原生 tool-calling 自主调内置工具，两道门生效）；B/C/D 各自在地基上扩展，互不阻塞。

## 11. 核心理念落点（自检）

- **LLM 思考发散**：Scope Guard 只守发包，不限思考；LLM 可提议扩范围。
- **原生能力最大化**：原生 tool-calling 协议 + LLM 自主编排 + MCP 动态发现。
- **领域知识走扩展层**：工具/MCP/Skills 注入，核心代码漏洞无关。
- **零硬编码**：source 开放字符串、无漏洞专用逻辑、Skills 限参考资料。
- **安全只在两处设闸**：执行系统命令（ApprovalGate）+ 越授权边界发包（Scope Guard），其余流畅。
