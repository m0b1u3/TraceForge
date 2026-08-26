import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { McpServerConfig } from "./mcp-config.js";
import type { McpToolHandle, McpCaller } from "./mcp-tools.js";

export interface McpClient {
  listTools(): Promise<{ tools: Array<{
    name: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
    annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; openWorldHint?: boolean };
  }> }>;
  callTool(args: { name: string; arguments: unknown }): Promise<{
    content?: Array<{ type: string; text?: string }>;
    isError?: boolean;
    structuredContent?: Record<string, unknown>;
  }>;
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
            annotations: t.annotations,
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

  async callTool(serverName: string, toolName: string, input: unknown): Promise<{ ok: boolean; content: string; meta?: Record<string, unknown> }> {
    const client = this.clients.get(serverName);
    if (!client) return { ok: false, content: `unknown mcp server: ${serverName}` };
    try {
      const res = await client.callTool({ name: toolName, arguments: input });
      const text = (res.content ?? [])
        .map((c) => (c.type === "text" ? c.text ?? "" : `[${c.type}]`))
        .join("\n");
      return { ok: !res.isError, content: text, ...(res.structuredContent ? { meta: res.structuredContent } : {}) };
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
