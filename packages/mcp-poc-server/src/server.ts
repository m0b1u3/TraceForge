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
