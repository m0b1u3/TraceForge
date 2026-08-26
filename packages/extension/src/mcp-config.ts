import { readFileSync } from "node:fs";
import { z } from "zod";

export const McpServerConfigSchema = z.object({
  name: z.string().regex(/^[a-z0-9_]+$/),
  command: z.string(),
  args: z.array(z.string()).default([]),
  env: z.record(z.string()).optional(),
}).strict();
export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;

export const McpConfigSchema = z.object({
  servers: z.array(McpServerConfigSchema).default([]),
}).strict();

export function loadMcpConfig(path = "config/mcp.json"): McpServerConfig[] {
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = McpConfigSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      console.error(`[mcp-config] ${path} schema invalid:`, parsed.error.format());
    }
    return parsed.success ? parsed.data.servers : [];
  } catch (err) {
    console.error(`[mcp-config] failed to load ${path}: ${(err as Error).message}`);
    return [];
  }
}
