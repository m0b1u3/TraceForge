import { existsSync, readFileSync } from "node:fs";
import { createProviderFromConfig, loadLlmConfig, type LlmProvider } from "@traceforge/llm";

export function realLlmProviderForTest(): LlmProvider {
  loadDotEnvIfPresent();
  return createProviderFromConfig(loadLlmConfig());
}

function loadDotEnvIfPresent(): void {
  if (!existsSync(".env")) return;
  const lines = readFileSync(".env", "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const raw = trimmed.slice(eq + 1).trim();
    const value = raw.replace(/^['"]|['"]$/g, "");
    process.env[key] ??= value;
  }
}
