import { mkdirSync } from "node:fs";
import { join } from "node:path";

export interface DesktopPaths {
  root: string;
  database: string;
  configDirectory: string;
  llmConfig: string;
  llmSecrets: string;
  mcpConfig: string;
}

export function resolveDesktopPaths(userData: string): DesktopPaths {
  const configDirectory = join(userData, "config");
  return {
    root: userData,
    database: join(userData, "traceforge.sqlite"),
    configDirectory,
    llmConfig: join(configDirectory, "llm.json"),
    llmSecrets: join(configDirectory, "llm-secrets.bin"),
    mcpConfig: join(configDirectory, "mcp.json"),
  };
}

export function ensureDesktopData(paths: DesktopPaths): void {
  mkdirSync(paths.configDirectory, { recursive: true });
}
