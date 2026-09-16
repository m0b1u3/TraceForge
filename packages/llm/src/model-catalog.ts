import type { LlmEndpointConfig } from "./config.js";
import { modelConnectionFetch, normalizeModelConnection, type ModelConnectionDependencies } from "./connections.js";
import { profileFromCatalog } from "./model-profile.js";
import type { ModelCatalogEntry } from "@traceforge/shared/model-profile";

export interface ModelCatalog { models: ModelCatalogEntry[]; truncated: boolean }
export class ModelCatalogError extends Error {
  constructor(readonly code: "unauthorized" | "unsupported" | "rate_limited" | "unavailable" | "invalid_response") { super(code); }
}

/** Discovery is metadata, not inference or proof of model capabilities. Credentials
 * stay in the connection transport; no cross-origin fallback or guessed models. */
export async function discoverModels(input: LlmEndpointConfig, dependencies: ModelConnectionDependencies = {}, signal?: AbortSignal): Promise<ModelCatalog> {
  const config = normalizeModelConnection(input);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  const requestSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    requestSignal.throwIfAborted();
    if (!config.credentialRef && !config.apiKey) throw new ModelCatalogError("unauthorized");
    const base = config.baseUrl!.replace(/\/+$/, "");
    const path = config.provider === "anthropic" ? "/v1/models" : "/models";
    const headers: Record<string, string> = { accept: "application/json" };
    if (config.provider === "anthropic") headers["anthropic-version"] = "2023-06-01";
    if (!config.credentialRef) headers[config.provider === "anthropic" && config.authMode !== "bearer" ? "x-api-key" : "authorization"] =
      config.provider === "anthropic" && config.authMode !== "bearer" ? config.apiKey! : `Bearer ${config.apiKey}`;
    const response = await modelConnectionFetch(config, dependencies)(base + path, { method: "GET", headers, signal: requestSignal });
    if (!response.ok) {
      await response.body?.cancel();
      throw new ModelCatalogError([401, 403].includes(response.status) ? "unauthorized" : [404, 405, 501].includes(response.status) ? "unsupported" : response.status === 429 ? "rate_limited" : "unavailable");
    }
    if (!response.body) throw new ModelCatalogError("invalid_response");
    reader = response.body.getReader();
    let size = 0; let text = ""; const decoder = new TextDecoder();
    for (;;) {
      requestSignal.throwIfAborted();
      const part = await reader.read(); if (part.done) break;
      size += part.value.byteLength;
      if (size > 1024 * 1024) throw new ModelCatalogError("invalid_response");
      text += decoder.decode(part.value, { stream: true });
    }
    text += decoder.decode();
    requestSignal.throwIfAborted();
    const value = JSON.parse(text);
    if (!value || !Array.isArray(value.data) || value.data.length > 10000) throw new ModelCatalogError("invalid_response");
    const ids = new Map<string, ModelCatalogEntry>();
    for (const model of value.data) {
      if (!model || typeof model.id !== "string" || !model.id || model.id.length > 200 || /[\s\x00-\x1f\x7f]/.test(model.id)) throw new ModelCatalogError("invalid_response");
      const profile=profileFromCatalog(model,config);
      if (ids.has(model.id)) {
        if (JSON.stringify(ids.get(model.id)?.profile) !== JSON.stringify(profile)) ids.set(model.id,{id:model.id});
      } else ids.set(model.id,{id:model.id,...(profile ? {profile} : {})});
    }
    return { models: [...ids.values()].sort((a,b)=>a.id.localeCompare(b.id)).slice(0, 1000), truncated: value.has_more === true || ids.size > 1000 };
  } catch (error) { throw error instanceof ModelCatalogError ? error : new ModelCatalogError("unavailable"); }
  finally { clearTimeout(timer); await reader?.cancel().catch(() => {}); reader?.releaseLock(); }
}
