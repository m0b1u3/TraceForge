# TraceForge Terminal/PoC MCP Server 设计文档

> 状态：设计已确认，待转 writing-plans。对应设计文档第 31.3 节修订路线第 2 项（原阶段 6：Terminal/PoC/依赖，改 MCP server 形态）。

## 1. 目标与定位

把设计文档原阶段 6（Terminal/PoC/依赖安装）以**独立 stdio MCP server** 形态实现，而非塞进核心。agent 获得「写 PoC 脚本、跑本地命令、装依赖、读输出」能力，而 TraceForge 核心**零改动**——通过已建好的 Plan C MCP 通道自动接入。这是「领域能力进程外扩展、零侵入核心」最高原则（设计文档 3.0）的范本。

**新包** `packages/mcp-poc-server`（`@traceforge/mcp-poc-server`）：
- 用 `@modelcontextprotocol/sdk` 的 `Server` + `StdioServerTransport` 写一个 stdio MCP server。
- 接收一个 workspace 根目录参数（env `TRACEFORGE_WORKSPACE`，默认 `./workspace`）。
- 暴露 4 个工具：`exec_command` / `write_file` / `read_file` / `list_dir`，全部按 `caseId` 入参锁进 `workspace/<caseId>/`。
- 用户在 `config/mcp.json` 里接入：
  ```json
  { "name": "poc", "command": "node", "args": ["packages/mcp-poc-server/dist/main.js"],
    "env": { "TRACEFORGE_WORKSPACE": "./workspace" }, "trustLevel": "command" }
  ```

**与核心的关系**：完全解耦。core 不依赖此包；此包不依赖 core（连 caseId 都是工具入参，不 import 任何 core 类型——纯独立 MCP server）。唯一连接点是 config/mcp.json。

## 2. 数据流

```
LLM 调 mcp__poc__exec_command({ caseId, command })
  → Plan C 的 McpManager 转发到本 server（stdio）
  → server 解析 workspace/<caseId>，校验路径不逃逸
  → 执行（cwd 锁定 case 根、超时、输出截断）
  → 结果文本回 LLM；因 trustLevel=command → 先过 ApprovalGate（人确认每条命令）
```

## 3. 工具集与契约

四个工具，全部 `caseId` 入参，路径锁进 `workspace/<caseId>/`：

| 工具 | 入参 | 做什么 |
|---|---|---|
| `exec_command` | `caseId, command, timeoutMs?` | 在 `workspace/<caseId>/` 下跑 shell 命令，返回 stdout/stderr/exitCode |
| `write_file` | `caseId, path, content` | 写文件到 `workspace/<caseId>/<path>`（写 PoC 脚本） |
| `read_file` | `caseId, path` | 读 `workspace/<caseId>/<path>`（读命令输出/脚本） |
| `list_dir` | `caseId, path?` | 列 `workspace/<caseId>/<path>` 目录内容 |

**返回**：统一 MCP 文本内容 `{ content: [{ type: "text", text }] }`。`exec_command` 返回 `exit=<code>\n--- stdout ---\n…\n--- stderr ---\n…`（截断后）。

**装依赖/跑脚本/分析结果如何覆盖**（最小集 + LLM 编排，零硬编码）：
- 装依赖 = `exec_command` 跑 `pip install` / `npm install`。
- 跑 PoC = `write_file` 写脚本 + `exec_command` 跑 `python poc.py`。
- 分析结果 = LLM 读 `read_file` / exec 输出后自己判断，不需要专门工具。

## 4. 核心纯函数（可单测，跨工具复用）

```ts
// 把 caseId + 用户给的相对 path 解析为 workspace 内的绝对路径，越界则抛错
function resolveInWorkspace(workspaceRoot: string, caseId: string, relPath?: string): string;
//  - 校验 caseId 不含路径分隔符 / "."/".." 段（否则抛错）
//  - 拼 workspaceRoot/caseId/relPath，path.resolve 规范化后必须仍在 workspaceRoot/caseId 内（防 ../ 逃逸，否则抛错）
//  - relPath 省略时返回 case 根目录绝对路径

// 输出超长截断（防爆内存/上下文）
function truncateOutput(s: string, maxBytes: number): string;
//  - s 的 UTF-8 字节 ≤ maxBytes 原样返回；否则保留头部 maxBytes 字节 + "\n…[truncated N bytes]" 尾注
```

## 5. server 结构

```
packages/mcp-poc-server/
  src/
    workspace.ts   — resolveInWorkspace + truncateOutput（纯函数，核心安全逻辑）
    tools.ts       — 4 个工具 handler（接 caseId/path，调 workspace.ts，执行 fs/进程）
    server.ts      — 组装 MCP Server：注册 4 工具 schema + dispatch 到 handler
    main.ts        — 入口：读 TRACEFORGE_WORKSPACE，起 StdioServerTransport，连 server
    workspace.test.ts / tools.test.ts
  package.json / tsconfig.json
```

**职责边界**：
- `workspace.ts`：纯函数，不碰 fs/进程，只算路径 + 截断 → 完全可单测。
- `tools.ts`：每个工具一个 async handler `(args, workspaceRoot) => { ok: boolean; text: string }`；用 node `fs/promises` + `child_process`。`exec_command` 用 `spawn` + 超时 kill。case 根目录不存在时自动 `mkdir -p`。
- `server.ts`：MCP 协议层，把 SDK 的 `CallToolRequest` 路由到 handler，catch 错误转 MCP 文本响应。注册 `ListToolsRequest` 返回 4 工具 schema。
- `main.ts`：只做接线（读 env、起 transport、连 server）。

## 6. exec_command 安全约束

- `cwd` 强制 = `resolveInWorkspace(root, caseId)`（case 根），**不接受 cwd 入参**。
- 超时：`timeoutMs` 默认 60000、上限 300000；超时 kill 进程，返回超时文本。
- 输出：stdout/stderr 各 `truncateOutput` 到上限（64KB）。
- **不内置命令黑/白名单**（那是硬编码）——真正的门是 ApprovalGate（trustLevel=command，人确认每条命令）。
- case 根目录不存在时自动创建。

## 7. 错误处理（降级不崩）

| 场景 | 行为 |
|---|---|
| 路径逃逸（`../` / caseId 非法） | `resolveInWorkspace` 抛错 → handler catch → 返回 `{ok:false, text:"path escapes workspace"}`，不执行 |
| 命令超时 | kill 进程 + 返回超时文本（非崩溃） |
| 文件不存在 / 权限错 | catch → 返回错误文本 |
| 工具入参缺 caseId / 非法 | schema 校验失败 → MCP 错误响应 |

## 8. 测试

- **workspace.ts 单测**（纯函数）：正常拼路径、`../` 逃逸被拒、caseId 含 `..`/分隔符被拒、relPath 省略返回 case 根、truncateOutput 截断正确加尾注、未超长原样返回。
- **tools.ts 单测**（用真实临时目录 `fs.mkdtemp`，不 mock fs）：write_file 后 read_file 回原内容、list_dir 列出文件、exec_command 跑 `node -e "console.log(1+1)"` 验证 stdout=2 与 exitCode=0、write_file 越界路径被拒。exec 测试只用快速无害命令（node 自带），不依赖外部工具。
- **真实端到端手动**：`config/mcp.json` 接上本 server（build 后 `node dist/main.js`）→ 起 TraceForge → `GET /api/mcp/tools` 见 `mcp__poc__*` 四工具 → agent 调 write_file 写 PoC + exec_command 跑（过审批门）。

## 9. 核心理念落点（自检）

- **零硬编码**：4 个通用原子工具，不预设语言/包管理器/命令语义；装依赖/跑脚本/分析全由 LLM 用原子工具编排。
- **进程外扩展**：能力在独立包、独立进程，core 零改动，唯一连接点 config/mcp.json——「领域能力走 MCP 扩展」范本。
- **安全边界**：cwd 锁 case 子目录 + 路径逃逸拒绝 + 超时 + 输出截断；命令执行 risk=command 过 ApprovalGate 人工确认。不内置黑白名单（不硬编码"能跑什么"）。
- **Case 隔离**：每 Case 一个 workspace 子目录，PoC/输出/依赖按 caseId 隔离，与全局 case_id 隔离原则一致。

## 10. 实现分解（单一 plan）

聚焦单一子系统（PoC MCP server 包），适合一个实施计划，预计任务：
1. 新包脚手架（package.json/tsconfig）+ workspace.ts 纯函数 + 单测
2. tools.ts 四工具 handler + 单测（真实临时目录）
3. server.ts MCP 协议组装（ListTools + CallTool dispatch）
4. main.ts 入口 + build + 端到端手测（接 config/mcp.json）+ README/mcp.example.json 更新
```