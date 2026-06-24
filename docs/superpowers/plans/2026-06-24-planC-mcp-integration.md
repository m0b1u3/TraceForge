# Plan C：MCP 集成 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans（当前会话直接执行，TDD 节奏）。Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 TraceForge agent 动态发现并调用外部 stdio MCP server 暴露的工具：server 启动时全局连接、缓存工具池，每次 agent run 把 MCP 工具（命名空间 `mcp__<server>__<tool>`、默认 risk=command 过确认门）注册进该 case 的 registry。对应 spec docs/superpowers/specs/2026-06-24-mcp-integration-design.md。

**Architecture:** `@traceforge/extension` 新增 `mcp-config.ts`（Zod 校验的 config 加载）、`mcp-manager.ts`（`McpManager`：连接所有 server + 工具池 + callTool + closeAll，client 创建经可注入 `clientFactory` 以便单测）、`mcp-tools.ts`（`mcpToolToDescriptor`：MCP 工具 → ToolDescriptor）。`apps/server` 在 routes.ts 的 agent run 注册 MCP 工具 + 新增 `GET /api/mcp/tools`，main.ts 接线 `McpManager`。

**Tech Stack:** TypeScript ESM strict、Vitest、Fastify、`@modelcontextprotocol/sdk`（官方 TS SDK，stdio client transport）、Zod、沿用既有 ToolRegistry / ApprovalGate / AgentRuntime。

## Global Constraints

- 沿用全部既有约束：Node ≥ 22、pnpm、ESM、`strict: true`、Vitest、`@traceforge/shared` 单源类型、纯逻辑模块必须单测。
- **零硬编码（设计文档 3.0）**：MCP 工具的 description / inputSchema 全部来自远端 server，TraceForge 不预设任何工具语义。
- **第一版只支持 stdio 传输**（本地子进程）；HTTP/SSE 不做。
- **全局连接**：MCP server 在 TraceForge server 启动时连接，工具池全局共享；每次 agent run 注册进 case registry。
- **命名空间**：MCP 工具注册名为 `mcp__<server>__<tool>`，防与内置工具/别的 server 冲突。
- **风险默认 command**：MCP 工具 `risk = trustLevel`（config 默认 `"command"`，过 ApprovalGate）；可在 config 逐 server 标 `"normal"` 不卡门。`trustLevel` 是闭枚举 `z.enum(["command","normal"])`。
- **降级不崩**：无 config / 单 server 启动失败 / callTool 抛错都不拖垮主体——分别回退空池、跳过+console.error、返回 `{ok:false}`。
- **可单测边界**：config 加载、`mcpToolToDescriptor`、`McpManager`（注入 mock clientFactory，不起真子进程）、路由（inject + 假 McpManager）均单测；真实 stdio server 端到端靠手动。
- `name` 须匹配 `^[a-z0-9_]+$`；`config/mcp.json` gitignored，提交 `config/mcp.example.json`。
- 提交信息结尾附：`Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`。

---

### Task 1: extension —— MCP 配置加载（mcp-config.ts）

**Files:**
- Create: `packages/extension/src/mcp-config.ts`
- Modify: `packages/extension/src/index.ts`
- Test: `packages/extension/src/mcp-config.test.ts`

**Interfaces:**
- Consumes: `zod`（已是 extension 依赖链可用——经 @traceforge/shared 传递；若 extension 无直接 zod 依赖，Step 3 加）。
- Produces：
  - `interface McpServerConfig { name: string; command: string; args: string[]; env?: Record<string, string>; trustLevel: "command" | "normal" }`
  - `function loadMcpConfig(path?: string): McpServerConfig[]` —— 读不到/解析失败/校验失败返回 `[]`；trustLevel 缺省为 `"command"`，args 缺省 `[]`。

- [ ] **Step 1: 确认 extension 有 zod 依赖**

Run: `grep '"zod"' packages/extension/package.json || echo "NO_ZOD"`
若输出 `NO_ZOD`：`cd packages/extension && pnpm add zod` 后回到仓库根。若已有则跳过。

- [ ] **Step 2: 写失败测试 `packages/extension/src/mcp-config.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMcpConfig } from "./mcp-config.js";

function tmpConfig(obj: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "mcpcfg-"));
  const p = join(dir, "mcp.json");
  writeFileSync(p, JSON.stringify(obj));
  return p;
}

describe("loadMcpConfig", () => {
  it("returns [] when file is missing", () => {
    expect(loadMcpConfig(join(tmpdir(), "does-not-exist-xyz.json"))).toEqual([]);
  });

  it("parses a valid server config with defaults", () => {
    const p = tmpConfig({ servers: [{ name: "filesystem", command: "npx", args: ["-y", "srv"] }] });
    const cfg = loadMcpConfig(p);
    expect(cfg).toHaveLength(1);
    expect(cfg[0].name).toBe("filesystem");
    expect(cfg[0].trustLevel).toBe("command"); // 默认
    expect(cfg[0].args).toEqual(["-y", "srv"]);
  });

  it("defaults args to [] when omitted", () => {
    const p = tmpConfig({ servers: [{ name: "s", command: "run" }] });
    expect(loadMcpConfig(p)[0].args).toEqual([]);
  });

  it("accepts trustLevel normal and optional env", () => {
    const p = tmpConfig({ servers: [{ name: "s", command: "run", trustLevel: "normal", env: { K: "v" } }] });
    const c = loadMcpConfig(p)[0];
    expect(c.trustLevel).toBe("normal");
    expect(c.env).toEqual({ K: "v" });
  });

  it("rejects an invalid name (returns [] on schema failure)", () => {
    const p = tmpConfig({ servers: [{ name: "Bad Name!", command: "run" }] });
    expect(loadMcpConfig(p)).toEqual([]);
  });

  it("returns [] on malformed json", () => {
    const dir = mkdtempSync(join(tmpdir(), "mcpcfg-"));
    const p = join(dir, "mcp.json");
    writeFileSync(p, "{ not json");
    expect(loadMcpConfig(p)).toEqual([]);
  });
});
```

- [ ] **Step 3: 运行确认失败**

Run: `pnpm vitest run packages/extension/src/mcp-config.test.ts`
Expected: FAIL —— mcp-config 模块不存在。

- [ ] **Step 4: 写 `packages/extension/src/mcp-config.ts`**

```ts
import { readFileSync } from "node:fs";
import { z } from "zod";

export const McpServerConfigSchema = z.object({
  name: z.string().regex(/^[a-z0-9_]+$/),
  command: z.string(),
  args: z.array(z.string()).default([]),
  env: z.record(z.string()).optional(),
  trustLevel: z.enum(["command", "normal"]).default("command"),
});
export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;

export const McpConfigSchema = z.object({
  servers: z.array(McpServerConfigSchema).default([]),
});

export function loadMcpConfig(path = "config/mcp.json"): McpServerConfig[] {
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = McpConfigSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data.servers : [];
  } catch {
    return [];
  }
}
```

- [ ] **Step 5: 导出 `packages/extension/src/index.ts`**

在文件末尾追加：

```ts
export { loadMcpConfig, McpServerConfigSchema, McpConfigSchema, type McpServerConfig } from "./mcp-config.js";
```

- [ ] **Step 6: 运行确认通过 + tsc**

Run: `pnpm vitest run packages/extension/src/mcp-config.test.ts && pnpm --filter @traceforge/extension exec tsc --noEmit -p tsconfig.json`
Expected: 6 用例全绿；tsc 退出码 0。

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat(extension): add MCP server config loader

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: extension —— MCP 工具适配（mcp-tools.ts）

**Files:**
- Create: `packages/extension/src/mcp-tools.ts`
- Modify: `packages/extension/src/index.ts`
- Test: `packages/extension/src/mcp-tools.test.ts`

**Interfaces:**
- Consumes: `ToolDescriptor`（`./tool.js`）。
- Produces：
  - `interface McpToolHandle { serverName: string; toolName: string; description: string; inputSchema: Record<string, unknown>; trustLevel: "command" | "normal" }`
  - `interface McpCaller { callTool(serverName: string, toolName: string, input: unknown): Promise<{ ok: boolean; content: string }> }`（结构接口——Task 3 的 McpManager 满足它，使本任务不依赖 McpManager 类）
  - `function mcpToolToDescriptor(h: McpToolHandle, caller: McpCaller): ToolDescriptor` —— name=`mcp__${serverName}__${toolName}`、risk=trustLevel、source=`mcp:${serverName}`、execute 转 `caller.callTool`。

- [ ] **Step 1: 写失败测试 `packages/extension/src/mcp-tools.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { mcpToolToDescriptor, type McpToolHandle, type McpCaller } from "./mcp-tools.js";

const handle: McpToolHandle = {
  serverName: "filesystem",
  toolName: "read_file",
  description: "Read a file",
  inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  trustLevel: "command",
};

function caller(): McpCaller & { calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    callTool: async (s, t, input) => { calls.push([s, t, input]); return { ok: true, content: `ran ${s}/${t}` }; },
  };
}

describe("mcpToolToDescriptor", () => {
  it("namespaces the tool name", () => {
    const d = mcpToolToDescriptor(handle, caller());
    expect(d.name).toBe("mcp__filesystem__read_file");
  });

  it("carries description, schema, and source", () => {
    const d = mcpToolToDescriptor(handle, caller());
    expect(d.description).toBe("Read a file");
    expect(d.inputSchema).toEqual(handle.inputSchema);
    expect(d.source).toBe("mcp:filesystem");
  });

  it("risk follows trustLevel (command default)", () => {
    expect(mcpToolToDescriptor(handle, caller()).risk).toBe("command");
    expect(mcpToolToDescriptor({ ...handle, trustLevel: "normal" }, caller()).risk).toBe("normal");
  });

  it("execute forwards to caller.callTool with original tool name", async () => {
    const c = caller();
    const d = mcpToolToDescriptor(handle, c);
    const res = await d.execute({ path: "/etc/hosts" });
    expect(res).toEqual({ ok: true, content: "ran filesystem/read_file" });
    expect(c.calls).toEqual([["filesystem", "read_file", { path: "/etc/hosts" }]]);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run packages/extension/src/mcp-tools.test.ts`
Expected: FAIL —— mcp-tools 模块不存在。

- [ ] **Step 3: 写 `packages/extension/src/mcp-tools.ts`**

```ts
import type { ToolDescriptor } from "./tool.js";

export interface McpToolHandle {
  serverName: string;
  toolName: string;
  description: string;
  inputSchema: Record<string, unknown>;
  trustLevel: "command" | "normal";
}

export interface McpCaller {
  callTool(serverName: string, toolName: string, input: unknown): Promise<{ ok: boolean; content: string }>;
}

export function mcpToolToDescriptor(h: McpToolHandle, caller: McpCaller): ToolDescriptor {
  return {
    name: `mcp__${h.serverName}__${h.toolName}`,
    description: h.description,
    inputSchema: h.inputSchema,
    risk: h.trustLevel,
    source: `mcp:${h.serverName}`,
    execute: (input) => caller.callTool(h.serverName, h.toolName, input),
  };
}
```

- [ ] **Step 4: 导出 `packages/extension/src/index.ts`**

在文件末尾追加：

```ts
export { mcpToolToDescriptor, type McpToolHandle, type McpCaller } from "./mcp-tools.js";
```

- [ ] **Step 5: 运行确认通过 + tsc**

Run: `pnpm vitest run packages/extension/src/mcp-tools.test.ts && pnpm --filter @traceforge/extension exec tsc --noEmit -p tsconfig.json`
Expected: 4 用例全绿；tsc 退出码 0。

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(extension): add MCP tool-to-descriptor adapter

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: extension —— McpManager（连接、工具池、callTool，可注入 clientFactory）

**Files:**
- Create: `packages/extension/src/mcp-manager.ts`
- Modify: `packages/extension/src/index.ts`, `packages/extension/package.json`
- Test: `packages/extension/src/mcp-manager.test.ts`

**Interfaces:**
- Consumes: `McpServerConfig`（Task 1）、`McpToolHandle`/`McpCaller`（Task 2）、`@modelcontextprotocol/sdk`。
- Produces：
  - `interface McpClient { listTools(): Promise<{ tools: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }> }>; callTool(args: { name: string; arguments: unknown }): Promise<{ content?: Array<{ type: string; text?: string }>; isError?: boolean }>; close(): Promise<void> }`（结构接口——SDK Client 满足它，也便于 mock）
  - `type McpClientFactory = (cfg: McpServerConfig) => Promise<McpClient>`
  - `class McpManager implements McpCaller`：
    - 构造 `(clientFactory?: McpClientFactory)`（缺省用真实 SDK stdio client）
    - `async connectAll(configs: McpServerConfig[]): Promise<void>` —— 逐个连接，单个失败 try/catch + console.error 跳过；成功则 listTools 缓存为 McpToolHandle（trustLevel 取 config）
    - `listTools(): McpToolHandle[]`
    - `async callTool(serverName, toolName, input): Promise<{ ok: boolean; content: string }>` —— 找 client → callTool → 拼 content 文本；找不到 client / 抛错 → `{ok:false}`
    - `async closeAll(): Promise<void>`

- [ ] **Step 1: 加 `@modelcontextprotocol/sdk` 依赖**

Run: `cd packages/extension && pnpm add @modelcontextprotocol/sdk@^1.29.0` 然后回仓库根 `cd ../..`
Expected: package.json 出现该依赖，pnpm 安装成功。

- [ ] **Step 2: 写失败测试 `packages/extension/src/mcp-manager.test.ts`（注入 mock client，不起真子进程）**

```ts
import { describe, it, expect, vi } from "vitest";
import { McpManager, type McpClient, type McpClientFactory } from "./mcp-manager.js";
import type { McpServerConfig } from "./mcp-config.js";

function fakeClient(tools: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>): McpClient {
  return {
    listTools: async () => ({ tools }),
    callTool: async (args) => ({ content: [{ type: "text", text: `called ${args.name}` }] }),
    close: async () => {},
  };
}

const cfg = (over: Partial<McpServerConfig> = {}): McpServerConfig => ({
  name: "fs", command: "x", args: [], trustLevel: "command", ...over,
});

describe("McpManager", () => {
  it("connects and caches tools as handles with trustLevel from config", async () => {
    const factory: McpClientFactory = async () => fakeClient([
      { name: "read_file", description: "rf", inputSchema: { type: "object" } },
    ]);
    const m = new McpManager(factory);
    await m.connectAll([cfg()]);
    const handles = m.listTools();
    expect(handles).toHaveLength(1);
    expect(handles[0]).toMatchObject({ serverName: "fs", toolName: "read_file", description: "rf", trustLevel: "command" });
  });

  it("isolates a server whose connection fails (others still load)", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const factory: McpClientFactory = async (c) => {
      if (c.name === "bad") throw new Error("spawn failed");
      return fakeClient([{ name: "ok_tool" }]);
    };
    const m = new McpManager(factory);
    await m.connectAll([cfg({ name: "bad" }), cfg({ name: "good" })]);
    expect(m.listTools().map((h) => h.serverName)).toEqual(["good"]);
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("callTool forwards to the right client and returns text content", async () => {
    const factory: McpClientFactory = async () => fakeClient([{ name: "read_file" }]);
    const m = new McpManager(factory);
    await m.connectAll([cfg()]);
    const res = await m.callTool("fs", "read_file", { path: "/x" });
    expect(res).toEqual({ ok: true, content: "called read_file" });
  });

  it("callTool returns ok:false for an unknown server", async () => {
    const m = new McpManager(async () => fakeClient([]));
    const res = await m.callTool("nope", "t", {});
    expect(res.ok).toBe(false);
  });

  it("callTool returns ok:false when the client throws", async () => {
    const factory: McpClientFactory = async () => ({
      listTools: async () => ({ tools: [{ name: "boom" }] }),
      callTool: async () => { throw new Error("remote crash"); },
      close: async () => {},
    });
    const m = new McpManager(factory);
    await m.connectAll([cfg()]);
    const res = await m.callTool("fs", "boom", {});
    expect(res.ok).toBe(false);
    expect(res.content).toMatch(/remote crash/);
  });

  it("closeAll closes every client", async () => {
    const closed: string[] = [];
    const factory: McpClientFactory = async (c) => ({
      listTools: async () => ({ tools: [{ name: "t" }] }),
      callTool: async () => ({ content: [] }),
      close: async () => { closed.push(c.name); },
    });
    const m = new McpManager(factory);
    await m.connectAll([cfg({ name: "a" }), cfg({ name: "b" })]);
    await m.closeAll();
    expect(closed.sort()).toEqual(["a", "b"]);
  });
});
```

- [ ] **Step 3: 运行确认失败**

Run: `pnpm vitest run packages/extension/src/mcp-manager.test.ts`
Expected: FAIL —— mcp-manager 模块不存在。

- [ ] **Step 4: 写 `packages/extension/src/mcp-manager.ts`**

```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { McpServerConfig } from "./mcp-config.js";
import type { McpToolHandle, McpCaller } from "./mcp-tools.js";

export interface McpClient {
  listTools(): Promise<{ tools: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }> }>;
  callTool(args: { name: string; arguments: unknown }): Promise<{ content?: Array<{ type: string; text?: string }>; isError?: boolean }>;
  close(): Promise<void>;
}

export type McpClientFactory = (cfg: McpServerConfig) => Promise<McpClient>;

// 默认工厂：用真实 SDK 起 stdio 子进程并握手
const defaultFactory: McpClientFactory = async (cfg) => {
  const transport = new StdioClientTransport({
    command: cfg.command,
    args: cfg.args,
    env: cfg.env,
  });
  const client = new Client({ name: "traceforge", version: "0.1.0" }, { capabilities: {} });
  await client.connect(transport);
  return client as unknown as McpClient;
};

export class McpManager implements McpCaller {
  private clients = new Map<string, McpClient>();
  private handles: McpToolHandle[] = [];

  constructor(private factory: McpClientFactory = defaultFactory) {}

  async connectAll(configs: McpServerConfig[]): Promise<void> {
    for (const cfg of configs) {
      try {
        const client = await this.factory(cfg);
        const { tools } = await client.listTools();
        this.clients.set(cfg.name, client);
        for (const t of tools) {
          this.handles.push({
            serverName: cfg.name,
            toolName: t.name,
            description: t.description ?? "",
            inputSchema: t.inputSchema ?? { type: "object" },
            trustLevel: cfg.trustLevel,
          });
        }
      } catch (err) {
        console.error(`[mcp] server "${cfg.name}" failed to connect: ${(err as Error).message}`);
      }
    }
  }

  listTools(): McpToolHandle[] {
    return [...this.handles];
  }

  async callTool(serverName: string, toolName: string, input: unknown): Promise<{ ok: boolean; content: string }> {
    const client = this.clients.get(serverName);
    if (!client) return { ok: false, content: `unknown mcp server: ${serverName}` };
    try {
      const res = await client.callTool({ name: toolName, arguments: input });
      const text = (res.content ?? [])
        .map((c) => (c.type === "text" ? c.text ?? "" : `[${c.type}]`))
        .join("\n");
      return { ok: !res.isError, content: text };
    } catch (err) {
      return { ok: false, content: `mcp call failed: ${(err as Error).message}` };
    }
  }

  async closeAll(): Promise<void> {
    for (const client of this.clients.values()) {
      await client.close().catch(() => {});
    }
    this.clients.clear();
    this.handles = [];
  }
}
```

- [ ] **Step 5: 导出 `packages/extension/src/index.ts`**

在文件末尾追加：

```ts
export { McpManager, type McpClient, type McpClientFactory } from "./mcp-manager.js";
```

- [ ] **Step 6: 运行确认通过 + 全 extension 测试 + tsc**

Run: `pnpm vitest run packages/extension && pnpm --filter @traceforge/extension exec tsc --noEmit -p tsconfig.json`
Expected: mcp-manager 6 用例 + 既有 extension 测试全绿；tsc 退出码 0。

> 若 tsc 报 SDK Client 类型与 `McpClient` 不兼容：`defaultFactory` 已用 `client as unknown as McpClient` 桥接（SDK 的 `callTool`/`listTools` 返回类型比我们的结构接口宽，断言安全）。若报 SDK 子路径导入找不到类型：确认 `@modelcontextprotocol/sdk` 已装且其 package.json exports 含 `./client/index.js`、`./client/stdio.js`（1.x 均有）。

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat(extension): add McpManager with injectable client factory

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: server —— 路由集成 + main.ts 接线

**Files:**
- Modify: `apps/server/src/routes.ts`, `apps/server/src/main.ts`
- Test: `apps/server/src/routes-mcp.test.ts`

**Interfaces:**
- Consumes: `McpManager`/`mcpToolToDescriptor`（extension）、`loadMcpConfig`（extension）、现有 `registerRoutes` 装配、`MockProvider`（llm）。
- Produces：
  - `registerRoutes(app, db, bus, provider?, mcp?: McpManager)` —— 新增第 5 可选参 `mcp`。
  - agent run 路由：若 `mcp`，`for (const h of mcp.listTools()) registry.register(mcpToolToDescriptor(h, mcp))`（在 browser tools 注册之后）。
  - `GET /api/mcp/tools` → 返回 `mcp ? mcp.listTools() : []`。
  - main.ts：`new McpManager()` + `connectAll(loadMcpConfig())` + 传入 registerRoutes 第 5 参 + `app.addHook("onClose", ...closeAll)`。

- [ ] **Step 1: 写失败测试 `apps/server/src/routes-mcp.test.ts`（注入假 McpManager，不起真子进程）**

```ts
import { describe, it, expect, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { createDb } from "./db/client.js";
import { EventBus } from "./event-bus.js";
import { registerRoutes } from "./routes.js";
import { McpManager, type McpClientFactory } from "@traceforge/extension";
import { MockProvider } from "@traceforge/llm";

let app: FastifyInstance;
let caseId: string;

// 一个连了假 client、暴露一个 normal 工具的 McpManager（normal 免确认门，便于 agent 直接调用）
async function fakeMcp(): Promise<McpManager> {
  const factory: McpClientFactory = async () => ({
    listTools: async () => ({ tools: [{ name: "read_file", description: "rf", inputSchema: { type: "object" } }] }),
    callTool: async () => ({ content: [{ type: "text", text: "file contents" }] }),
    close: async () => {},
  });
  const m = new McpManager(factory);
  await m.connectAll([{ name: "fs", command: "x", args: [], trustLevel: "normal" }]);
  return m;
}

beforeEach(async () => {
  app = Fastify();
  const db = createDb(":memory:");
  const bus = new EventBus();
  const provider = new MockProvider({}, [
    { text: "读文件", toolCalls: [{ id: "c1", name: "mcp__fs__read_file", input: { path: "/x" } }], done: false },
    { text: "完成", toolCalls: [], done: true },
  ]);
  registerRoutes(app, db, bus, provider, await fakeMcp());
  await app.ready();
  caseId = (await app.inject({ method: "POST", url: "/api/cases", payload: { name: "d", allowHosts: ["t.com"] } })).json().id;
});

describe("mcp routes", () => {
  it("GET /api/mcp/tools lists the namespaced tools", async () => {
    const res = await app.inject({ url: "/api/mcp/tools" });
    expect(res.statusCode).toBe(200);
    const tools = res.json();
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({ serverName: "fs", toolName: "read_file" });
  });

  it("agent run can call an mcp tool (registered into the case registry)", async () => {
    const res = await app.inject({ method: "POST", url: `/api/cases/${caseId}/agent/run`, payload: { goal: "读文件" } });
    expect(res.statusCode).toBe(200);
  });
});
```

> 说明：第二个用例的成功（200）即证明 `mcp__fs__read_file` 被注册进了 registry——否则 AgentRuntime 调一个未注册工具会让 run 报错（非 200）。MockProvider 第一轮就调该 MCP 工具，第二轮 done。

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run apps/server/src/routes-mcp.test.ts`
Expected: FAIL —— `/api/mcp/tools` 不存在（404）；且 registerRoutes 不接受第 5 参（tsc/运行错）。

- [ ] **Step 3: 修改 `apps/server/src/routes.ts`**

顶部 import 区，把 extension 的 import 块追加 `McpManager`/`mcpToolToDescriptor`：

```ts
import {
  ToolRegistry, ApprovalGate, AgentRuntime,
  makeListTrafficTool, makeGetTrafficTool,
  makeRecordFactTool, makeRecordTaskTool, makeRecordActionTool,
  makeHttpReplayTool, makeProposeScopeExpansionTool, makeBrowserTools,
  McpManager, mcpToolToDescriptor,
} from "@traceforge/extension";
```

把 `registerRoutes` 签名加第 5 参：

```ts
export function registerRoutes(
  app: FastifyInstance,
  db: Db,
  bus: EventBus,
  provider?: LlmProvider,
  mcp?: McpManager,
): void {
```

在 agent run 路由的浏览器工具注册块之后（`for (const t of makeBrowserTools(...)) registry.register(t);` 的 `}` 之后）追加：

```ts
    if (mcp) {
      for (const h of mcp.listTools()) registry.register(mcpToolToDescriptor(h, mcp));
    }
```

在 `GET /api/cases/:id/decisions` 路由之后（或任意顶层路由区）追加：

```ts
  app.get("/api/mcp/tools", async () => (mcp ? mcp.listTools() : []));
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm vitest run apps/server/src/routes-mcp.test.ts`
Expected: PASS（2 用例）。

- [ ] **Step 5: 修改 `apps/server/src/main.ts` 接线**

把 import 加上 extension 的两个符号：

```ts
import { McpManager, loadMcpConfig } from "@traceforge/extension";
```

在 `buildServer` 内 `const bus = new EventBus();` 之后、`registerRoutes(...)` 之前插入：

```ts
  const mcp = new McpManager();
  await mcp.connectAll(loadMcpConfig());
```

把 `registerRoutes(app, db, bus);` 改为：

```ts
  registerRoutes(app, db, bus, undefined, mcp);
```

在 `return app;` 之前插入关停钩子：

```ts
  app.addHook("onClose", async () => { await mcp.closeAll(); });
```

- [ ] **Step 6: tsc + 全量 server 测试**

Run: `pnpm --filter @traceforge/server exec tsc --noEmit -p tsconfig.json && pnpm vitest run apps/server`
Expected: tsc 退出码 0；server 全部测试通过（含新 routes-mcp 与既有 routes-agent/routes-browser/stores）。

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat(server): integrate MCP tools into agent runs and add GET /api/mcp/tools

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: 收尾 —— config 模板、全量校验、端到端、README

**Files:**
- Create: `config/mcp.example.json`
- Modify: `.gitignore`, `README.md`

- [ ] **Step 1: 写 `config/mcp.example.json`**

```json
{
  "servers": [
    {
      "name": "filesystem",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
      "trustLevel": "command"
    }
  ]
}
```

- [ ] **Step 2: `.gitignore` 加 `config/mcp.json`**

在 `.gitignore` 中 `config/llm.json` 那行下方加一行：

```
config/mcp.json
```

Run（确认不会误提交真实配置）: `grep -n "config/mcp.json" .gitignore`
Expected: 命中一行。

- [ ] **Step 3: 全量测试 + 构建**

Run: `pnpm test && pnpm -r build`
Expected: 全绿；各包构建无错。

- [ ] **Step 4: 端到端手动验证（真实 stdio MCP server，需本机有 npx）**

```bash
# 1) 写真实配置（指向官方 filesystem server，开放 /tmp）
cat > config/mcp.json <<'JSON'
{ "servers": [ { "name": "filesystem", "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"], "trustLevel": "command" } ] }
JSON
# 2) 起后端（独立脚本绕开 main.ts 的 import.meta 判断）
node --import tsx -e "import('./apps/server/src/main.ts').then(m=>m.buildServer('e2e-mcp.sqlite')).then(a=>a.listen({port:4000,host:'127.0.0.1'}))" > server.log 2>&1 &
sleep 8   # 首次 npx 拉包较慢
# 3) 查 MCP 工具池
curl -s localhost:4000/api/mcp/tools
# → 应列出 filesystem server 的工具（read_file/list_directory 等），serverName=filesystem
# 清理：杀后端、删 e2e-mcp.sqlite* server.log、删 config/mcp.json（勿留密钥/真实配置）
```

Expected: `/api/mcp/tools` 返回非空数组，工具的 `serverName` 为 `filesystem`、`toolName` 为该 server 自报的工具名。证明 stdio 连接 + 工具发现端到端打通。（若本机无网络/npx 拉包失败，Task 3 的 mock 单测与 Task 4 的路由单测已覆盖逻辑，此步可记为"环境受限跳过"。）

- [ ] **Step 5: 更新 `README.md`**

"当前进度"标题追加 MCP；在共享浏览器 F2 行之后追加：

```markdown
- MCP 集成（Plan C）：server 启动时连接 config/mcp.json 声明的 stdio MCP server，动态发现其工具并纳入 agent 工具集（命名空间 mcp__<server>__<tool>，默认 risk=command 过确认门，可逐 server 降为 normal）。领域工具留在进程外、零侵入核心——「特定领域知识走 MCP 扩展」原则的主载体。GET /api/mcp/tools 可查当前工具池
```

把测试数量更新为实际值（运行 `pnpm test` 末尾的总数）。

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "docs: add MCP config template and update README (Plan C)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## 自检说明（写给计划作者，非执行步骤）

- **Spec 覆盖**：§2 架构 → Task 1-4；§3 配置格式 → Task 1（Schema/loadMcpConfig）+ Task 5（模板/gitignore）；§4 Manager+适配 → Task 2（mcpToolToDescriptor）+ Task 3（McpManager）；§5 路由集成 → Task 4；§6 错误处理 → Task 1（回退[]）/Task 3（隔离+callTool容错）；§7 测试 → 各任务 TDD + Task 5 端到端；§8 理念 → 命名空间/risk=trustLevel/降级不崩贯穿；§9 分解 = 本 5 任务。
- **类型一致性**：`McpToolHandle`（Task 2 定义，Task 3 produce、Task 4 list）、`McpCaller`（Task 2 定义，McpManager Task 3 implements）、`McpClient`/`McpClientFactory`（Task 3 定义，Task 4 测试注入）、`registerRoutes` 第 5 参 `mcp?: McpManager`（Task 4 签名，main.ts 调用一致）、命名 `mcp__${serverName}__${toolName}`（Task 2 与 Task 4 测试一致）、`risk = trustLevel`/`source = mcp:${serverName}`（Task 2）。
- **安全约束落点**：默认 trustLevel=command（Task 1 Schema 默认）→ risk=command（Task 2）→ 过 ApprovalGate（既有 gate，无需改）；命名空间防冲突（Task 2）；env 走子进程、config gitignored（Task 1 + Task 5）。
- **可测/不可测边界**：config 加载（Task 1 临时文件）、适配纯函数（Task 2）、McpManager（Task 3 注入 fake client，不起子进程）、路由（Task 4 注入 fake McpManager）；真实 stdio server 仅 Task 5 手动。
- **已知简化**：只 stdio；全局工具池跨 case 共享（无 per-case 过滤）；MCP 工具无独立前端 UI（仅 GET 查询端点）；SDK Client → McpClient 用 `as unknown as` 桥接结构接口。
