import { existsSync, readFileSync } from "node:fs";
import { dirname, join, parse } from "node:path";
import type { LlmProvider } from "./provider.js";
import type { LlmConfig } from "./config.js";
import { AnthropicProvider } from "./anthropic-provider.js";
import { OpenAICompatibleProvider } from "./openai-provider.js";

export function createProvider(config: LlmConfig): LlmProvider {
  loadDotEnvIfPresent();
  const apiKey = process.env[config.apiKeyEnv];
  if (!apiKey) throw new Error(`env var ${config.apiKeyEnv} not set`);
  const opts = { apiKey, model: config.model, baseUrl: config.baseUrl, jsonMode: config.jsonMode };
  return config.provider === "anthropic"
    ? new AnthropicProvider(opts)
    : new OpenAICompatibleProvider(opts);
}

export function createProviderFromConfig(config: LlmConfig | null): LlmProvider {
  if (!config) throw new Error("LLM config missing: create config/llm.json before starting AI features");
  return createProvider(config);
}

function loadDotEnvIfPresent(): void {
  const path = findUp(".env");
  if (!path) return;
  const lines = readFileSync(path, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const raw = trimmed.slice(eq + 1).trim();
    process.env[key] ??= raw.replace(/^['"]|['"]$/g, "");
  }
}

function findUp(file: string, startDir = process.cwd()): string | null {
  let dir = startDir;
  const root = parse(dir).root;
  while (true) {
    const candidate = join(dir, file);
    if (existsSync(candidate)) return candidate;
    if (dir === root) return null;
    dir = dirname(dir);
  }
}
