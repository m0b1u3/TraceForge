import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface DesktopPaths {
  root: string;
  database: string;
  configDirectory: string;
  llmConfig: string;
  mcpConfig: string;
}

export function resolveDesktopPaths(userData: string): DesktopPaths {
  const configDirectory = join(userData, "config");
  return {
    root: userData,
    database: join(userData, "traceforge.sqlite"),
    configDirectory,
    llmConfig: join(configDirectory, "llm.json"),
    mcpConfig: join(configDirectory, "mcp.json"),
  };
}

export function ensureDesktopData(paths: DesktopPaths): void {
  mkdirSync(paths.configDirectory, { recursive: true });
  if (!existsSync(paths.mcpConfig)) writeFileSync(paths.mcpConfig, JSON.stringify({ servers: [] }, null, 2), { mode: 0o600 });
}
