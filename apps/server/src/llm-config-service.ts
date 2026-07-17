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
  currency?: string | null;
  inputPricePerMillion?: number | null;
  outputPricePerMillion?: number | null;
}

export interface LlmConfigView extends Omit<LlmConfig, "apiKey"> {
  apiKeyMasked: string;
}

export interface LlmConfigServiceDeps {
  createProvider?: (config: LlmConfig) => LlmProvider;
}

function validateApiKeyValue(value: string): void {
  if (/[\r\n]/.test(value)) throw new Error("invalid apiKey: line breaks are not allowed");
}

function maskKey(key: string): string {
  if (!key) return "";
  return "••••••••";
}

function configView(config: LlmConfig): LlmConfigView {
  const { apiKey, ...safe } = config;
  return { ...safe, apiKeyMasked: maskKey(apiKey ?? "") };
}

export class LlmConfigService {
  private holder: ProviderHolder;
  private currentProvider: LlmProvider | null = null;
  private createProvider: (config: LlmConfig) => LlmProvider;

  constructor(private configPath: string, private deps: LlmConfigServiceDeps = {}) {
    this.createProvider = deps.createProvider ?? createProvider;
    this.holder = new ProviderHolder(() => {
      if (!this.currentProvider) throw new Error("LLM provider not initialized");
      return this.currentProvider;
    });
  }

  load(): LlmConfigView {
    return configView(this.parseConfig());
  }

  initializeFromConfig(): LlmConfigView {
    const config = this.parseConfig();
    this.currentProvider = this.createProvider(config);
    return configView(config);
  }

  private buildConfig(dto: LlmConfigDto): LlmConfig {
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
      currency: dto.currency === null ? undefined : (dto.currency?.trim().toUpperCase() ?? existing?.currency),
      inputPricePerMillion: dto.inputPricePerMillion === null ? undefined : (dto.inputPricePerMillion ?? existing?.inputPricePerMillion),
      outputPricePerMillion: dto.outputPricePerMillion === null ? undefined : (dto.outputPricePerMillion ?? existing?.outputPricePerMillion),
    };
    const parsed = LlmConfigSchema.safeParse(config);
    if (!parsed.success) throw new Error(`invalid LLM config: ${parsed.error.message}`);
    return config;
  }

  reload(dto: LlmConfigDto): LlmConfigView {
    const config = this.buildConfig(dto);
    writeFileSync(this.configPath, JSON.stringify(config, null, 2));
    this.currentProvider = this.createProvider(config);
    return configView(config);
  }

  async test(dto: LlmConfigDto): Promise<{ ok: boolean; message?: string; error?: string }> {
    try {
      const config = this.buildConfig(dto);
      const provider = this.createProvider(config);
      const result = await provider.extractJson({
        system: "You are a connectivity tester. Reply only with a JSON object {\"ok\": true}.",
        user: "ping",
        schema: {
          type: "object",
          properties: { ok: { type: "boolean" } },
          required: ["ok"],
        },
      });
      if ((result as { ok?: boolean }).ok === true) {
        return { ok: true, message: "Connection successful" };
      }
      return { ok: false, error: "Connection failed: provider did not confirm" };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
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
