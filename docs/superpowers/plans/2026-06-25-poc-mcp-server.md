# Terminal/PoC MCP Server 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans（当前会话直接执行，TDD 节奏）。Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新建独立包 `@traceforge/mcp-poc-server`——一个 stdio MCP server，暴露 4 个工具（exec_command/write_file/read_file/list_dir），全部按 caseId 入参锁进 `workspace/<caseId>/`，让 agent 通过 Plan C 的 MCP 通道获得「写 PoC、跑命令、装依赖、读输出」能力。TraceForge 核心零改动。对应 spec docs/superpowers/specs/2026-06-25-poc-mcp-server-design.md。

**Architecture:** 新包 packages/mcp-poc-server：`workspace.ts`（纯函数 resolveInWorkspace + truncateOutput，核心安全逻辑）、`tools.ts`（4 工具 handler，用 fs/promises + spawn）、`server.ts`（MCP 协议组装，ListTools + CallTool dispatch）、`main.ts`（入口，读 env 起 stdio transport）。与 core 双向不依赖，唯一连接点 config/mcp.json。

**Tech Stack:** TypeScript ESM strict、Vitest、`@modelcontextprotocol/sdk`（Server + StdioServerTransport，server 端 API）、node `fs/promises` + `child_process.spawn`。

## Global Constraints

- 沿用既有约束：Node ≥ 22、pnpm、ESM、`strict: true`、Vitest、纯逻辑模块必须单测。`tsconfig.base.json` 含 `verbatimModuleSyntax: true` —— 类型导入必须用 `import type`。
- **与 core 完全解耦**：本包不依赖任何 `@traceforge/*`，core 不依赖本包；caseId 是工具入参，不 import core 类型。
- **路径锁定**：所有文件/命令路径经 `resolveInWorkspace(root, caseId, relPath)` 解析为 `workspace/<caseId>/<relPath>`，越界（`../` 逃逸、caseId 含分隔符/`..`）抛错拒绝。
- **exec_command 约束**：cwd 强制 = case 根（不接受 cwd 入参）；timeoutMs 默认 60000、上限 300000，超时 kill；stdout/stderr 各截断到 64KB；**不内置命令黑/白名单**（靠 ApprovalGate 人确认，trustLevel=command）。
- **降级不崩**：路径逃逸/超时/文件错都 catch 后返回 `{ok:false,text}`，不抛出崩 server。
- workspace 根来自 env `TRACEFORGE_WORKSPACE`，默认 `./workspace`；case 根不存在自动创建。
- 提交信息结尾附：`Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`。

---

### Task 1: 新包脚手架 + workspace.ts 纯函数

**Files:**
- Create: `packages/mcp-poc-server/package.json`, `packages/mcp-poc-server/tsconfig.json`, `packages/mcp-poc-server/src/workspace.ts`
- Test: `packages/mcp-poc-server/src/workspace.test.ts`

**Interfaces:**
- Produces：
  - `function resolveInWorkspace(workspaceRoot: string, caseId: string, relPath?: string): string` —— 校验 caseId（非空、不含 `/` `\` 或 `.`/`..` 段）+ 拼路径 + path.resolve 后必须仍在 `workspaceRoot/caseId` 内，否则 throw `Error("path escapes workspace")`；relPath 省略返回 case 根。
  - `function truncateOutput(s: string, maxBytes: number): string` —— UTF-8 字节 ≤ maxBytes 原样；否则截到 maxBytes 字节 + `\n…[truncated N bytes]`。

- [ ] **Step 1: 写 `packages/mcp-poc-server/package.json`**

```json
{
  "name": "@traceforge/mcp-poc-server",
  "version": "0.1.0",
  "type": "module",
  "main": "./src/index.ts",
  "bin": { "traceforge-mcp-poc": "./dist/main.js" },
  "scripts": { "build": "tsc -p tsconfig.json" },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.29.0"
  }
}
```

- [ ] **Step 2: 写 `packages/mcp-poc-server/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src", "lib": ["ES2023"] },
  "include": ["src"]
}
```

- [ ] **Step 3: 安装依赖（注册新包到 workspace）**

Run: `pnpm install`
Expected: 新包被 pnpm workspace 识别，@modelcontextprotocol/sdk 链接成功。

- [ ] **Step 4: 写失败测试 `packages/mcp-poc-server/src/workspace.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { resolveInWorkspace, truncateOutput } from "./workspace.js";
import { join, resolve } from "node:path";

const root = resolve("/tmp/ws");

describe("resolveInWorkspace", () => {
  it("resolves a relative path inside the case dir", () => {
    expect(resolveInWorkspace(root, "case1", "poc.py")).toBe(join(root, "case1", "poc.py"));
  });

  it("returns the case root when relPath omitted", () => {
    expect(resolveInWorkspace(root, "case1")).toBe(join(root, "case1"));
  });

  it("rejects ../ escape in relPath", () => {
    expect(() => resolveInWorkspace(root, "case1", "../../etc/passwd")).toThrow(/escape/i);
  });

  it("rejects a caseId containing a path separator", () => {
    expect(() => resolveInWorkspace(root, "a/b", "x")).toThrow();
    expect(() => resolveInWorkspace(root, "..", "x")).toThrow();
  });

  it("rejects an empty caseId", () => {
    expect(() => resolveInWorkspace(root, "", "x")).toThrow();
  });
});

describe("truncateOutput", () => {
  it("returns input unchanged when within limit", () => {
    expect(truncateOutput("hello", 100)).toBe("hello");
  });

  it("truncates and annotates when over limit", () => {
    const out = truncateOutput("abcdefghij", 4);
    expect(out.startsWith("abcd")).toBe(true);
    expect(out).toMatch(/truncated 6 bytes/);
  });
});
```

- [ ] **Step 5: 运行确认失败**

Run: `pnpm vitest run packages/mcp-poc-server/src/workspace.test.ts`
Expected: FAIL —— workspace 模块不存在。

- [ ] **Step 6: 写 `packages/mcp-poc-server/src/workspace.ts`**

```ts
import { resolve, join, sep } from "node:path";

export function resolveInWorkspace(workspaceRoot: string, caseId: string, relPath = "."): string {
  if (!caseId || caseId.includes("/") || caseId.includes("\\") || caseId === "." || caseId === "..") {
    throw new Error(`invalid caseId: ${caseId}`);
  }
  const caseRoot = resolve(workspaceRoot, caseId);
  const target = resolve(caseRoot, relPath);
  if (target !== caseRoot && !target.startsWith(caseRoot + sep)) {
    throw new Error("path escapes workspace");
  }
  return relPath === "." ? caseRoot : join(caseRoot, relPath);
}

export function truncateOutput(s: string, maxBytes: number): string {
  const buf = Buffer.from(s, "utf8");
  if (buf.byteLength <= maxBytes) return s;
  const head = buf.subarray(0, maxBytes).toString("utf8");
  return `${head}\n…[truncated ${buf.byteLength - maxBytes} bytes]`;
}
```

> 注：`resolveInWorkspace` 返回值用 `join(caseRoot, relPath)`（测试断言 `join` 形式）；逃逸判断用 `resolve` 后的规范化路径比较。两者对合法路径结果一致。

- [ ] **Step 7: 运行确认通过 + tsc**

Run: `pnpm vitest run packages/mcp-poc-server/src/workspace.test.ts && pnpm --filter @traceforge/mcp-poc-server exec tsc --noEmit -p tsconfig.json`
Expected: 7 用例全绿；tsc 退出码 0。

- [ ] **Step 8: Commit**

```bash
git add -A && git commit -m "feat(mcp-poc-server): scaffold package and workspace path/truncate functions

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: tools.ts —— 4 工具 handler

**Files:**
- Create: `packages/mcp-poc-server/src/tools.ts`
- Test: `packages/mcp-poc-server/src/tools.test.ts`

**Interfaces:**
- Consumes: `resolveInWorkspace`/`truncateOutput`（Task 1）、node `fs/promises`、`child_process.spawn`。
- Produces：
  - `interface ToolOutput { ok: boolean; text: string }`
  - `async function execCommand(root: string, args: { caseId: string; command: string; timeoutMs?: number }): Promise<ToolOutput>` —— cwd=case 根（自动 mkdir），spawn shell 跑 command，超时 kill，返回 `exit=<code>\n--- stdout ---\n…\n--- stderr ---\n…`（各截断 64KB）。
  - `async function writeFile(root: string, args: { caseId: string; path: string; content: string }): Promise<ToolOutput>`
  - `async function readFile(root: string, args: { caseId: string; path: string }): Promise<ToolOutput>`
  - `async function listDir(root: string, args: { caseId: string; path?: string }): Promise<ToolOutput>`
  - 路径逃逸/fs 错误均 catch 返回 `{ok:false,text}`。

- [ ] **Step 1: 写失败测试 `packages/mcp-poc-server/src/tools.test.ts`**

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execCommand, writeFile, readFile, listDir } from "./tools.js";

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "poc-ws-")); });

describe("write/read/list", () => {
  it("write then read returns original content", async () => {
    const w = await writeFile(root, { caseId: "c1", path: "poc.py", content: "print(1)" });
    expect(w.ok).toBe(true);
    const r = await readFile(root, { caseId: "c1", path: "poc.py" });
    expect(r.ok).toBe(true);
    expect(r.text).toBe("print(1)");
  });

  it("list_dir lists written files", async () => {
    await writeFile(root, { caseId: "c1", path: "a.txt", content: "x" });
    const l = await listDir(root, { caseId: "c1" });
    expect(l.ok).toBe(true);
    expect(l.text).toContain("a.txt");
  });

  it("rejects a path that escapes the workspace", async () => {
    const w = await writeFile(root, { caseId: "c1", path: "../../evil.txt", content: "x" });
    expect(w.ok).toBe(false);
    expect(w.text).toMatch(/escape/i);
  });
});

describe("exec_command", () => {
  it("runs a harmless node command and captures stdout + exit code", async () => {
    const res = await execCommand(root, { caseId: "c1", command: 'node -e "console.log(1+1)"' });
    expect(res.ok).toBe(true);
    expect(res.text).toContain("exit=0");
    expect(res.text).toContain("2");
  });

  it("reports a non-zero exit code", async () => {
    const res = await execCommand(root, { caseId: "c1", command: 'node -e "process.exit(3)"' });
    expect(res.text).toContain("exit=3");
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run packages/mcp-poc-server/src/tools.test.ts`
Expected: FAIL —— tools 模块不存在。

- [ ] **Step 3: 写 `packages/mcp-poc-server/src/tools.ts`**

```ts
import { spawn } from "node:child_process";
import { mkdir, writeFile as fsWriteFile, readFile as fsReadFile, readdir } from "node:fs/promises";
import { resolveInWorkspace, truncateOutput } from "./workspace.js";

export interface ToolOutput { ok: boolean; text: string }

const MAX_OUT = 64 * 1024;

export async function execCommand(
  root: string,
  args: { caseId: string; command: string; timeoutMs?: number },
): Promise<ToolOutput> {
  let cwd: string;
  try {
    cwd = resolveInWorkspace(root, args.caseId);
  } catch (e) {
    return { ok: false, text: (e as Error).message };
  }
  await mkdir(cwd, { recursive: true });
  const timeout = Math.min(args.timeoutMs ?? 60000, 300000);
  return new Promise<ToolOutput>((resolveP) => {
    const child = spawn(args.command, { cwd, shell: true });
    let out = "", err = "";
    let killed = false;
    const timer = setTimeout(() => { killed = true; child.kill("SIGKILL"); }, timeout);
    child.stdout.on("data", (d) => { out += d.toString(); });
    child.stderr.on("data", (d) => { err += d.toString(); });
    child.on("close", (code) => {
      clearTimeout(timer);
      const head = killed ? `exit=timeout(${timeout}ms)` : `exit=${code}`;
      resolveP({
        ok: !killed,
        text: `${head}\n--- stdout ---\n${truncateOutput(out, MAX_OUT)}\n--- stderr ---\n${truncateOutput(err, MAX_OUT)}`,
      });
    });
    child.on("error", (e) => { clearTimeout(timer); resolveP({ ok: false, text: `spawn failed: ${e.message}` }); });
  });
}

export async function writeFile(
  root: string,
  args: { caseId: string; path: string; content: string },
): Promise<ToolOutput> {
  try {
    const target = resolveInWorkspace(root, args.caseId, args.path);
    await mkdir(resolveInWorkspace(root, args.caseId), { recursive: true });
    await fsWriteFile(target, args.content, "utf8");
    return { ok: true, text: `wrote ${args.path}` };
  } catch (e) {
    return { ok: false, text: (e as Error).message };
  }
}

export async function readFile(
  root: string,
  args: { caseId: string; path: string },
): Promise<ToolOutput> {
  try {
    const target = resolveInWorkspace(root, args.caseId, args.path);
    const content = await fsReadFile(target, "utf8");
    return { ok: true, text: truncateOutput(content, MAX_OUT) };
  } catch (e) {
    return { ok: false, text: (e as Error).message };
  }
}

export async function listDir(
  root: string,
  args: { caseId: string; path?: string },
): Promise<ToolOutput> {
  try {
    const target = resolveInWorkspace(root, args.caseId, args.path ?? ".");
    const entries = await readdir(target, { withFileTypes: true });
    const text = entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).join("\n") || "(empty)";
    return { ok: true, text };
  } catch (e) {
    return { ok: false, text: (e as Error).message };
  }
}
```

- [ ] **Step 4: 运行确认通过 + tsc**

Run: `pnpm vitest run packages/mcp-poc-server/src/tools.test.ts && pnpm --filter @traceforge/mcp-poc-server exec tsc --noEmit -p tsconfig.json`
Expected: 5 用例全绿；tsc 退出码 0。

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(mcp-poc-server): add exec/write/read/list tool handlers

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: server.ts —— MCP 协议组装

**Files:**
- Create: `packages/mcp-poc-server/src/server.ts`
- Test: `packages/mcp-poc-server/src/server.test.ts`

**Interfaces:**
- Consumes: `execCommand`/`writeFile`/`readFile`/`listDir`（Task 2）、`@modelcontextprotocol/sdk` 的 `Server`、`ListToolsRequestSchema`/`CallToolRequestSchema`（`@modelcontextprotocol/sdk/types.js`）。
- Produces：
  - `const TOOL_DEFS: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>` —— 4 工具的 MCP schema（每个含 caseId）。
  - `function dispatchTool(name: string, args: Record<string, unknown>, root: string): Promise<{ ok: boolean; text: string }>` —— 按 name 路由到对应 handler（未知工具返回 ok:false）。
  - `function createServer(root: string): Server` —— new Server + setRequestHandler(ListTools → TOOL_DEFS, CallTool → dispatchTool 包成 MCP content)。

- [ ] **Step 1: 写失败测试 `packages/mcp-poc-server/src/server.test.ts`（测 dispatchTool + TOOL_DEFS，不起真 transport）**

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TOOL_DEFS, dispatchTool } from "./server.js";

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "poc-srv-")); });

describe("TOOL_DEFS", () => {
  it("exposes the four tools, each requiring caseId", () => {
    expect(TOOL_DEFS.map((t) => t.name).sort()).toEqual(["exec_command", "list_dir", "read_file", "write_file"]);
    for (const t of TOOL_DEFS) {
      expect((t.inputSchema as { properties: Record<string, unknown> }).properties).toHaveProperty("caseId");
    }
  });
});

describe("dispatchTool", () => {
  it("routes write_file then read_file", async () => {
    const w = await dispatchTool("write_file", { caseId: "c1", path: "a.txt", content: "hi" }, root);
    expect(w.ok).toBe(true);
    const r = await dispatchTool("read_file", { caseId: "c1", path: "a.txt" }, root);
    expect(r.text).toBe("hi");
  });

  it("returns ok:false for an unknown tool", async () => {
    const res = await dispatchTool("nope", { caseId: "c1" }, root);
    expect(res.ok).toBe(false);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run packages/mcp-poc-server/src/server.test.ts`
Expected: FAIL —— server 模块不存在。

- [ ] **Step 3: 写 `packages/mcp-poc-server/src/server.ts`**

```ts
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { execCommand, writeFile, readFile, listDir, type ToolOutput } from "./tools.js";

const caseIdProp = { caseId: { type: "string", description: "当前 Case 的 id，文件/命令锁在 workspace/<caseId>/ 内" } };

export const TOOL_DEFS = [
  {
    name: "exec_command",
    description: "在该 Case 的工作区目录下执行一条 shell 命令（写 PoC 后跑、装依赖等）。返回 exit code 与 stdout/stderr。",
    inputSchema: { type: "object", properties: { ...caseIdProp, command: { type: "string" }, timeoutMs: { type: "number" } }, required: ["caseId", "command"] },
  },
  {
    name: "write_file",
    description: "在该 Case 工作区写文件（如 PoC 脚本）。路径相对工作区根。",
    inputSchema: { type: "object", properties: { ...caseIdProp, path: { type: "string" }, content: { type: "string" } }, required: ["caseId", "path", "content"] },
  },
  {
    name: "read_file",
    description: "读该 Case 工作区里的文件（命令输出、脚本等）。",
    inputSchema: { type: "object", properties: { ...caseIdProp, path: { type: "string" } }, required: ["caseId", "path"] },
  },
  {
    name: "list_dir",
    description: "列出该 Case 工作区目录内容。",
    inputSchema: { type: "object", properties: { ...caseIdProp, path: { type: "string" } }, required: ["caseId"] },
  },
];

export async function dispatchTool(name: string, args: Record<string, unknown>, root: string): Promise<ToolOutput> {
  const a = args as Record<string, string>;
  switch (name) {
    case "exec_command": return execCommand(root, { caseId: a.caseId, command: a.command, timeoutMs: args.timeoutMs as number | undefined });
    case "write_file": return writeFile(root, { caseId: a.caseId, path: a.path, content: a.content });
    case "read_file": return readFile(root, { caseId: a.caseId, path: a.path });
    case "list_dir": return listDir(root, { caseId: a.caseId, path: a.path });
    default: return { ok: false, text: `unknown tool: ${name}` };
  }
}

export function createServer(root: string): Server {
  const server = new Server({ name: "traceforge-poc", version: "0.1.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_DEFS }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const res = await dispatchTool(req.params.name, (req.params.arguments ?? {}) as Record<string, unknown>, root);
    return { content: [{ type: "text", text: res.text }], isError: !res.ok };
  });
  return server;
}
```

- [ ] **Step 4: 运行确认通过 + tsc**

Run: `pnpm vitest run packages/mcp-poc-server/src/server.test.ts && pnpm --filter @traceforge/mcp-poc-server exec tsc --noEmit -p tsconfig.json`
Expected: 3 用例全绿；tsc 退出码 0。

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(mcp-poc-server): assemble MCP server with tool defs and dispatch

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: main.ts 入口 + build + 端到端 + 文档

**Files:**
- Create: `packages/mcp-poc-server/src/main.ts`
- Modify: `config/mcp.example.json`, `README.md`

**Interfaces:**
- Consumes: `createServer`（Task 3）、`@modelcontextprotocol/sdk/server/stdio.js` 的 `StdioServerTransport`。
- Produces：可执行入口 `dist/main.js`（读 `TRACEFORGE_WORKSPACE`，起 stdio transport，连 server）。

- [ ] **Step 1: 写 `packages/mcp-poc-server/src/main.ts`**

```ts
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

const root = process.env.TRACEFORGE_WORKSPACE ?? "./workspace";
const server = createServer(root);
const transport = new StdioServerTransport();
await server.connect(transport);
```

- [ ] **Step 2: build（产出 dist/main.js）**

Run: `pnpm --filter @traceforge/mcp-poc-server build`
Expected: 生成 `packages/mcp-poc-server/dist/main.js` 等；无 tsc 错。

- [ ] **Step 3: 全量测试 + 全量构建**

Run: `pnpm test && pnpm -r build`
Expected: 全绿（mcp-poc-server 多 workspace/tools/server 共 ~15 用例）；各包构建无错。

- [ ] **Step 4: 端到端手动验证（真实接入）**

```bash
# 1) workspace 目录
mkdir -p workspace
# 2) config/mcp.json 接上本 server（build 后的 dist）
cat > config/mcp.json <<'JSON'
{ "servers": [ { "name": "poc", "command": "node", "args": ["packages/mcp-poc-server/dist/main.js"], "env": { "TRACEFORGE_WORKSPACE": "./workspace" }, "trustLevel": "command" } ] }
JSON
# 3) 起 TraceForge 后端
node --import tsx -e "import('./apps/server/src/main.ts').then(m=>m.buildServer('e2e-poc.sqlite')).then(a=>a.listen({port:4000,host:'127.0.0.1'}))" > server.log 2>&1 &
sleep 8
# 4) 查工具池：应见 mcp__poc__exec_command / write_file / read_file / list_dir
curl -s localhost:4000/api/mcp/tools | grep -o "mcp__poc__[a-z_]*" | sort -u
# 清理：杀后端、删 e2e-poc.sqlite* server.log、删 config/mcp.json（勿留），workspace/ 可留或删
```
Expected: `curl` 输出含 `mcp__poc__exec_command`、`mcp__poc__list_dir`、`mcp__poc__read_file`、`mcp__poc__write_file`。证明本 server 经 Plan C 通道被发现、命名空间正确。（若本机 npx/启动受限，Task 1-3 单测已覆盖核心逻辑，此步可记环境受限跳过。）

- [ ] **Step 5: 更新 `config/mcp.example.json`（加 poc server 示例）**

把 `config/mcp.example.json` 的 servers 数组追加一项（在 filesystem 后）：

```json
    {
      "name": "poc",
      "command": "node",
      "args": ["packages/mcp-poc-server/dist/main.js"],
      "env": { "TRACEFORGE_WORKSPACE": "./workspace" },
      "trustLevel": "command"
    }
```

- [ ] **Step 6: 更新 `README.md`**

"当前进度"标题追加，并在工作台 UI 行后追加：

```markdown
- Terminal/PoC MCP server（@traceforge/mcp-poc-server，修订路线第 2 项）：独立 stdio MCP server，暴露 exec_command/write_file/read_file/list_dir 四个原子工具，按 caseId 锁进 workspace/<caseId>/（路径逃逸拒绝 + 命令超时 + 输出截断）。让 agent 写 PoC、跑命令、装依赖、读输出——装依赖=exec pip/npm、跑脚本=write+exec、分析=LLM 读输出自判，零硬编码。命令执行 risk=command 过 ApprovalGate 人工确认。core 零改动，经 config/mcp.json 接入（见 mcp.example.json）
```

把测试数量更新为实际值（`pnpm test` 末尾总数）。

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat(mcp-poc-server): add entry point, config example, and docs

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## 自检说明（写给计划作者，非执行步骤）

- **Spec 覆盖**：§1 定位/新包 → Task 1（脚手架）；§3 工具集 → Task 2（handler）+ Task 3（schema）；§4 纯函数 → Task 1；§5 结构 → Task 1-4 分文件；§6 exec 安全 → Task 2（cwd 锁/超时/截断/无黑白名单）；§7 错误处理 → Task 2-3 catch；§8 测试 → 各任务 TDD + Task 4 端到端；§9 理念 → 解耦/路径锁贯穿；§10 分解 = 本 4 任务。
- **类型一致性**：`resolveInWorkspace(root, caseId, relPath?)`/`truncateOutput(s, maxBytes)`（Task 1 定义，Task 2 消费）；`ToolOutput {ok,text}`（Task 2 定义，Task 3 import 复用）；`execCommand/writeFile/readFile/listDir` 签名（Task 2 定义，Task 3 dispatchTool 调用一致）；`TOOL_DEFS`/`dispatchTool`/`createServer`（Task 3 定义，Task 4 main 用 createServer）。
- **解耦核对**：本包 package.json 只依赖 @modelcontextprotocol/sdk，无任何 @traceforge/*；caseId 是入参不 import core。
- **安全约束落点**：路径逃逸（Task 1 resolveInWorkspace + Task 2 各 handler catch + 测试越界用例）；cwd 锁 case 根（Task 2 execCommand 不接受 cwd 入参）；超时/截断（Task 2 + truncateOutput）；无黑白名单（设计选择，靠 ApprovalGate）。
- **可测/不可测边界**：纯函数（Task 1）、handler 用真实临时目录（Task 2，exec 只跑 node 自带无害命令）、dispatch/TOOL_DEFS（Task 3，不起 transport）；真实 MCP 接入靠 Task 4 端到端手测。
- **verbatimModuleSyntax**：`ToolOutput` 在 Task 3 用 `import { ..., type ToolOutput }` 形式（类型与值混合导入需 inline type 修饰）。
