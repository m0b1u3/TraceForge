import { readFileSync, writeFileSync } from "node:fs";
import { LlmConfigSchema, type LlmConfig, createProvider, type LlmProvider } from "@traceforge/llm";
import { ProviderHolder } from "./provider-holder.js";

export interface LlmConfigDto {
  provider: "anthropic" | "openai";
  model: string;
  baseUrl?: string;
  apiKey?: string;
  jsonMode?: "json_schema" | "json_object";
  contextWindowTokens?: number;
  maxOutputTokens?: number;
}

export interface LlmConfigView extends LlmConfig {
  apiKeyMasked: string;
}

function validateApiKeyValue(value: string): void {
  if (/[\r\n]/.test(value)) throw new Error("invalid apiKey: line breaks are not allowed");
}

function maskKey(key: string): string {
  if (!key) return "";
  return "••••••••";
}

export class LlmConfigService {
  private holder: ProviderHolder;
  private currentProvider: LlmProvider | null = null;

  constructor(private configPath: string) {
    this.holder = new ProviderHolder(() => {
      if (!this.currentProvider) throw new Error("LLM provider not initialized");
      return this.currentProvider;
    });
  }

  load(): LlmConfigView {
    const config = this.parseConfig();
    return { ...config, apiKeyMasked: maskKey(config.apiKey ?? "") };
  }

  initializeFromConfig(): LlmConfigView {
    const config = this.parseConfig();
    this.currentProvider = createProvider(config);
    return { ...config, apiKeyMasked: maskKey(config.apiKey ?? "") };
  }

  reload(dto: LlmConfigDto): LlmConfigView {
    const existing = this.readConfig();
    const apiKey = dto.apiKey ?? existing?.apiKey;
    if (apiKey) validateApiKeyValue(apiKey);
    const config: LlmConfig = {
      provider: dto.provider,
      model: dto.model,
      baseUrl: dto.baseUrl,
      apiKey,
      jsonMode: dto.jsonMode,
      contextWindowTokens: dto.contextWindowTokens ?? existing?.contextWindowTokens,
      maxOutputTokens: dto.maxOutputTokens ?? existing?.maxOutputTokens,
    };
    const parsed = LlmConfigSchema.safeParse(config);
    if (!parsed.success) throw new Error(`invalid LLM config: ${parsed.error.message}`);
    writeFileSync(this.configPath, JSON.stringify(config, null, 2));
    this.currentProvider = createProvider(config);
    return { ...config, apiKeyMasked: maskKey(config.apiKey ?? "") };
  }

  getProvider(): LlmProvider {
    return this.holder;
  }

  private parseConfig(): LlmConfig {
    let raw: string;
    try {
      raw = readFileSync(this.configPath, "utf8");
    } catch {
      throw new Error("LLM config not found");
    }
    const parsed = LlmConfigSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) throw new Error(`invalid LLM config: ${parsed.error.message}`);
    return parsed.data;
  }

  private readConfig(): LlmConfig | null {
    try {
      return this.parseConfig();
    } catch {
      return null;
    }
  }
}
