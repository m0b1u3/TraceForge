# Agent Run Control（Streaming + Interrupt/Steering）设计

> 状态：设计已确认，待写实现计划。
> 对应 backlog：`docs/agent-gap-backlog.md` #1 流式输出 + #2 运行中人工中断/转向。
> 最高原则：LLM 主导、零硬编码。本文只改 agent 运行协议与人机协作控制，不引入任何漏洞领域规则。

## 1. 背景与问题

当前 TraceForge 的 agent run 是一次性长请求：

```text
POST /api/cases/:id/agent/run
  -> routes.ts await AgentRuntime.run(...)
  -> provider.runTools(...) 每轮整块返回
  -> 前端只能等 agent_done / agent_error
```

这带来三个直接问题：

1. **不可观察**：真实 LLM 可能思考数秒到数十秒，前端看不到增量输出。
2. **不可介入**：run 开始后，用户不能中途补充方向，只能等结束。
3. **不可停止**：没有 run id / AbortController / 中断 API，前端只能“等它自己停”。

这与 TraceForge 的核心定位冲突：人应能随时观察、把关、接管和修正 agent。

本轮目标是把 agent run 从“一个等待完成的 HTTP 调用”升级成“可管理的运行对象”，先打通实时协作闭环。

## 2. 范围

### 2.1 本轮做

- AgentRun 运行状态模型（第一版内存态）。
- 后台运行：`POST /agent/run` 立即返回 `runId`，agent 在后台继续跑。
- Streaming 事件协议：前端能增量显示 assistant 文本。
- Provider streaming fallback：不支持真流式的 provider 仍通过统一事件协议工作。
- OpenAI-compatible provider 优先实现真 streaming。
- Interrupt：用户可停止当前 run，状态变为 `interrupted`。
- Soft steering：运行中用户追加指令，当前 LLM/tool turn 结束后注入下一轮。
- 前端 AgentPanel 支持运行中插话与停止。
- 真实 LLM 端到端验证 streaming / steering / interrupt。

### 2.2 本轮不做

- Run 表持久化与崩溃恢复（留 §29）。
- 硬转向：追加指令时立刻 abort 当前 LLM call 并重开。
- 工具并行调用。
- 动态 MAX_TURNS。
- Observer 运行中实时拦截。
- 所有 provider 一次性真流式。
- 任何漏洞类型、payload、判定逻辑硬编码。

## 3. 推荐方案

采用 **增量可落地方案 A**：

```text
Run 状态模型
  + 后台运行
  + OpenAI 真 streaming
  + 非 streaming provider fallback
  + Abort interrupt
  + Soft steering
```

Soft steering 的语义：

```text
用户运行中追加指令
  -> 后端记录 steering queue
  -> emit agent_steering_added
  -> 当前 LLM/tool turn 正常结束
  -> AgentRuntime 在下一轮前消费 queue
  -> 追加一条 user message:
     [Human steering]
     用户运行中补充指令：...
```

这种方案不需要处理半截 tool_call，也不会破坏 Anthropic / OpenAI 的工具调用消息协议。它的介入不是“毫秒级抢断”，但足够把人重新放回控制回路。

## 4. 数据模型

### 4.1 AgentRun

新增 shared schema：

```ts
export const AgentRunStatusSchema = z.enum([
  "queued",
  "running",
  "interrupting",
  "interrupted",
  "completed",
  "failed",
]);

export const AgentRunSchema = z.object({
  id: z.string(),
  caseId: z.string(),
  goal: z.string(),
  status: AgentRunStatusSchema,
  createdAt: z.string(),
  startedAt: z.string().nullable().default(null),
  finishedAt: z.string().nullable().default(null),
  interruptReason: z.string().nullable().default(null),
  error: z.string().nullable().default(null),
});
```

`goal` 是开放字符串，由用户输入。`status` 是系统状态机，保留闭 enum。

### 4.2 AgentRunRegistry

server 内新增内存注册表：

```ts
interface ActiveAgentRun {
  run: AgentRun;
  abortController: AbortController;
  steeringQueue: string[];
}

class AgentRunRegistry {
  start(caseId: string, goal: string): ActiveAgentRun;
  get(runId: string): ActiveAgentRun | undefined;
  getActiveByCase(caseId: string): ActiveAgentRun | undefined;
  addSteering(runId: string, text: string): AgentRun | undefined;
  consumeSteering(runId: string): string[];
  interrupt(runId: string, reason?: string): AgentRun | undefined;
  complete(runId: string): AgentRun | undefined;
  fail(runId: string, error: string): AgentRun | undefined;
}
```

第一版只允许同一 case 一个 active run。若已有 `queued/running/interrupting` run，再启动新 run 返回 409。

## 5. 事件协议

新增 RuntimeEvent：

```ts
| { type: "agent_run_started"; run: AgentRun }
| { type: "agent_stream_start"; caseId: string; runId: string; messageId: string }
| { type: "agent_stream_delta"; caseId: string; runId: string; messageId: string; delta: string }
| { type: "agent_stream_end"; caseId: string; runId: string; messageId: string; content: string }
| { type: "agent_steering_added"; caseId: string; runId: string; content: string }
| { type: "agent_run_interrupted"; run: AgentRun }
| { type: "agent_run_completed"; run: AgentRun; content: string }
| { type: "agent_run_failed"; run: AgentRun; error: string }
```

兼容策略：

- 旧事件 `agent_started` / `agent_text` / `agent_done` / `agent_error` 第一版保留。
- 新前端优先消费新事件。
- 测试覆盖新事件；旧事件只做兼容，不再作为新功能主协议。

## 6. Provider 接口

当前 `LlmProvider.runTools(args): Promise<RunTurn>` 保留。

新增可选接口：

```ts
export interface StreamToolsHandlers {
  onTextDelta?: (delta: string) => void;
  signal?: AbortSignal;
}

export interface LlmProvider {
  extractJson(args: ExtractJsonArgs): Promise<unknown>;
  runTools(args: RunToolsArgs): Promise<RunTurn>;
  streamTools?(args: RunToolsArgs, handlers: StreamToolsHandlers): Promise<RunTurn>;
}
```

AgentRuntime 调用规则：

```text
if provider.streamTools exists:
  await streamTools(...)
else:
  const turn = await runTools(...)
  emit one delta with turn.text
```

### 6.1 OpenAI-compatible streaming

OpenAI-compatible provider 使用 Chat Completions `stream: true`：

- text delta 实时调用 `onTextDelta`。
- tool_call delta 累积 `id/name/arguments`。
- stream 结束后把累积的 tool calls 解析为 `ToolCall[]`。
- `finish_reason !== "tool_calls"` 时 `done=true`。
- `signal` 传入 OpenAI SDK 请求，支持 interrupt。

### 6.2 Anthropic fallback

Anthropic provider 第一版不强制真流式：

- 不实现 `streamTools`，走 AgentRuntime fallback。
- 仍通过统一 `agent_stream_*` 事件输出，只是 delta 粒度为整段文本。

后续可独立做 Anthropic 真流式。

## 7. AgentRuntime 变更

新增 run options：

```ts
export interface AgentRunOptions {
  signal?: AbortSignal;
  runId?: string;
  getSteeringMessages?: () => string[];
}
```

新增 AgentEvent 类型：

```ts
| { type: "stream_start"; messageId: string }
| { type: "stream_delta"; messageId: string; content: string }
| { type: "stream_end"; messageId: string; content: string }
| { type: "interrupted"; content: string }
```

运行循环规则：

1. 每轮开始检查 `signal.aborted`。
2. LLM 调用使用 `streamTools` 或 fallback。
3. streaming 文本仍作为 assistant message 的 `content` 保存。
4. 工具执行前后检查 abort。
5. 当前轮 tool results 写入 messages 后，消费 steering queue。
6. 每条 steering 追加为 user message。
7. 如果 abort，emit `interrupted` 并停止，不继续 Observer / compressor 的“成功后处理”。

工具执行本身第一版不强杀正在运行的同步工具。若 signal 在工具执行期间触发，工具返回后立即停止下一步。后续命令/MCP 工具可扩展 signal-aware execute。

## 8. Server API

### 8.1 启动 run

```http
POST /api/cases/:id/agent/run
Body: { goal: string }
Response: { run: AgentRun }
```

语义：

- 校验 case 存在。
- 若该 case 有 active run，返回 409。
- 创建 run，emit `agent_run_started` 和旧 `agent_started`。
- 启动后台 async task 执行 AgentRuntime。
- HTTP 立即返回 run。

### 8.2 追加 steering

```http
POST /api/agent/runs/:runId/steer
Body: { content: string }
Response: { run: AgentRun }
```

语义：

- run 不存在返回 404。
- run 非 running/queued/interrupting 返回 409。
- content 为空返回 400。
- 入 queue，emit `agent_steering_added`。
- 同时写 agent_events，kind 可复用 `user`，文本前缀为 `[steering]`。

### 8.3 中断 run

```http
POST /api/agent/runs/:runId/interrupt
Body: { reason?: string }
Response: { run: AgentRun }
```

语义：

- run 不存在返回 404。
- 已完成/失败/中断的 run 幂等返回当前状态。
- active run 调 `abortController.abort(reason)`。
- 状态先置 `interrupting`，最终由 background task 置 `interrupted`。

### 8.4 查询 active run

```http
GET /api/cases/:id/agent/runs/active
Response: AgentRun | null
```

用于刷新页面后恢复当前 UI 状态。第一版内存态，进程重启后返回 null。

## 9. 前端交互

AgentPanel 状态从 `agentBusy: boolean` 升级为：

```ts
activeRun: AgentRun | null;
streamingMessages: Record<string, string>;
```

输入框语义：

```text
无 active run:
  placeholder = 给 agent 一个目标
  submit -> runAgent(caseId, goal)

active run running/queued/interrupting:
  placeholder = 给当前 run 补充指令
  submit -> steerRun(runId, content)
  显示停止按钮 -> interruptRun(runId)
```

消息流区分：

- 初始目标：`你`
- steering：`你 · steering`
- assistant streaming：同一 messageId 上持续拼接
- tool call/result：沿用现有显示
- interrupted/completed/failed：状态消息

前端不做复杂可视化。本轮重点是可操作、可看见、状态不乱。

## 10. 错误处理

- active run 冲突：409，前端 toast 提示“当前 Case 已有运行中的 agent”。
- steering 到已结束 run：409，前端提示并恢复输入为新目标模式。
- interrupt 后 LLM/provider 抛 AbortError：归一为 interrupted，不显示 failed。
- 非 AbortError：run failed，emit `agent_run_failed` 与旧 `agent_error`。
- background task 异常必须落 agent_event，不能只 console.error。

## 11. 测试策略

### 11.1 单元测试

- shared schema：AgentRun status 默认/闭 enum/事件 schema。
- AgentRunRegistry：
  - 同 case active run 冲突。
  - steering 入队和消费后清空。
  - interrupt 幂等。
  - complete/fail 清 active。
- AgentRuntime：
  - fallback provider 也 emit stream_start/delta/end。
  - abort 前置时 emit interrupted。
  - tool 后消费 steering，下一轮 messages 包含 steering。
- OpenAI provider stream parser：
  - text delta 累积。
  - tool_call arguments 分片累积并 JSON parse。
  - signal 透传。
- routes：
  - run 立即返回 run。
  - steer emit event。
  - interrupt emit/状态变化。

### 11.2 前端测试/构建

- store 测新事件：
  - stream delta 拼接。
  - steering event 入消息流。
  - completed/interrupted 清 activeRun。
- `pnpm --filter @traceforge/web build`。

### 11.3 真实 LLM 端到端

必须使用真实 LLM 验证，不用 mock 宣称功能可用：

1. 启动后端（注入 `.env` 和代理）。
2. 打开前端。
3. 创建 Case。
4. 发起一个会产生多轮思考/工具调用的目标。
5. 观察文本增量出现。
6. 运行中发送 steering：“先暂停当前方向，优先列出已有资源再决定下一步”。
7. 验证下一轮 LLM 响应受 steering 影响。
8. 再发起一轮长 run，点击停止，验证状态变 interrupted。
9. 停止后新 run 可正常启动。

## 12. 验收标准

- `POST /agent/run` 不再阻塞到 run 完成，而是立即返回 run。
- 前端能实时显示 assistant 增量文本。
- 运行中输入补充指令不会被禁用，且会进入下一轮 LLM messages。
- 停止按钮能使 active run 进入 interrupted。
- 中断后不会继续执行后续 LLM turn。
- 非 streaming provider 不崩，退化为一次性 delta。
- 旧事件兼容，现有 Facts/Tasks/Timeline/Observer 链路不回退。
- 没有新增漏洞领域硬编码。

## 13. 后续扩展

- 硬转向：steering 时 abort 当前 LLM call 并重开。
- Anthropic 真 streaming。
- 工具 execute 接收 AbortSignal，命令/MCP 工具可被真正取消。
- Run 持久化与崩溃恢复。
- 动态 MAX_TURNS。
- 工具并行调用。
- Observer 实时守护。
