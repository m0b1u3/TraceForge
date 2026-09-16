import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { LlmConfigSchema, type LlmConfig, type LlmEndpointConfig, createProvider, type LlmProvider, normalizeModelConnection, type ModelCredentialResolver, MODEL_SUPPLIERS } from "@traceforge/llm";
import { ProviderHolder } from "./provider-holder.js";
import type { ModelGateway } from "@traceforge/llm";
import { discoverModels } from "@traceforge/llm";

export interface LlmConfigDto {
  provider: LlmEndpointConfig["provider"];
  supplier?: LlmEndpointConfig["supplier"];
  credentialRef?: string;
  authMode?: LlmEndpointConfig["authMode"];
  requestOptions?: LlmEndpointConfig["requestOptions"];
  modelProfile?: LlmEndpointConfig["modelProfile"];
  model: string;
  embeddingModel?: string;
  baseUrl?: string;
  apiKey?: string;
  jsonMode?: "json_schema" | "json_object";
  contextWindowTokens?: number | null;
  maxOutputTokens?: number | null;
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
  /** Retain the metadata-selected generation while publishing the next one. */
  generations?: Record<string, { primary?: string; alternativeRoutes: Record<string, string> }>;
}

/** Secret persistence belongs to the trusted embedding host, never the HTTP/UI layer. */
export interface LlmSecretStore {
  load(): LlmSecretBundle;
  save(secrets: LlmSecretBundle): void;
}

export interface LlmConfigServiceDeps {
  secretStore: LlmSecretStore;
  gateway?: Pick<ModelGateway, "createProvider"> & Partial<Pick<ModelGateway, "discoverModels">>;
  createProvider?: (config: LlmEndpointConfig) => LlmProvider;
  credentials?: ModelCredentialResolver;
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
  private testing = false;

  constructor(private configPath: string, private deps: LlmConfigServiceDeps) {
    this.createProvider = deps.createProvider ?? (config => deps.gateway
      ? deps.gateway.createProvider(config) : createProvider(config, { credentials: deps.credentials }));
    this.holder = new ProviderHolder(() => {
      const provider = this.currentProviders.get("primary");
      if (!provider) throw new Error("LLM provider not initialized");
      return provider;
    });
  }

  load(): LlmConfigView { return configView(this.parseConfig()); }
  settings() {
    const current = this.readConfig();
    return { configured: current !== null, config: current ? configView(current) : null,
      revision: createHash("sha256").update(JSON.stringify(current)).digest("hex"), scope: "host" as const };
  }
  connectionCatalog() { return structuredClone(MODEL_SUPPLIERS); }
  async discover(dto: LlmConfigDto) {
    const config = this.buildConfig({ ...dto, model: "catalog-discovery", modelProfile: null });
    return this.deps.gateway?.discoverModels ? this.deps.gateway.discoverModels(config)
      : discoverModels(config, { credentials: this.deps.credentials });
  }

  initializeFromConfig(): LlmConfigView {
    const config = this.parseConfig();
    this.applyConfig(config);
    return configView(config);
  }

  private buildConfig(dto: LlmConfigDto): LlmConfig {
    if (typeof dto.model !== "string" || !dto.model.trim() || dto.model.length > 200) throw new Error("invalid model");
    const existing = this.readConfig();
    const previous = existing ? normalizeModelConnection(existing) : undefined;
    const destination = normalizeModelConnection({ provider: dto.provider, supplier: dto.supplier, model: dto.model, baseUrl: dto.baseUrl });
    const sameDestination = previous?.provider === destination.provider && previous?.baseUrl?.replace(/\/+$/, "") === destination.baseUrl?.replace(/\/+$/, "");
    const sameModel = sameDestination && previous?.model === dto.model;
    const apiKey = dto.credentialRef ? undefined : dto.apiKey ?? (sameDestination ? existing?.apiKey : undefined);
    if (apiKey) validateApiKeyValue(apiKey);
    const config: LlmConfig = {
      provider: dto.provider,
      supplier: dto.supplier,
      credentialRef: dto.credentialRef,
      authMode: dto.authMode,
      requestOptions: dto.requestOptions,
      modelProfile: dto.modelProfile === undefined ? (sameModel ? existing?.modelProfile : undefined) : dto.modelProfile,
      model: dto.model,
      embeddingModel: dto.embeddingModel?.trim() || (sameDestination ? existing?.embeddingModel : undefined),
      baseUrl: dto.baseUrl,
      apiKey,
      jsonMode: dto.jsonMode,
      contextWindowTokens: dto.contextWindowTokens === null ? undefined : dto.contextWindowTokens ?? (sameModel ? existing?.contextWindowTokens : undefined),
      maxOutputTokens: dto.maxOutputTokens === null ? undefined : dto.maxOutputTokens ?? (sameModel ? existing?.maxOutputTokens : undefined),
      currency: dto.currency === null ? undefined : (dto.currency?.trim().toUpperCase() ?? (sameModel ? existing?.currency : undefined)),
      inputPricePerMillion: dto.inputPricePerMillion === null ? undefined : (dto.inputPricePerMillion ?? (sameModel ? existing?.inputPricePerMillion : undefined)),
      outputPricePerMillion: dto.outputPricePerMillion === null ? undefined : (dto.outputPricePerMillion ?? (sameModel ? existing?.outputPricePerMillion : undefined)),
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
    const providers = this.prepareProviders(config);
    const stored = this.deps.secretStore.load();
    let previousGeneration: string | undefined;
    try { previousGeneration = JSON.parse(readFileSync(this.configPath, "utf8")).secretGeneration; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const generation = randomBytes(16).toString("hex");
    const generations = { ...(previousGeneration && stored.generations?.[previousGeneration] ? { [previousGeneration]: stored.generations[previousGeneration] } : {}),
      [generation]: this.extractSecrets(config) };
    // Keep legacy root secrets unchanged: old metadata must still resolve the old
    // key if power is lost after secret persistence but before metadata publish.
    this.deps.secretStore.save({ primary: stored.primary, alternativeRoutes: stored.alternativeRoutes, generations });
    this.writeMetadata({ ...withoutSecrets(config), secretGeneration: generation });
    this.publishProviders(config, providers);
    return configView(config);
  }

  async test(dto: LlmConfigDto): Promise<{ ok: boolean; message?: string; error?: string }> {
    if (this.testing) return { ok: false, error: "已有连接测试正在进行，请稍后重试。" };
    this.testing = true;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const provider = this.createProvider(this.buildConfig(dto));
      const result = await Promise.race([provider.extractJson({
        system: "You are a connectivity tester. Reply only with a JSON object {\"ok\": true}.",
        user: "ping",
        schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
        signal: controller.signal,
      }), new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error("timeout")); }, 30000); })]);
      return (result as { ok?: boolean }).ok === true
        ? { ok: true, message: "Connection successful" }
        : { ok: false, error: "Connection failed: provider did not confirm" };
    } catch { return { ok: false, error: controller.signal.aborted ? "连接测试超时。请检查端点后重试。" : "连接测试失败。请检查协议、端点、模型 ID、密钥及账号 API 权限。" }; }
    finally { if (timer) clearTimeout(timer); this.testing = false; }
  }

  getProvider(): LlmProvider { return this.holder; }
  /** Snapshot for a single text generation; configuration edits affect subsequent requests only. */
  getConversationProvider(): LlmProvider {
    const provider = this.currentProviders.get("primary");
    if (!provider) throw new Error("Model not configured");
    return provider;
  }
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
    this.publishProviders(config, this.prepareProviders(config));
  }
  private prepareProviders(config: LlmConfig): Map<string, LlmProvider> {
    const providers = new Map<string, LlmProvider>();
    providers.set("primary", this.createProvider(config));
    for (const { id, ...route } of config.alternativeRoutes ?? []) providers.set(id, this.createProvider(route));
    return providers;
  }
  private publishProviders(config: LlmConfig, providers: Map<string, LlmProvider>): void {
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
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw Object.assign(new Error("LLM config not found"), { code: "LLM_CONFIG_NOT_FOUND" });
      throw error;
    }
    const parsed = LlmConfigSchema.safeParse(value);
    if (!parsed.success) throw new Error(`invalid LLM config: ${parsed.error.message}`);
    const bundle = this.deps.secretStore.load();
    const generation = (value as { secretGeneration?: unknown }).secretGeneration;
    if (generation !== undefined && (typeof generation !== "string" || !bundle.generations?.[generation])) throw new Error("Model secret generation unavailable");
    const loaded = typeof generation === "string" ? bundle.generations![generation]! : bundle;
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

  private writeMetadata(config: LlmConfig & { secretGeneration?: string }): void {
    mkdirSync(dirname(this.configPath), { recursive: true });
    const temporary = `${this.configPath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    writeFileSync(temporary, JSON.stringify(config, null, 2), { mode: 0o600, flag: "wx" });
    renameSync(temporary, this.configPath);
  }

  private readConfig(): LlmConfig | null {
    try { return this.parseConfig(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "LLM_CONFIG_NOT_FOUND") return null; throw error; }
  }
}
