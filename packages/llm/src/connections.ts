import type { LlmEndpointConfig } from "./config.js";
import type { ModelProtocol, ModelSupplier } from "@traceforge/shared/model-protocol";
export type { ModelSupplier } from "@traceforge/shared/model-protocol";

/** Vendor metadata is separate from wire protocols and from cognitive/execution policy. */
export const MODEL_SUPPLIERS = Object.freeze({
  deepseek: { protocol: "openai", baseUrl: "https://api.deepseek.com", jsonMode: "json_object" },
  xai: { protocol: "openai", baseUrl: "https://api.x.ai/v1", jsonMode: "json_schema" },
  kimi: { protocol: "openai", baseUrl: "https://api.moonshot.cn/v1", jsonMode: "json_object" },
  glm: { protocol: "openai", baseUrl: "https://open.bigmodel.cn/api/paas/v4", jsonMode: "json_object" },
} as const satisfies Record<ModelSupplier, { protocol: ModelProtocol; baseUrl: string; jsonMode: "json_schema" | "json_object" }>);

export interface ModelCredential {
  value: string;
  /** Exact API origin AND path prefix authorized for this credential. */
  baseUrl: string;
  expiresAt?: number;
}
export interface ModelCredentialResolver {
  resolve(reference: string, signal?: AbortSignal): Promise<ModelCredential>;
}
export interface ModelConnectionDependencies {
  credentials?: ModelCredentialResolver;
  fetch?: typeof fetch;
  now?: () => number;
}

export function normalizeModelConnection(config: LlmEndpointConfig): LlmEndpointConfig {
  const preset = config.supplier ? MODEL_SUPPLIERS[config.supplier] : undefined;
  // A supplier is metadata, not a protocol constraint. Explicit protocol choice
  // must survive preset selection (compatible endpoints may expose several APIs).
  const baseUrl = config.baseUrl ?? preset?.baseUrl ?? (config.provider === "anthropic" ? "https://api.anthropic.com" : "https://api.openai.com/v1");
  validateEndpoint(baseUrl);
  if (config.credentialRef && config.apiKey) throw new Error("Choose either a credential reference or an API key");
  return { ...config, baseUrl, jsonMode: config.jsonMode ?? preset?.jsonMode };
}

export function validateEndpoint(value: string): URL {
  let url: URL; try { url = new URL(value); } catch { throw new Error("Invalid model API endpoint"); }
  if (url.username || url.password || url.search || url.hash
    || !(url.protocol === "https:" || (url.protocol === "http:" && ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname)))) {
    throw new Error("Model endpoint requires HTTPS, or explicit loopback HTTP, without credentials/query/fragment");
  }
  return url;
}

/** Every SDK request resolves credentials afresh. No account tokens enter prompts/config views. */
export function modelConnectionFetch(config: LlmEndpointConfig, dependencies: ModelConnectionDependencies = {}): typeof fetch {
  const endpoint = validateEndpoint(config.baseUrl!);
  const transport = dependencies.fetch ?? globalThis.fetch;
  return async (input, init) => {
    const request = new Request(input, init);
    const target = new URL(request.url);
    if (!within(target, endpoint)) throw new Error("Model request escaped its configured endpoint");
    request.signal.throwIfAborted();
    const headers = new Headers(request.headers);
    // Let the selected Fetch implementation frame the reconstructed body. SDK
    // content-length metadata may not survive a cross-implementation Request.
    headers.delete("content-length");
    if (config.credentialRef) {
      if (!dependencies.credentials) throw new Error("Managed model credential resolver is not configured");
      const credential = await dependencies.credentials.resolve(config.credentialRef, request.signal);
      request.signal.throwIfAborted();
      if (!within(target, validateEndpoint(credential.baseUrl))) throw new Error("Model credential is not authorized for this endpoint");
      if (!credential.value || /[\r\n]/.test(credential.value) || (credential.expiresAt !== undefined
        && (!Number.isFinite(credential.expiresAt) || credential.expiresAt <= (dependencies.now?.() ?? Date.now())))) throw new Error("Model credential is invalid or expired");
      headers.delete("authorization"); headers.delete("x-api-key");
      headers.set(config.provider === "anthropic" && config.authMode !== "bearer" ? "x-api-key" : "authorization",
        config.provider === "anthropic" && config.authMode !== "bearer" ? credential.value : `Bearer ${credential.value}`);
    } else if (config.authMode === "bearer" && config.provider === "anthropic") {
      headers.delete("x-api-key"); headers.set("authorization", `Bearer ${config.apiKey}`);
    }
    // Never follow credential-bearing redirects to another host or path.
    const response = await transport(new Request(request, { headers, redirect: "manual" }));
    if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); throw new Error("Model API redirect rejected"); }
    return response;
  };
}
function within(target: URL, base: URL) {
  const prefix = base.pathname.replace(/\/+$/, "");
  return target.origin === base.origin && (target.pathname === prefix || target.pathname.startsWith(`${prefix}/`));
}
