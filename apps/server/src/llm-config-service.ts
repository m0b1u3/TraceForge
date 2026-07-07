import { readFileSync, writeFileSync } from "node:fs";
import { LlmConfigSchema, type LlmConfig, createProvider, type LlmProvider } from "@traceforge/llm";
import { ProviderHolder } from "./provider-holder.js";

export interface LlmConfigDto {
  provider: "anthropic" | "openai";
  model: string;
  baseUrl?: string;
  apiKey?: string;
  jsonMode?: "json_schema" | "json_object";
  apiKeyEnv?: string;
  contextWindowTokens?: number;
  maxOutputTokens?: number;
}

export interface LlmConfigView extends LlmConfig {
  apiKeyMasked: string;
}

function defaultApiKeyEnv(provider: "anthropic" | "openai"): string {
  return provider === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY";
}

function validateApiKeyEnv(key: string): void {
  if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) throw new Error("invalid apiKeyEnv: use A-Z, 0-9, and underscores only");
}

function validateApiKeyValue(value: string): void {
  if (/[\r\n]/.test(value)) throw new Error("invalid apiKey: line breaks are not allowed");
}

function maskKey(key: string): string {
  if (!key) return "";
  return "••••••••";
}

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export class LlmConfigService {
  private holder: ProviderHolder;
  private currentProvider: LlmProvider | null = null;

  constructor(
    private configPath: string,
    private envPath: string,
  ) {
    this.holder = new ProviderHolder(() => {
      if (!this.currentProvider) throw new Error("LLM provider not initialized");
      return this.currentProvider;
    });
  }

  load(): LlmConfigView {
    const raw = readFileSync(this.configPath, "utf8");
    const parsed = LlmConfigSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) throw new Error(`invalid LLM config: ${parsed.error.message}`);
    const key = this.readEnvValue(parsed.data.apiKeyEnv);
    return { ...parsed.data, apiKeyMasked: maskKey(key ?? "") };
  }

  initializeFromConfig(): LlmConfigView {
    const raw = readFileSync(this.configPath, "utf8");
    const parsed = LlmConfigSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) throw new Error(`invalid LLM config: ${parsed.error.message}`);
    validateApiKeyEnv(parsed.data.apiKeyEnv);
    this.currentProvider = createProvider(parsed.data);
    const key = this.readEnvValue(parsed.data.apiKeyEnv);
    return { ...parsed.data, apiKeyMasked: maskKey(key ?? "") };
  }

  reload(dto: LlmConfigDto): LlmConfigView {
    const existing = this.readConfig();
    const sameProvider = existing?.provider === dto.provider;
    const apiKeyEnv = dto.apiKeyEnv || (sameProvider ? existing?.apiKeyEnv : undefined) || defaultApiKeyEnv(dto.provider);
    validateApiKeyEnv(apiKeyEnv);
    if (dto.apiKey) validateApiKeyValue(dto.apiKey);
    const config: LlmConfig = {
      provider: dto.provider,
      model: dto.model,
      baseUrl: dto.baseUrl,
      apiKeyEnv,
      jsonMode: dto.jsonMode,
      contextWindowTokens: dto.contextWindowTokens ?? existing?.contextWindowTokens,
      maxOutputTokens: dto.maxOutputTokens ?? existing?.maxOutputTokens,
    };
    const parsed = LlmConfigSchema.safeParse(config);
    if (!parsed.success) throw new Error(`invalid LLM config: ${parsed.error.message}`);
    writeFileSync(this.configPath, JSON.stringify(config, null, 2));
    if (dto.apiKey) {
      this.setEnvValue(apiKeyEnv, dto.apiKey);
      process.env[apiKeyEnv] = dto.apiKey;
    }
    this.currentProvider = createProvider(config);
    const key = this.readEnvValue(apiKeyEnv);
    return { ...config, apiKeyMasked: maskKey(key ?? "") };
  }

  getProvider(): LlmProvider {
    return this.holder;
  }

  private readConfig(): LlmConfig | null {
    try {
      const raw = readFileSync(this.configPath, "utf8");
      const parsed = LlmConfigSchema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  private readEnvValue(key: string): string | undefined {
    try {
      const text = readFileSync(this.envPath, "utf8");
      const match = new RegExp(`^${escapeRegExp(key)}=(.*)$`, "m").exec(text);
      return match ? match[1].trim().replace(/^['"]|['"]$/g, "") : undefined;
    } catch {
      return undefined;
    }
  }

  private setEnvValue(key: string, value: string): void {
    let text = "";
    try { text = readFileSync(this.envPath, "utf8"); } catch { /* missing file is ok */ }
    const lines = text.split(/\r?\n/);
    const pattern = new RegExp(`^${escapeRegExp(key)}=.*$`);
    let found = false;
    const updated = lines.map((line) => {
      if (pattern.test(line)) { found = true; return `${key}=${value}`; }
      return line;
    });
    if (!found) updated.push(`${key}=${value}`);
    writeFileSync(this.envPath, updated.join("\n") + (updated.length ? "\n" : ""));
  }
}
