# TraceForge MCP 集成 设计文档（Plan C）

> 状态：设计已确认，待转 writing-plans 拆为实施计划。

## 1. 目标与定位

让 TraceForge agent **动态发现并调用外部 MCP server 暴露的工具**。这是「特定领域知识走外部扩展、坚决反对硬编码」最高原则（设计文档 3.0）的**主载体**：核心仓只保留"如何发现和调用 MCP 工具"的通用机制，所有领域工具（安全工具的 MCP 封装等）留在**进程外**，零侵入核心代码。一旦此通道打通，大量工具配上 server 地址即接入，无需为每个工具写适配代码。

**第一版范围（YAGNI）**：
- 只支持 **stdio 传输**（本地子进程 MCP server）。HTTP/SSE 传输留待将来。
- MCP server 在 **TraceForge server 启动时全局连接**，工具发现缓存为全局工具池；每次 agent run 把全局工具注册进该 case 的 registry。
- 只做后端 + 一个只读查询端点 `GET /api/mcp/tools`，**不做 MCP 管理前端 UI**（占位原则，留待整体工作台设计）。

## 2. 整体架构

```
config/mcp.json (gitignored, Zod 校验)
        │ server 启动时 loadMcpConfig()
        ▼
McpManager.connectAll(configs)
   对每个 server：StdioClientTransport spawn 子进程 + Client.connect + tools/list
   单个 server 失败 → try/catch 跳过 + console.error，其余照常
        │
        ▼
McpManager 持有全局工具池 McpToolHandle[]   （长期保持，跨 case 共享）
        │ 每次 agent run（routes.ts）
        ▼
for (h of mcp.listTools()) registry.register(mcpToolToDescriptor(h, mcp))
        │ LLM 自主调用 mcp__<server>__<tool>
        ▼
ToolDescriptor.execute → McpManager.callTool(server, origName, input) → MCP tools/call
        │ 默认 risk=command
        ▼
过 ApprovalGate（人工确认）→ 执行 → 结果回 agent loop
```

**新增单元**（全部在 `@traceforge/extension`——工具地基所在，server 已依赖它）：

| 文件 | 职责 |
|---|---|
| `mcp-config.ts` | `McpServerConfigSchema` + `loadMcpConfig()`（仿 llm config 约定） |
| `mcp-manager.ts` | `McpManager`：connectAll / listTools / callTool / closeAll |
| `mcp-tools.ts` | `mcpToolToDescriptor(handle, manager)`：MCP 工具 → ToolDescriptor |

**新增依赖**：`@modelcontextprotocol/sdk`（官方 TS SDK，提供 stdio client transport + 协议握手）。

**为什么放 extension 而非新包**：MCP 适配产出 `ToolDescriptor`，与 builtin-tools / case-tools / browser-tools 同类同源，"变化在一起的代码住一起"。

## 3. 配置格式（config/mcp.json）

仿照 `llm.json`：gitignored、有 `.example` 模板、Zod 校验、加载失败静默回退空池（无 MCP 配置 = 没有 MCP 工具，不报错）。

```jsonc
{
  "servers": [
    {
      "name": "filesystem",            // 命名空间用，须唯一、^[a-z0-9_]+$
      "command": "npx",                // stdio 子进程命令
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
      "env": { "FOO": "bar" },          // 可选，注入子进程环境变量
      "trustLevel": "command"          // 可选，默认 "command"；"normal" 则该 server 工具不卡确认门
    }
  ]
}
```

**Schema**（`McpServerConfigSchema`）：
- `name`: `z.string().regex(/^[a-z0-9_]+$/)` —— 要拼进 `mcp__<name>__<tool>`，限制字符避免歧义。
- `command`: `z.string()`。
- `args`: `z.array(z.string()).default([])`。
- `env`: `z.record(z.string()).optional()` —— 密钥走子进程环境变量；由用户保证 config/mcp.json 不进库。
- `trustLevel`: `z.enum(["command","normal"]).default("command")` —— **闭枚举**（系统控制的风险档位，非 LLM 判断字段，符合开闭原则）。

顶层：`McpConfigSchema = z.object({ servers: z.array(McpServerConfigSchema).default([]) })`。

**加载**：`loadMcpConfig(path = "config/mcp.json"): McpServerConfig[]` —— 读不到 / JSON 解析失败 / Zod 校验失败 → 返回 `[]`。

**仓库**：`.gitignore` 加 `config/mcp.json`；提交 `config/mcp.example.json` 作模板。

## 4. McpManager 与工具适配

```ts
export interface McpToolHandle {
  serverName: string;        // "filesystem"
  toolName: string;          // 远端原名 "read_file"
  description: string;
  inputSchema: Record<string, unknown>;
  trustLevel: "command" | "normal";
}

export class McpManager {
  // 对每个 config：StdioClientTransport spawn + Client.connect + listTools → 缓存 McpToolHandle[]
  // 单个 server 失败 try/catch 隔离：console.error 记录，跳过，继续
  async connectAll(configs: McpServerConfig[]): Promise<void>;

  listTools(): McpToolHandle[];   // 全局工具池（所有 server 并集）

  // 找到对应 client → callTool({name, arguments}) → content 拼成字符串
  // 抛错则 { ok:false, content:错误 }（不崩 agent loop）
  async callTool(serverName: string, toolName: string, input: unknown): Promise<{ ok: boolean; content: string }>;

  async closeAll(): Promise<void>;  // 断开所有子进程
}
```

**工具适配**：
```ts
export function mcpToolToDescriptor(h: McpToolHandle, manager: McpManager): ToolDescriptor {
  return {
    name: `mcp__${h.serverName}__${h.toolName}`,   // 命名空间防冲突
    description: h.description,                      // 远端自报，TraceForge 不预设语义
    inputSchema: h.inputSchema,                      // 远端 schema 直接透传给 LLM
    risk: h.trustLevel,                              // command（默认卡门）或 normal
    source: `mcp:${h.serverName}`,                   // source 是开 string，天然容纳
    execute: (input) => manager.callTool(h.serverName, h.toolName, input),
  };
}
```

**关键点**：
- **零硬编码**：description / inputSchema 全部来自远端 server，LLM 自主决定怎么用。
- **风险归属**：`risk = trustLevel`，默认 command → 自动过现有 ApprovalGate，无需改 gate。
- **execute 容错**：callTool 内 try/catch，失败返回 `{ok:false}`，LLM 换路（与浏览器工具一致）。

**生命周期**：`McpManager` 在 `main.ts` 的 `buildServer()` 里 `new` + `connectAll(loadMcpConfig())`，传入 `registerRoutes`；app `onClose` 钩子调 `closeAll()`。

## 5. 路由集成

`registerRoutes(app, db, bus, provider?, mcp?: McpManager)` —— 多收一个可选 `mcp`（第 5 参，provider 仍第 4）。

- agent run 路由注册工具集处（browser tools 之后）追加：
  ```ts
  if (mcp) {
    for (const h of mcp.listTools()) registry.register(mcpToolToDescriptor(h, mcp));
  }
  ```
- 新增只读路由：`GET /api/mcp/tools` → 返回 `mcp?.listTools() ?? []`（调试/前端可见接入了哪些 MCP 工具）。

**main.ts 接线**：
```ts
const mcp = new McpManager();
await mcp.connectAll(loadMcpConfig());
registerRoutes(app, db, bus, undefined, mcp);
app.addHook("onClose", async () => { await mcp.closeAll(); });
```

## 6. 错误处理（全部"降级不崩"）

| 场景 | 行为 |
|---|---|
| config 读不到 / 解析失败 / 校验失败 | `loadMcpConfig` 返回 `[]`，无 MCP 工具 |
| 单个 server spawn / 握手 / listTools 失败 | try/catch 跳过该 server，`console.error` 记录，其余照常 |
| callTool 抛错 / server 中途崩 | execute 返回 `{ok:false, content:错误}`，LLM 换路 |
| 工具名冲突（理论上同 server 内重名） | `register` 抛错 → run 路由已有 try/catch 捕获返回 500（极少见） |

## 7. 测试

沿用"纯逻辑单测、真实子进程不单测"边界：

- **`mcpToolToDescriptor` 单测**（纯函数）：命名空间拼接、risk 跟随 trustLevel、source 格式、execute 转发到 manager.callTool。
- **`loadMcpConfig` 单测**：合法配置解析、非法 name 被拒、缺文件回退 `[]`、trustLevel 默认 command、env 可选。
- **`McpManager` 用 mock client 单测**（不起真子进程，依赖注入假 client 工厂）：connectAll 缓存工具、单 server 失败被隔离、callTool 转发与容错、closeAll。
- **路由单测**（inject）：注入带假工具的 McpManager → agent run 时工具进 registry（借 mock provider 验证 LLM 能"看到"）；`GET /api/mcp/tools` 返回工具列表。
- **真实 stdio MCP server 端到端**（手动）：配 `@modelcontextprotocol/server-filesystem`，起 TraceForge，看 `GET /api/mcp/tools` 列出工具、agent 能调用。

> 为可单测，`McpManager.connectAll` 内创建 client 的逻辑要可注入（构造函数接受一个可选的 `clientFactory`，默认用真实 SDK 的 stdio client；测试传入返回 mock client 的工厂）。

## 8. 核心理念落点（自检）

- **零硬编码**：MCP 工具的 description / inputSchema 全部远端自报，TraceForge 不预设任何工具语义，LLM 自主编排。
- **可扩展**：接一个新工具 = 在 config/mcp.json 加一条，无需改核心代码。这是"领域知识进程外扩展"的真正落地。
- **LLM 主导**：MCP 工具与内置工具一视同仁纳入 registry，LLM 在 tool-calling 中自主选用。
- **安全边界**：MCP 工具默认 risk=command → 过 ApprovalGate 人工确认；可信 server 可在 config 逐个降为 normal。命名空间 `mcp__<server>__<tool>` 防冲突。
- **降级不崩**：单 server 失败隔离、callTool 容错、无配置照常启动——外部依赖不可靠不拖垮主体。

## 9. 实现分解（单一 plan 即可）

本设计聚焦单一子系统（MCP 接入通道），适合一个实施计划，预计任务：
1. extension：`mcp-config.ts`（Schema + loadMcpConfig）+ 单测
2. extension：`mcp-tools.ts`（mcpToolToDescriptor）+ 单测
3. extension：`mcp-manager.ts`（McpManager + 可注入 clientFactory）+ mock client 单测；加 `@modelcontextprotocol/sdk` 依赖
4. server：routes.ts 集成（agent run 注册 MCP 工具 + `GET /api/mcp/tools`）+ main.ts 接线 + 路由单测
5. 收尾：config/mcp.example.json + .gitignore + 全量测试/构建 + 真实 server 端到端手测 + README
```