import { readFileSync, writeFileSync } from "node:fs";
import { LlmConfigSchema, type LlmConfig, type LlmEndpointConfig, createProvider, type LlmProvider } from "@traceforge/llm";
import { ProviderHolder } from "./provider-holder.js";

export interface LlmConfigDto {
  provider: "anthropic" | "openai";
  model: string;
  embeddingModel?: string;
  baseUrl?: string;
  apiKey?: string;
  jsonMode?: "json_schema" | "json_object";
  contextWindowTokens?: number;
  maxOutputTokens?: number;
  currency?: string | null;
  inputPricePerMillion?: number | null;
  outputPricePerMillion?: number | null;
}

type AlternativeRoute = NonNullable<LlmConfig["alternativeRoutes"]>[number];

export interface LlmConfigView extends Omit<LlmConfig, "apiKey" | "alternativeRoutes"> {
  apiKeyMasked: string;
  alternativeRoutes: Array<Omit<AlternativeRoute, "apiKey"> & { apiKeyMasked: string }>;
}

export interface LlmConfigServiceDeps {
  createProvider?: (config: LlmEndpointConfig) => LlmProvider;
}

function validateApiKeyValue(value: string): void {
  if (/[\r\n]/.test(value)) throw new Error("invalid apiKey: line breaks are not allowed");
}

function maskKey(key: string): string {
  if (!key) return "";
  return "••••••••";
}

function configView(config: LlmConfig): LlmConfigView {
  const { apiKey, alternativeRoutes, ...safe } = config;
  return {
    ...safe,
    apiKeyMasked: maskKey(apiKey ?? ""),
    alternativeRoutes: (alternativeRoutes ?? []).map(({ apiKey: routeKey, ...route }) => ({ ...route, apiKeyMasked: maskKey(routeKey ?? "") })),
  };
}

export class LlmConfigService {
  private holder: ProviderHolder;
  private readonly currentProviders = new Map<string, LlmProvider>();
  private configuredRouteIds = ["primary"];
  private rolePolicies: NonNullable<LlmConfig["rolePolicies"]> = {};
  private resourcePolicy: NonNullable<LlmConfig["resourcePolicy"]> = {};
  private createProvider: (config: LlmEndpointConfig) => LlmProvider;

  constructor(private configPath: string, private deps: LlmConfigServiceDeps = {}) {
    this.createProvider = deps.createProvider ?? createProvider;
    this.holder = new ProviderHolder(() => {
      const provider = this.currentProviders.get("primary");
      if (!provider) throw new Error("LLM provider not initialized");
      return provider;
    });
  }

  load(): LlmConfigView {
    return configView(this.parseConfig());
  }

  revealApiKey(): string {
    return this.parseConfig().apiKey ?? "";
  }

  initializeFromConfig(): LlmConfigView {
    const config = this.parseConfig();
    this.applyConfig(config);
    return configView(config);
  }

  private buildConfig(dto: LlmConfigDto): LlmConfig {
    const existing = this.readConfig();
    const apiKey = dto.apiKey ?? existing?.apiKey;
    if (apiKey) validateApiKeyValue(apiKey);
    const config: LlmConfig = {
      provider: dto.provider,
      model: dto.model,
      embeddingModel: dto.embeddingModel?.trim() || existing?.embeddingModel,
      baseUrl: dto.baseUrl,
      apiKey,
      jsonMode: dto.jsonMode,
      contextWindowTokens: dto.contextWindowTokens ?? existing?.contextWindowTokens,
      maxOutputTokens: dto.maxOutputTokens ?? existing?.maxOutputTokens,
      currency: dto.currency === null ? undefined : (dto.currency?.trim().toUpperCase() ?? existing?.currency),
      inputPricePerMillion: dto.inputPricePerMillion === null ? undefined : (dto.inputPricePerMillion ?? existing?.inputPricePerMillion),
      outputPricePerMillion: dto.outputPricePerMillion === null ? undefined : (dto.outputPricePerMillion ?? existing?.outputPricePerMillion),
      alternativeRoutes: existing?.alternativeRoutes ?? [],
      rolePolicies: existing?.rolePolicies ?? {},
      resourcePolicy: existing?.resourcePolicy,
    };
    const parsed = LlmConfigSchema.safeParse(config);
    if (!parsed.success) throw new Error(`invalid LLM config: ${parsed.error.message}`);
    return config;
  }

  reload(dto: LlmConfigDto): LlmConfigView {
    const config = this.buildConfig(dto);
    writeFileSync(this.configPath, JSON.stringify(config, null, 2));
    this.applyConfig(config);
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

  getModelRoutes(): ReadonlyMap<string, LlmProvider> {
    return new Map(this.configuredRouteIds.map((routeId) => [
      routeId,
      new ProviderHolder(() => {
        const provider = this.currentProviders.get(routeId);
        if (!provider) throw new Error(`LLM route ${routeId} is not initialized`);
        return provider;
      }),
    ]));
  }

  getRolePolicies(): NonNullable<LlmConfig["rolePolicies"]> {
    return this.rolePolicies;
  }

  getResourcePolicy(): NonNullable<LlmConfig["resourcePolicy"]> {
    return this.resourcePolicy;
  }

  hasProvider(): boolean {
    return this.currentProviders.has("primary");
  }

  private applyConfig(config: LlmConfig): void {
    const providers = new Map<string, LlmProvider>();
    providers.set("primary", this.createProvider(config));
    for (const { id, ...route } of config.alternativeRoutes ?? []) providers.set(id, this.createProvider(route));
    this.currentProviders.clear();
    for (const [id, provider] of providers) this.currentProviders.set(id, provider);
    this.configuredRouteIds = [...providers.keys()];
    this.rolePolicies = config.rolePolicies ?? {};
    this.resourcePolicy = config.resourcePolicy ?? {};
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
