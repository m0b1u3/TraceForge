import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
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

export interface LlmSecretBundle {
  primary?: string;
  alternativeRoutes: Record<string, string>;
}

/** Secret persistence belongs to the trusted embedding host, never the HTTP/UI layer. */
export interface LlmSecretStore {
  load(): LlmSecretBundle;
  save(secrets: LlmSecretBundle): void;
}

export interface LlmConfigServiceDeps {
  secretStore: LlmSecretStore;
  createProvider?: (config: LlmEndpointConfig) => LlmProvider;
}

function validateApiKeyValue(value: string): void {
  if (/\r|\n/.test(value)) throw new Error("invalid apiKey: line breaks are not allowed");
}

function maskKey(key: string): string { return key ? "••••••••" : ""; }

function configView(config: LlmConfig): LlmConfigView {
  const { apiKey, alternativeRoutes, ...safe } = config;
  return {
    ...safe,
    apiKeyMasked: maskKey(apiKey ?? ""),
    alternativeRoutes: (alternativeRoutes ?? []).map(({ apiKey: routeKey, ...route }) => ({ ...route, apiKeyMasked: maskKey(routeKey ?? "") })),
  };
}

function withoutSecrets(config: LlmConfig): LlmConfig {
  const { apiKey: _primary, alternativeRoutes, ...metadata } = config;
  return { ...metadata, alternativeRoutes: (alternativeRoutes ?? []).map(({ apiKey: _secret, ...route }) => route) };
}

export class LlmConfigService {
  private holder: ProviderHolder;
  private readonly currentProviders = new Map<string, LlmProvider>();
  private configuredRouteIds = ["primary"];
  private rolePolicies: NonNullable<LlmConfig["rolePolicies"]> = {};
  private resourcePolicy: NonNullable<LlmConfig["resourcePolicy"]> = {};
  private createProvider: (config: LlmEndpointConfig) => LlmProvider;

  constructor(private configPath: string, private deps: LlmConfigServiceDeps) {
    this.createProvider = deps.createProvider ?? createProvider;
    this.holder = new ProviderHolder(() => {
      const provider = this.currentProviders.get("primary");
      if (!provider) throw new Error("LLM provider not initialized");
      return provider;
    });
  }

  load(): LlmConfigView { return configView(this.parseConfig()); }

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
    return parsed.data;
  }

  reload(dto: LlmConfigDto): LlmConfigView {
    const config = this.buildConfig(dto);
    this.applyConfig(config);
    this.deps.secretStore.save(this.extractSecrets(config));
    this.writeMetadata(withoutSecrets(config));
    return configView(config);
  }

  async test(dto: LlmConfigDto): Promise<{ ok: boolean; message?: string; error?: string }> {
    try {
      const provider = this.createProvider(this.buildConfig(dto));
      const result = await provider.extractJson({
        system: "You are a connectivity tester. Reply only with a JSON object {\"ok\": true}.",
        user: "ping",
        schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
      });
      return (result as { ok?: boolean }).ok === true
        ? { ok: true, message: "Connection successful" }
        : { ok: false, error: "Connection failed: provider did not confirm" };
    } catch (err) { return { ok: false, error: (err as Error).message }; }
  }

  getProvider(): LlmProvider { return this.holder; }
  getModelRoutes(): ReadonlyMap<string, LlmProvider> {
    return new Map(this.configuredRouteIds.map((routeId) => [routeId, new ProviderHolder(() => {
      const provider = this.currentProviders.get(routeId);
      if (!provider) throw new Error(`LLM route ${routeId} is not initialized`);
      return provider;
    })]));
  }
  getRolePolicies(): NonNullable<LlmConfig["rolePolicies"]> { return this.rolePolicies; }
  getResourcePolicy(): NonNullable<LlmConfig["resourcePolicy"]> { return this.resourcePolicy; }
  hasProvider(): boolean { return this.currentProviders.has("primary"); }

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
    let value: unknown;
    try { value = JSON.parse(readFileSync(this.configPath, "utf8")); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("LLM config not found");
      throw error;
    }
    const parsed = LlmConfigSchema.safeParse(value);
    if (!parsed.success) throw new Error(`invalid LLM config: ${parsed.error.message}`);
    const loaded = this.deps.secretStore.load();
    const stored = { primary: loaded.primary, alternativeRoutes: { ...(loaded.alternativeRoutes ?? {}) } };
    const legacy = this.extractSecrets(parsed.data);
    const migrated = Boolean(legacy.primary || Object.keys(legacy.alternativeRoutes).length);
    const secrets: LlmSecretBundle = {
      primary: legacy.primary ?? stored.primary,
      alternativeRoutes: { ...stored.alternativeRoutes, ...legacy.alternativeRoutes },
    };
    if (migrated) {
      this.deps.secretStore.save(secrets);
      this.writeMetadata(withoutSecrets(parsed.data));
    }
    const combined = {
      ...parsed.data,
      apiKey: secrets.primary,
      alternativeRoutes: (parsed.data.alternativeRoutes ?? []).map((route) => ({ ...route, apiKey: secrets.alternativeRoutes[route.id] })),
    };
    const validated = LlmConfigSchema.safeParse(combined);
    if (!validated.success) throw new Error(`invalid LLM config: ${validated.error.message}`);
    return validated.data;
  }

  private extractSecrets(config: LlmConfig): LlmSecretBundle {
    return {
      primary: config.apiKey,
      alternativeRoutes: Object.fromEntries((config.alternativeRoutes ?? [])
        .filter((route) => Boolean(route.apiKey)).map((route) => [route.id, route.apiKey!])),
    };
  }

  private writeMetadata(config: LlmConfig): void {
    mkdirSync(dirname(this.configPath), { recursive: true });
    const temporary = `${this.configPath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    writeFileSync(temporary, JSON.stringify(config, null, 2), { mode: 0o600, flag: "wx" });
    renameSync(temporary, this.configPath);
  }

  private readConfig(): LlmConfig | null {
    try { return this.parseConfig(); }
    catch { return null; }
  }
}
