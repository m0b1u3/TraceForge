# 扩展地基 Plan A：ToolRegistry + 原生 tool-calling AgentRuntime 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans（本计划在当前会话由控制者直接执行，TDD 节奏）。Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地扩展地基的核心闭环：统一 `ToolRegistry` + 扩展 `LlmProvider` 支持原生 tool-calling + `AgentRuntime`（LLM 自主多轮调工具）+ `ApprovalGate`（只拦系统命令）+ 把现有 http_replay 包装成内置工具走通闭环 + `propose_scope_expansion` 工具。对应设计文档 docs/superpowers/specs/2026-06-24-extension-layer-design.md 的 Plan A。

**Architecture:** 新增 `@traceforge/extension` 包，含 `ToolDescriptor`/`ToolRegistry`/`ApprovalGate` 三个纯逻辑单元（可单测）。`@traceforge/llm` 的 `LlmProvider` 接口加一个多轮 tool-calling 方法 `runTools`，Anthropic/OpenAI 各自用原生 tools 参数实现（不被单测覆盖，只需 tsc 通过 + 端到端）。`AgentRuntime` 编排 loop：把 registry 的工具喂 provider、对每个 tool_use 经两道门后 execute、结果回喂——loop 用 MockProvider 注入预设 tool-calling 序列来单测。内置工具适配器把 http_replay（阶段 5 的 tools 包）和 propose_scope_expansion 注册进 registry。

**Tech Stack:** 沿用前序（TypeScript、pnpm、Vitest、zod、@anthropic-ai/sdk、openai、Node fetch）。

## Global Constraints

- 沿用全部既有约束：Node ≥ 22、pnpm、ESM、`strict: true`、Vitest、`@traceforge/shared` 单源类型、纯逻辑模块必须单测。
- **零硬编码（设计文档 3.0）**：`ToolDescriptor.source` 是开放字符串；不写死任何漏洞知识；工具描述/能力来自适配器，核心代码漏洞无关。
- **LLM 原生 tool-calling**：用各 provider SDK 原生 `tools` 参数（Anthropic `messages.create` 的 tools、OpenAI `chat.completions` 的 tools），**不自创 JSON 协议让 LLM 模仿**。
- **LLM 自主编排**：AgentRuntime 的 loop 不写"先 A 后 B"编排逻辑，LLM 每轮自己决定调什么/并行几个。代码只负责"执行它要的、把结果还给它"。
- **两道独立的门**：
  - ApprovalGate 只拦 `risk === "command"`（执行系统命令）→ 人工确认；其它（含 http_replay）直接执行。
  - Scope Guard（`checkScope`）守发包目标范围——发包类工具 execute 前校验，越界拒绝；**不限制 LLM 思考**。
- `ToolDescriptor.risk` 只两档：`"command" | "normal"`。
- 真实 provider 的 tool-calling 实现不被单测覆盖（不发网络）；loop 编排用 MockProvider 单测；真实路径只需 tsc + 端到端手测。
- 提交信息结尾附：`Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`。

---

### Task 1: extension 包 —— ToolDescriptor + ToolRegistry

**Files:**
- Create: `packages/extension/package.json`
- Create: `packages/extension/tsconfig.json`
- Create: `packages/extension/src/tool.ts`
- Create: `packages/extension/src/registry.ts`
- Create: `packages/extension/src/index.ts`
- Test: `packages/extension/src/registry.test.ts`

**Interfaces:**
- Consumes: 无内部依赖。
- Produces：
  - `interface ToolResult { ok: boolean; content: string; meta?: Record<string, unknown> }`
  - `interface ToolDescriptor { name: string; description: string; inputSchema: Record<string, unknown>; risk: "command" | "normal"; source: string; execute: (input: unknown) => Promise<ToolResult> }`
  - `interface NativeToolDef { name: string; description: string; input_schema: Record<string, unknown> }`
  - `class ToolRegistry`：`register(t)`（重名抛错）、`unregister(name)`、`get(name)`、`list()`、`toLlmTools(): NativeToolDef[]`。

- [ ] **Step 1: 写 `packages/extension/package.json`**

```json
{
  "name": "@traceforge/extension",
  "version": "0.1.0",
  "type": "module",
  "main": "./src/index.ts",
  "exports": { ".": "./src/index.ts" },
  "scripts": { "build": "tsc -p tsconfig.json" },
  "dependencies": {
    "@traceforge/shared": "workspace:*",
    "@traceforge/tool-resolver": "workspace:*"
  }
}
```

- [ ] **Step 2: 写 `packages/extension/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src" },
  "include": ["src"]
}
```

- [ ] **Step 3: 写 `packages/extension/src/tool.ts`**

```ts
export interface ToolResult {
  ok: boolean;
  content: string;
  meta?: Record<string, unknown>;
}

export interface ToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  risk: "command" | "normal";
  source: string;
  execute: (input: unknown) => Promise<ToolResult>;
}

export interface NativeToolDef {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}
```

- [ ] **Step 4: 写失败测试 `packages/extension/src/registry.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { ToolRegistry } from "./registry.js";
import type { ToolDescriptor } from "./tool.js";

function tool(name: string, risk: "command" | "normal" = "normal"): ToolDescriptor {
  return {
    name, description: `does ${name}`, inputSchema: { type: "object", properties: {} },
    risk, source: "builtin", execute: async () => ({ ok: true, content: "done" }),
  };
}

describe("ToolRegistry", () => {
  it("registers and retrieves a tool", () => {
    const r = new ToolRegistry();
    r.register(tool("http_replay"));
    expect(r.get("http_replay")?.name).toBe("http_replay");
    expect(r.list()).toHaveLength(1);
  });

  it("throws on duplicate name (no silent override)", () => {
    const r = new ToolRegistry();
    r.register(tool("x"));
    expect(() => r.register(tool("x"))).toThrow();
  });

  it("unregisters a tool (for MCP disconnect)", () => {
    const r = new ToolRegistry();
    r.register(tool("mcp__s__q"));
    r.unregister("mcp__s__q");
    expect(r.get("mcp__s__q")).toBeUndefined();
  });

  it("converts to native LLM tools (name/description/input_schema only)", () => {
    const r = new ToolRegistry();
    r.register(tool("http_replay"));
    const native = r.toLlmTools();
    expect(native).toEqual([
      { name: "http_replay", description: "does http_replay", input_schema: { type: "object", properties: {} } },
    ]);
  });
});
```

- [ ] **Step 5: 运行确认失败**

Run: `pnpm install && pnpm vitest run packages/extension`
Expected: FAIL —— registry 模块不存在。

- [ ] **Step 6: 写 `packages/extension/src/registry.ts`**

```ts
import type { ToolDescriptor, NativeToolDef } from "./tool.js";

export class ToolRegistry {
  private tools = new Map<string, ToolDescriptor>();

  register(t: ToolDescriptor): void {
    if (this.tools.has(t.name)) throw new Error(`tool already registered: ${t.name}`);
    this.tools.set(t.name, t);
  }

  unregister(name: string): void {
    this.tools.delete(name);
  }

  get(name: string): ToolDescriptor | undefined {
    return this.tools.get(name);
  }

  list(): ToolDescriptor[] {
    return [...this.tools.values()];
  }

  toLlmTools(): NativeToolDef[] {
    return this.list().map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema,
    }));
  }
}
```

- [ ] **Step 7: 写 `packages/extension/src/index.ts`**

```ts
export type { ToolResult, ToolDescriptor, NativeToolDef } from "./tool.js";
export { ToolRegistry } from "./registry.js";
```

- [ ] **Step 8: 运行确认通过 + tsc**

Run: `pnpm vitest run packages/extension && pnpm --filter @traceforge/extension exec tsc --noEmit -p tsconfig.json`
Expected: 4 用例全绿；tsc 退出码 0。

- [ ] **Step 9: Commit**

```bash
git add -A && git commit -m "feat(extension): add ToolDescriptor and ToolRegistry

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: extension 包 —— ApprovalGate（只拦系统命令）

**Files:**
- Create: `packages/extension/src/approval-gate.ts`
- Modify: `packages/extension/src/index.ts`
- Test: `packages/extension/src/approval-gate.test.ts`

**Interfaces:**
- Consumes: `ToolDescriptor`（Task 1）。
- Produces：
  - `type ApprovalDecision = "auto" | "approved" | "rejected"`
  - `type ApprovalAsker = (tool: ToolDescriptor, input: unknown) => Promise<"approved" | "rejected">` —— 注入的"问人工"函数（生产接 WebSocket 确认门，测试注入 mock）。
  - `class ApprovalGate`：构造传入 `ApprovalAsker`；`check(tool, input): Promise<ApprovalDecision>` —— `risk==="command"` 调 asker 返回其结果；否则返回 `"auto"`。

- [ ] **Step 1: 写失败测试 `packages/extension/src/approval-gate.test.ts`**

```ts
import { describe, it, expect, vi } from "vitest";
import { ApprovalGate } from "./approval-gate.js";
import type { ToolDescriptor } from "./tool.js";

function tool(risk: "command" | "normal"): ToolDescriptor {
  return { name: "t", description: "d", inputSchema: {}, risk, source: "builtin", execute: async () => ({ ok: true, content: "" }) };
}

describe("ApprovalGate", () => {
  it("auto-approves normal-risk tools without asking", async () => {
    const asker = vi.fn();
    const gate = new ApprovalGate(asker);
    expect(await gate.check(tool("normal"), {})).toBe("auto");
    expect(asker).not.toHaveBeenCalled();
  });

  it("asks the human for command-risk tools", async () => {
    const asker = vi.fn().mockResolvedValue("approved");
    const gate = new ApprovalGate(asker);
    expect(await gate.check(tool("command"), {})).toBe("approved");
    expect(asker).toHaveBeenCalledOnce();
  });

  it("relays a rejection for command-risk tools", async () => {
    const gate = new ApprovalGate(async () => "rejected");
    expect(await gate.check(tool("command"), {})).toBe("rejected");
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run packages/extension/src/approval-gate.test.ts`
Expected: FAIL —— approval-gate 模块不存在。

- [ ] **Step 3: 写 `packages/extension/src/approval-gate.ts`**

```ts
import type { ToolDescriptor } from "./tool.js";

export type ApprovalDecision = "auto" | "approved" | "rejected";
export type ApprovalAsker = (tool: ToolDescriptor, input: unknown) => Promise<"approved" | "rejected">;

export class ApprovalGate {
  constructor(private ask: ApprovalAsker) {}

  async check(tool: ToolDescriptor, input: unknown): Promise<ApprovalDecision> {
    if (tool.risk === "command") {
      return this.ask(tool, input);
    }
    return "auto";
  }
}
```

- [ ] **Step 4: 扩展 `packages/extension/src/index.ts`**

```ts
export { ApprovalGate, type ApprovalDecision, type ApprovalAsker } from "./approval-gate.js";
```

- [ ] **Step 5: 运行确认通过**

Run: `pnpm vitest run packages/extension`
Expected: PASS（registry 4 + approval-gate 3）。

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(extension): add ApprovalGate gating only command-risk tools

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: 把 LlmProvider 接口移到 extension 并扩展原生 tool-calling

> **依赖方向（一次定清，不反复）：** tool-calling 相关的全部接口（`LlmProvider`/`ExtractJsonArgs`/`ToolCall`/`TurnMessage`/`RunTurn`/`RunToolsArgs`）定义在 `@traceforge/extension`（与 `NativeToolDef` 同包）。`@traceforge/llm` **import 并实现**它们，并重新导出以保持 llm 对外 API 不变。依赖单向：**llm → extension**，extension 不依赖 llm（避免循环）。AgentRuntime（Task 4）在 extension 内直接用本包的 `LlmProvider` 接口。

**Files:**
- Create: `packages/extension/src/provider.ts`
- Modify: `packages/extension/src/index.ts`
- Modify: `packages/llm/package.json`（加 `@traceforge/extension` 依赖）
- Modify: `packages/llm/src/provider.ts`（改为重新导出 extension 接口）
- Modify: `packages/llm/src/mock-provider.ts`
- Modify: `packages/llm/src/anthropic-provider.ts`
- Modify: `packages/llm/src/openai-provider.ts`
- Test: `packages/llm/src/mock-provider.test.ts`（追加 runTools 用例）

**Interfaces:**
- Consumes: `NativeToolDef`（`@traceforge/extension`，Task 1）。
- Produces（定义在 extension）：
  - `interface ToolCall { id: string; name: string; input: unknown }`
  - `interface TurnMessage { role: "user" | "assistant" | "tool"; content: string; toolCallId?: string; toolCalls?: ToolCall[] }`
  - `interface RunTurn { text: string; toolCalls: ToolCall[]; done: boolean }` —— done=true 表示 LLM 结束（无更多工具调用）。
  - `interface RunToolsArgs { system: string; messages: TurnMessage[]; tools: NativeToolDef[] }`
  - `LlmProvider.runTools(args: RunToolsArgs): Promise<RunTurn>` —— 单轮：喂消息+工具，返回 LLM 这一轮的文本与 tool_calls。多轮 loop 由 AgentRuntime 驱动（Task 4）。
  - `MockProvider`（在 llm 包）增加 `runTools`：构造可传第二参 `turns: RunTurn[]`，每次 `runTools` 按序返回下一个预设 turn。

- [ ] **Step 1: 写 `packages/extension/src/provider.ts`**

```ts
import type { NativeToolDef } from "./tool.js";

export interface ExtractJsonArgs {
  system: string;
  user: string;
  schema: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}

export interface TurnMessage {
  role: "user" | "assistant" | "tool";
  content: string;
  toolCallId?: string;
  toolCalls?: ToolCall[];
}

export interface RunTurn {
  text: string;
  toolCalls: ToolCall[];
  done: boolean;
}

export interface RunToolsArgs {
  system: string;
  messages: TurnMessage[];
  tools: NativeToolDef[];
}

export interface LlmProvider {
  extractJson(args: ExtractJsonArgs): Promise<unknown>;
  runTools(args: RunToolsArgs): Promise<RunTurn>;
}
```

- [ ] **Step 1b: extension 导出接口 + llm 加依赖并重导出**

`packages/extension/src/index.ts` 追加：

```ts
export type { LlmProvider, ExtractJsonArgs, ToolCall, TurnMessage, RunTurn, RunToolsArgs } from "./provider.js";
```

给 `packages/llm/package.json` dependencies 加 `"@traceforge/extension": "workspace:*"`，然后 `pnpm install`。

`packages/llm/src/provider.ts` 改为（删除原 ExtractJsonArgs/LlmProvider 本地定义，改重新导出，保持 llm 对外 API 不变）：

```ts
export type {
  LlmProvider, ExtractJsonArgs, ToolCall, TurnMessage, RunTurn, RunToolsArgs,
} from "@traceforge/extension";
```

- [ ] **Step 3: 写失败测试（追加到 `packages/llm/src/mock-provider.test.ts`）**

```ts
import type { RunTurn } from "./provider.js";

describe("MockProvider runTools", () => {
  it("returns preset turns in order", async () => {
    const turns: RunTurn[] = [
      { text: "calling tool", toolCalls: [{ id: "c1", name: "http_replay", input: { url: "x" } }], done: false },
      { text: "done", toolCalls: [], done: true },
    ];
    const mock = new MockProvider({}, turns);
    const t1 = await mock.runTools({ system: "s", messages: [], tools: [] });
    expect(t1.toolCalls[0].name).toBe("http_replay");
    expect(t1.done).toBe(false);
    const t2 = await mock.runTools({ system: "s", messages: [], tools: [] });
    expect(t2.done).toBe(true);
  });

  it("defaults to a done turn when no turns configured", async () => {
    const mock = new MockProvider({});
    const t = await mock.runTools({ system: "s", messages: [], tools: [] });
    expect(t.done).toBe(true);
    expect(t.toolCalls).toEqual([]);
  });
});
```

- [ ] **Step 4: 运行确认失败**

Run: `pnpm vitest run packages/llm/src/mock-provider.test.ts`
Expected: FAIL —— MockProvider 无 runTools / 构造不接受第二参。

- [ ] **Step 5: 改 `packages/llm/src/mock-provider.ts`**

```ts
import type { LlmProvider, ExtractJsonArgs, RunToolsArgs, RunTurn } from "./provider.js";

type MockResult = unknown | ((args: ExtractJsonArgs) => unknown);

export class MockProvider implements LlmProvider {
  private turnIdx = 0;
  constructor(private result: MockResult, private turns: RunTurn[] = []) {}

  async extractJson(args: ExtractJsonArgs): Promise<unknown> {
    return typeof this.result === "function"
      ? (this.result as (a: ExtractJsonArgs) => unknown)(args)
      : this.result;
  }

  async runTools(_args: RunToolsArgs): Promise<RunTurn> {
    const turn = this.turns[this.turnIdx];
    this.turnIdx += 1;
    return turn ?? { text: "", toolCalls: [], done: true };
  }
}
```

- [ ] **Step 6: 运行确认通过**

Run: `pnpm vitest run packages/llm/src/mock-provider.test.ts`
Expected: PASS（原 2 + runTools 2）。

- [ ] **Step 7: 给真实 provider 加 runTools（只需 tsc 通过，不单测）**

`packages/llm/src/anthropic-provider.ts` 追加方法到 `AnthropicProvider` 类内：

```ts
  async runTools(args: import("./provider.js").RunToolsArgs): Promise<import("./provider.js").RunTurn> {
    const anthropicMessages = args.messages.map((m) => {
      if (m.role === "tool") {
        return { role: "user" as const, content: [{ type: "tool_result", tool_use_id: m.toolCallId, content: m.content }] };
      }
      if (m.role === "assistant" && m.toolCalls?.length) {
        return {
          role: "assistant" as const,
          content: [
            ...(m.content ? [{ type: "text", text: m.content }] : []),
            ...m.toolCalls.map((tc) => ({ type: "tool_use", id: tc.id, name: tc.name, input: tc.input })),
          ],
        };
      }
      return { role: m.role as "user" | "assistant", content: m.content };
    });
    const res = await this.client.messages.create({
      model: this.opts.model,
      max_tokens: 4096,
      thinking: { type: "adaptive" },
      system: args.system,
      tools: args.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema })),
      messages: anthropicMessages,
    } as unknown as import("@anthropic-ai/sdk").default.MessageCreateParamsNonStreaming);
    let text = "";
    const toolCalls: import("./provider.js").ToolCall[] = [];
    for (const block of res.content) {
      if (block.type === "text") text += block.text;
      else if (block.type === "tool_use") toolCalls.push({ id: block.id, name: block.name, input: block.input });
    }
    return { text, toolCalls, done: res.stop_reason !== "tool_use" };
  }
```

`packages/llm/src/openai-provider.ts` 追加方法到 `OpenAICompatibleProvider` 类内：

```ts
  async runTools(args: import("./provider.js").RunToolsArgs): Promise<import("./provider.js").RunTurn> {
    const msgs: Array<Record<string, unknown>> = [{ role: "system", content: args.system }];
    for (const m of args.messages) {
      if (m.role === "tool") {
        msgs.push({ role: "tool", tool_call_id: m.toolCallId, content: m.content });
      } else if (m.role === "assistant" && m.toolCalls?.length) {
        msgs.push({
          role: "assistant", content: m.content || null,
          tool_calls: m.toolCalls.map((tc) => ({ id: tc.id, type: "function", function: { name: tc.name, arguments: JSON.stringify(tc.input) } })),
        });
      } else {
        msgs.push({ role: m.role, content: m.content });
      }
    }
    const res = await this.client.chat.completions.create({
      model: this.opts.model,
      messages: msgs as never,
      tools: args.tools.map((t) => ({ type: "function" as const, function: { name: t.name, description: t.description, parameters: t.input_schema } })),
    });
    const choice = res.choices[0];
    const toolCalls = (choice.message.tool_calls ?? []).map((tc) => ({
      id: tc.id, name: tc.function.name, input: JSON.parse(tc.function.arguments || "{}"),
    }));
    return { text: choice.message.content ?? "", toolCalls, done: choice.finish_reason !== "tool_calls" };
  }
```

> 注：两段都用 `as unknown as` / `as never` 兜底 SDK 类型差异（同阶段 3 做法）。字段名（Anthropic 的 `tools`/`tool_use`/`tool_result`、OpenAI 的 `tools`/`tool_calls`）取自各 SDK 原生 tool-calling 文档。真实路径不单测，只需 tsc。

- [ ] **Step 8: tsc 全 llm 包**

Run: `pnpm --filter @traceforge/llm exec tsc --noEmit -p tsconfig.json`
Expected: 退出码 0（若 SDK 类型报错，按注释用断言兜底后复跑）。

- [ ] **Step 9: Commit**

```bash
git add -A && git commit -m "feat(llm): extend LlmProvider with native tool-calling (runTools)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: extension 包 —— AgentRuntime（LLM 自主多轮 loop）

**Files:**
- Create: `packages/extension/src/agent-runtime.ts`
- Modify: `packages/extension/src/index.ts`
- Modify: `packages/extension/package.json`（加 `@traceforge/llm` 依赖）
- Test: `packages/extension/src/agent-runtime.test.ts`

**Interfaces:**
- Consumes: `LlmProvider`/`RunTurn`/`ToolCall`/`TurnMessage`（`@traceforge/llm`，Task 3）、`ToolRegistry`（Task 1）、`ApprovalGate`（Task 2）。
- Produces：
  - `interface AgentEvent { type: "tool_call" | "tool_result" | "tool_rejected" | "text" | "done"; name?: string; content: string }`
  - `class AgentRuntime`：构造 `(provider, registry, gate)`。
  - `run(system, userGoal, onEvent): Promise<void>`：
    1. messages = [{role:"user", content:userGoal}]。
    2. loop：`turn = provider.runTools({system, messages, tools: registry.toLlmTools()})`。
    3. turn.text → emit text。
    4. 对每个 toolCall：`registry.get(name)` →（未知工具 → emit tool_result「unknown tool」）→ `gate.check` →
       - rejected → emit tool_rejected，tool 结果回喂"用户拒绝执行"。
       - auto/approved → `tool.execute(input)` → emit tool_result，结果回喂。
    5. 把 assistant turn（含 toolCalls）+ 各 tool 结果 append 进 messages。
    6. turn.done → emit done，结束 loop。
  - loop 有最大轮数保护（如 25 轮）防失控。

- [ ] **Step 1: 确认依赖方向（无需改 package.json）**

`LlmProvider` 接口已在 Task 3 定义于 `@traceforge/extension`。**extension 不依赖 llm**——AgentRuntime 只用本包 `./provider.js` 的 `LlmProvider` 接口，测试用本地 `SeqProvider`（实现该接口）注入预设序列，不 import `@traceforge/llm`。依赖单向 llm → extension，无循环。本任务不改 extension 的 package.json 依赖。

- [ ] **Step 2: 写失败测试 `packages/extension/src/agent-runtime.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { AgentRuntime } from "./agent-runtime.js";
import { ToolRegistry } from "./registry.js";
import { ApprovalGate } from "./approval-gate.js";
import type { ToolDescriptor } from "./tool.js";
import type { LlmProvider, RunTurn, RunToolsArgs } from "./provider.js";

class SeqProvider implements LlmProvider {
  private i = 0;
  constructor(private turns: RunTurn[]) {}
  async extractJson() { return {}; }
  async runTools(_a: RunToolsArgs): Promise<RunTurn> { return this.turns[this.i++] ?? { text: "", toolCalls: [], done: true }; }
}

function replayTool(executed: string[]): ToolDescriptor {
  return {
    name: "http_replay", description: "replay", inputSchema: {}, risk: "normal", source: "builtin",
    execute: async (input) => { executed.push(JSON.stringify(input)); return { ok: true, content: "status=200" }; },
  };
}

const autoGate = new ApprovalGate(async () => "approved");

describe("AgentRuntime", () => {
  it("executes a tool the LLM calls, feeds result back, ends on done", async () => {
    const executed: string[] = [];
    const registry = new ToolRegistry();
    registry.register(replayTool(executed));
    const provider = new SeqProvider([
      { text: "I'll replay", toolCalls: [{ id: "c1", name: "http_replay", input: { url: "https://t/x" } }], done: false },
      { text: "all done", toolCalls: [], done: true },
    ]);
    const events: string[] = [];
    await new AgentRuntime(provider, registry, autoGate).run("sys", "test it", (e) => events.push(`${e.type}:${e.content}`));
    expect(executed).toEqual(['{"url":"https://t/x"}']);
    expect(events.some((e) => e.startsWith("tool_result:status=200"))).toBe(true);
    expect(events.some((e) => e.startsWith("done"))).toBe(true);
  });

  it("does not execute a command-risk tool when human rejects", async () => {
    const ran: string[] = [];
    const registry = new ToolRegistry();
    registry.register({
      name: "sqlmap", description: "sqlmap", inputSchema: {}, risk: "command", source: "plugin:sqlmap",
      execute: async () => { ran.push("yes"); return { ok: true, content: "ran" }; },
    });
    const rejectGate = new ApprovalGate(async () => "rejected");
    const provider = new SeqProvider([
      { text: "", toolCalls: [{ id: "c1", name: "sqlmap", input: {} }], done: false },
      { text: "ok skip", toolCalls: [], done: true },
    ]);
    const events: string[] = [];
    await new AgentRuntime(provider, registry, rejectGate).run("sys", "go", (e) => events.push(e.type));
    expect(ran).toEqual([]); // 被拒，没执行
    expect(events).toContain("tool_rejected");
  });

  it("reports unknown tool without crashing", async () => {
    const registry = new ToolRegistry();
    const provider = new SeqProvider([
      { text: "", toolCalls: [{ id: "c1", name: "ghost", input: {} }], done: false },
      { text: "done", toolCalls: [], done: true },
    ]);
    const events: string[] = [];
    await new AgentRuntime(provider, registry, autoGate).run("sys", "go", (e) => events.push(`${e.type}:${e.content}`));
    expect(events.some((e) => e.includes("unknown tool"))).toBe(true);
  });
});
```

- [ ] **Step 3: 运行确认失败**

Run: `pnpm install && pnpm vitest run packages/extension/src/agent-runtime.test.ts`
Expected: FAIL —— agent-runtime 模块不存在。

- [ ] **Step 4: 写 `packages/extension/src/agent-runtime.ts`**

```ts
import type { LlmProvider, TurnMessage, ToolCall } from "./provider.js";
import type { ToolRegistry } from "./registry.js";
import type { ApprovalGate } from "./approval-gate.js";

export interface AgentEvent {
  type: "tool_call" | "tool_result" | "tool_rejected" | "text" | "done";
  name?: string;
  content: string;
}

const MAX_TURNS = 25;

export class AgentRuntime {
  constructor(private provider: LlmProvider, private registry: ToolRegistry, private gate: ApprovalGate) {}

  async run(system: string, userGoal: string, onEvent: (e: AgentEvent) => void): Promise<void> {
    const messages: TurnMessage[] = [{ role: "user", content: userGoal }];

    for (let turnCount = 0; turnCount < MAX_TURNS; turnCount++) {
      const turn = await this.provider.runTools({ system, messages, tools: this.registry.toLlmTools() });
      if (turn.text) onEvent({ type: "text", content: turn.text });

      if (turn.toolCalls.length === 0 || turn.done) {
        onEvent({ type: "done", content: turn.text });
        return;
      }

      // 记录 assistant 这一轮（含 tool_calls）
      messages.push({ role: "assistant", content: turn.text, toolCalls: turn.toolCalls });

      for (const call of turn.toolCalls) {
        const result = await this.runOneTool(call, onEvent);
        messages.push({ role: "tool", content: result, toolCallId: call.id });
      }
    }
    onEvent({ type: "done", content: "max turns reached" });
  }

  private async runOneTool(call: ToolCall, onEvent: (e: AgentEvent) => void): Promise<string> {
    const tool = this.registry.get(call.name);
    if (!tool) {
      const msg = `unknown tool: ${call.name}`;
      onEvent({ type: "tool_result", name: call.name, content: msg });
      return msg;
    }
    onEvent({ type: "tool_call", name: call.name, content: JSON.stringify(call.input) });

    const decision = await this.gate.check(tool, call.input);
    if (decision === "rejected") {
      onEvent({ type: "tool_rejected", name: call.name, content: "human rejected" });
      return "用户拒绝执行此动作。";
    }

    const res = await tool.execute(call.input);
    onEvent({ type: "tool_result", name: call.name, content: res.content });
    return res.content;
  }
}
```

- [ ] **Step 5: 扩展 `packages/extension/src/index.ts`**

```ts
export { AgentRuntime, type AgentEvent } from "./agent-runtime.js";
```

- [ ] **Step 6: 运行确认通过 + tsc**

Run: `pnpm vitest run packages/extension && pnpm --filter @traceforge/extension exec tsc --noEmit -p tsconfig.json`
Expected: registry 4 + approval-gate 3 + agent-runtime 3 全绿；tsc 退出码 0。

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat(extension): add AgentRuntime native tool-calling loop with two gates

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: 内置工具适配器 —— http_replay + propose_scope_expansion

**Files:**
- Create: `packages/extension/src/builtin-tools.ts`
- Modify: `packages/extension/src/index.ts`
- Modify: `packages/extension/package.json`（加 `@traceforge/tools` 依赖）
- Test: `packages/extension/src/builtin-tools.test.ts`

**Interfaces:**
- Consumes: `replay`/`Fetcher`（`@traceforge/tools`，阶段 5）、`checkScope`（`@traceforge/tool-resolver`）、`ScopeRule`（`@traceforge/shared`）、`ToolDescriptor`（Task 1）。
- Produces：
  - `makeHttpReplayTool(scopeRules: ScopeRule[], fetcher?: Fetcher): ToolDescriptor` —— `risk: "normal"`，execute 内先 `checkScope` 越界返回 `{ok:false, content:"out of scope"}`，范围内 `replay` 返回状态摘要。
  - `makeProposeScopeExpansionTool(onPropose: (host: string, reason: string) => void): ToolDescriptor` —— `risk: "normal"`，execute 调 onPropose 记录扩范围建议，返回确认文本。**不发包**，只提议。
  - 注：scopeRules 当前以闭包传入（单 case）；多 case 化在 server 装配时按 case 取。

- [ ] **Step 1: 给 `packages/extension/package.json` dependencies 加** `"@traceforge/tools": "workspace:*"`，`pnpm install`。

- [ ] **Step 2: 写失败测试 `packages/extension/src/builtin-tools.test.ts`**

```ts
import { describe, it, expect, vi } from "vitest";
import { makeHttpReplayTool, makeProposeScopeExpansionTool } from "./builtin-tools.js";
import type { ScopeRule } from "@traceforge/shared";
import type { Fetcher } from "@traceforge/tools";

const rules: ScopeRule[] = [{ caseId: "c", allowHosts: ["t.com"], denyHosts: [] }];
const okFetcher: Fetcher = async () => ({ status: 200, bodyLength: 5, body: "hello", headers: {} });

describe("makeHttpReplayTool", () => {
  it("is normal-risk and replays in-scope requests", async () => {
    const tool = makeHttpReplayTool(rules, okFetcher);
    expect(tool.risk).toBe("normal");
    const res = await tool.execute({ url: "https://t.com/x", method: "GET" });
    expect(res.ok).toBe(true);
    expect(res.content).toContain("200");
  });

  it("refuses out-of-scope targets (scope guard inside execute)", async () => {
    const tool = makeHttpReplayTool(rules, okFetcher);
    const res = await tool.execute({ url: "https://evil.com/x", method: "GET" });
    expect(res.ok).toBe(false);
    expect(res.content).toMatch(/scope/i);
  });
});

describe("makeProposeScopeExpansionTool", () => {
  it("records a proposal without sending any packet", async () => {
    const onPropose = vi.fn();
    const tool = makeProposeScopeExpansionTool(onPropose);
    expect(tool.risk).toBe("normal");
    const res = await tool.execute({ host: "cdn.t.com", reason: "same cert" });
    expect(onPropose).toHaveBeenCalledWith("cdn.t.com", "same cert");
    expect(res.ok).toBe(true);
  });
});
```

- [ ] **Step 3: 运行确认失败**

Run: `pnpm vitest run packages/extension/src/builtin-tools.test.ts`
Expected: FAIL —— 模块不存在。

- [ ] **Step 4: 写 `packages/extension/src/builtin-tools.ts`**

```ts
import { replay, type Fetcher, type ReplayRequest } from "@traceforge/tools";
import { checkScope } from "@traceforge/tool-resolver";
import type { ScopeRule } from "@traceforge/shared";
import type { ToolDescriptor } from "./tool.js";

export function makeHttpReplayTool(scopeRules: ScopeRule[], fetcher?: Fetcher): ToolDescriptor {
  return {
    name: "http_replay",
    description: "重发一个 HTTP 请求（可改 URL/参数/header/body），返回响应状态与长度。用于验证接口行为差异。",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string" }, method: { type: "string" },
        headers: { type: "object" }, body: { type: "string" },
      },
      required: ["url", "method"],
    },
    risk: "normal",
    source: "builtin",
    execute: async (input) => {
      const req = input as ReplayRequest;
      const verdict = checkScope(req.url, scopeRules);
      if (!verdict.allowed) {
        return { ok: false, content: `out of scope: ${verdict.reason}` };
      }
      const res = await replay(req, fetcher);
      return { ok: true, content: `status=${res.status} bodyLength=${res.bodyLength}`, meta: { status: res.status } };
    },
  };
}

export function makeProposeScopeExpansionTool(
  onPropose: (host: string, reason: string) => void,
): ToolDescriptor {
  return {
    name: "propose_scope_expansion",
    description: "当你发现一个疑似与当前目标相关的资产（域名/主机）但它不在授权范围内时，提出将其纳入测试范围的建议。这不会发送任何请求，只是提议，需人工确认。",
    inputSchema: {
      type: "object",
      properties: { host: { type: "string" }, reason: { type: "string" } },
      required: ["host", "reason"],
    },
    risk: "normal",
    source: "builtin",
    execute: async (input) => {
      const { host, reason } = input as { host: string; reason: string };
      onPropose(host, reason);
      return { ok: true, content: `已记录扩范围建议：${host}（${reason}），待人工确认。` };
    },
  };
}
```

- [ ] **Step 5: 扩展 `packages/extension/src/index.ts`**

```ts
export { makeHttpReplayTool, makeProposeScopeExpansionTool } from "./builtin-tools.js";
```

- [ ] **Step 6: 运行确认通过 + 全量 extension 测试 + tsc**

Run: `pnpm vitest run packages/extension && pnpm --filter @traceforge/extension exec tsc --noEmit -p tsconfig.json`
Expected: registry 4 + approval-gate 3 + agent-runtime 3 + builtin-tools 3 全绿；tsc 退出码 0。

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat(extension): add builtin http_replay and propose_scope_expansion tools

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: 阶段收尾 —— 全量校验、依赖图核对、README

**Files:**
- Modify: `README.md`

- [ ] **Step 1: 全量测试**

Run: `pnpm test`
Expected: PASS —— 既有全部 + extension 新增（registry 4 + approval-gate 3 + agent-runtime 3 + builtin-tools 3 + llm runTools 2）全绿。

- [ ] **Step 2: 全量构建（验证无循环依赖）**

Run: `pnpm -r build`
Expected: 各包无错误。**特别确认 `@traceforge/extension` 与 `@traceforge/llm` 构建顺序无循环**（extension 不依赖 llm，llm 依赖 extension，单向）。

- [ ] **Step 3: 更新 `README.md`**

"当前进度"小节追加：

```markdown
- 扩展地基（Plan A）：统一 ToolRegistry + LLM 原生 tool-calling AgentRuntime（LLM 自主多轮调工具）+ 两道门（ApprovalGate 只拦系统命令、Scope Guard 守发包授权边界）+ 内置工具（http_replay、propose_scope_expansion）。MCP / 工具插件 / Skills 在此地基上后续接入
```

把测试数量更新为实际值。

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "docs: update README for extension foundation (Plan A)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## 自检说明（写给计划作者，非执行步骤）

- **Spec 覆盖**：对应扩展层设计 spec 的 Plan A 全部内容——ToolDescriptor/ToolRegistry（Task 1）、ApprovalGate 只拦 command（Task 2）、LlmProvider 原生 tool-calling（Task 3）、AgentRuntime 自主 loop + 两道门（Task 4）、内置工具 http_replay + propose_scope_expansion（Task 5）。Plan B（插件）/C（MCP）/D（Skills）不在本计划。
- **循环依赖处理**：关键修正在 Task 4 Step 1-2——`LlmProvider` 及 tool-calling 类型定义在 `@traceforge/extension`，`@traceforge/llm` import 并实现。依赖单向 llm→extension，extension 不依赖 llm。AgentRuntime 在 extension 内用本包 `LlmProvider` 接口。Task 3 写的 provider.ts 类型，最终归属 extension（Task 4 Step 2 修正）。
- **类型一致性**：`ToolDescriptor`/`ToolResult`/`NativeToolDef`（Task 1）→ Registry/Gate/Runtime/builtin 一致消费。`LlmProvider`/`RunTurn`/`ToolCall`/`TurnMessage`（定义在 extension）→ llm 实现、AgentRuntime 消费，签名一致。`AgentEvent` 在 Task 4 定义。
- **安全约束落点**：(a) ApprovalGate 只拦 `risk==="command"`，由 Task 2 三用例守住；(b) AgentRuntime 对 rejected 不执行，由 Task 4 "rejects sqlmap" 用例守住；(c) Scope Guard 在 http_replay 工具 execute 内，由 Task 5 "out-of-scope" 用例守住；(d) propose_scope_expansion 不发包，由 Task 5 用例守住。
- **LLM 原生 + 自主**：runTools 用各 SDK 原生 tools 参数（Task 3）；AgentRuntime loop 不写编排，只执行 LLM 要的 toolCalls（Task 4），LLM 自主决定调什么。
- **已知简化**：真实 provider 的 runTools 不单测（不发网络），只 tsc + 后续端到端；AgentRuntime 未接 server 路由/WebSocket（Plan A 是库层闭环，server 集成在后续 plan）；scopeRules 以闭包传入单 case（多 case 装配在 server 层）。MAX_TURNS=25 防失控。
