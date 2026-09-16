import type { ModelProtocol, ModelSupplier } from "@traceforge/shared/model-protocol";
import { ModelProfileSchema, type ModelProfile, type ModelCatalogEntry } from "@traceforge/shared/model-profile";

export interface ModelSettingsBridge {
  protocolVersion: 1;
  request(input: { operation: "load" | "save" | "test" | "account" | "open-login" | "discover"; payload?: unknown }): Promise<{ status: number; body: unknown }>;
}
export interface ModelConfigInput {
  provider: ModelProtocol; supplier?: ModelSupplier;
  model: string; baseUrl: string; apiKey?: string; credentialRef?: string; authMode?: "api_key" | "bearer";
  jsonMode?: "json_schema" | "json_object"; contextWindowTokens?: number | null; maxOutputTokens?: number | null;
  modelProfile?: ModelProfile | null;
  requestOptions?: { thinking?: "enabled" | "disabled"; reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high" | "max"; temperature?: number; includeReasoningContinuation?: boolean };
}
export interface ModelSettingsSnapshot {
  accounts?: ModelAccountView[];
  configured: boolean; revision: string; scope: "host";
  config: (Omit<ModelConfigInput, "apiKey"> & { apiKeyMasked: string; credentialRef?: string }) | null;
  suppliers: Record<string, { label?: string; group?: "domestic" | "international" | "coding"; note?: string; requestOptions?: ModelConfigInput["requestOptions"]; protocol: ModelProtocol; baseUrl: string; jsonMode: "json_schema" | "json_object" }>;
}
export interface ModelAccountView {
  id: string; label: string; provider: ModelConfigInput["provider"]; baseUrl: string; issuer: string; scopes: string[];
  status: "signed_out" | "connected" | "refresh_required";
}
export interface ModelLoginView { userCode: string; verificationUrl: string; expiresAt: number; intervalMs: number }
export class ModelSettingsClient {
  constructor(private bridge: ModelSettingsBridge) { if (bridge.protocolVersion !== 1) throw new Error("模型设置桥版本不兼容。"); }
  private async request(operation: "load" | "save" | "test" | "account" | "open-login" | "discover", payload?: unknown) {
    let response;
    try { response = await this.bridge.request({ operation, ...(payload === undefined ? {} : { payload }) }); }
    catch { throw new Error("宿主未返回确认结果。请重新读取配置核对，不要假定已保存。"); }
    if (response.status === 409) throw new Error(operation === "account" ? "账号操作未确认。请刷新状态核对，必要时重新登录。" : "配置已被其他操作改变。请重新读取后再保存。");
    if (response.status < 200 || response.status >= 300) {
      if (operation === "discover") {
        const messages: Record<string, string> = { unauthorized: "当前凭据无权读取模型列表，请核对账号登录或 API 密钥。", unsupported: "此端点未提供标准模型目录，可以手动填写模型 ID。", rate_limited: "模型目录请求被限流，请稍后刷新。" };
        throw new Error(messages[(response.body as { error?: string })?.error ?? ""] ?? "未能获取模型列表。请检查网络或端点，稍后刷新；也可以手动填写。");
      }
      throw new Error("操作未完成。请检查配置、安全存储并重新读取核对。");
    }
    return response.body;
  }
  private snapshot(raw: unknown): ModelSettingsSnapshot {
    const value = raw as ModelSettingsSnapshot;
    if (!value || typeof value.configured !== "boolean" || value.scope !== "host" || !/^[a-f0-9]{64}$/.test(value.revision) || !value.suppliers || typeof value.suppliers !== "object" ||
      value.configured !== (value.config !== null) || value.config && (typeof value.config.model !== "string" || typeof value.config.apiKeyMasked !== "string" || "apiKey" in value.config)) throw new Error("模型配置回执无效，未更新界面。");
    return value;
  }
  async load() { return this.snapshot(await this.request("load")); }
  async discover(expectedRevision: string, config: ModelConfigInput): Promise<{ models: ModelCatalogEntry[]; truncated: boolean }> {
    const value = await this.request("discover", { expectedRevision, config }) as { models?: ModelCatalogEntry[]; truncated?: boolean };
    if (!value || !Array.isArray(value.models) || value.models.length > 1000 || typeof value.truncated !== "boolean" ||
      value.models.some(model => !model || typeof model.id !== "string" || !model.id || model.id.length > 200 || /[\s\x00-\x1f\x7f]/.test(model.id))) throw new Error("模型目录回执无效，可以刷新或手动填写。");
    return { models: value.models.map(({ id, profile }) => {
      if (!profile) return {id};
      const parsed=ModelProfileSchema.safeParse(profile);
      if (!parsed.success || parsed.data.model !== id || parsed.data.protocol !== config.provider || parsed.data.baseUrl.replace(/\/+$/,"") !== config.baseUrl.replace(/\/+$/,""))
        throw new Error("模型能力回执与当前连接不匹配，请重新读取。");
      return {id,profile:parsed.data};
    }), truncated: value.truncated };
  }
  async openLogin(id: string) {
    const result = await this.request("open-login", { id }) as { opened?: boolean };
    if (result?.opened !== true) throw new Error("未确认浏览器已打开，请手动打开授权地址。");
  }
  async account(operation: "begin" | "poll" | "cancel" | "disconnect", id: string): Promise<{ state: string; login?: ModelLoginView }> {
    const raw = await this.request("account", { operation, id }) as { state?: unknown; login?: ModelLoginView };
    if (!raw || typeof raw.state !== "string" || !["pending", "connected", "canceled", "signed_out"].includes(raw.state)) throw new Error("账号操作回执无效，请刷新核对。");
    if (operation === "begin") {
      const login = raw.login;
      if (!login || typeof login.userCode !== "string" || login.userCode.length > 16384 || !Number.isFinite(login.expiresAt) ||
        !Number.isFinite(login.intervalMs) || login.intervalMs < 1000 || login.intervalMs > 60000) throw new Error("登录回执无效。");
      const url = new URL(login.verificationUrl);
      if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error("登录地址无效。");
    }
    return { state: raw.state, login: raw.login };
  }
  async save(expectedRevision: string, config: ModelConfigInput) { return this.snapshot(await this.request("save", { expectedRevision, config })); }
  async test(expectedRevision: string, config: ModelConfigInput): Promise<boolean> {
    const result = await this.request("test", { expectedRevision, config }) as { ok?: unknown; scope?: string; saved?: unknown };
    if (typeof result?.ok !== "boolean" || result.scope !== "structured_ping" || result.saved !== false) throw new Error("连接测试回执无效。");
    return result.ok;
  }
}
