import { ModelProfileSchema, type ModelProfile } from "@traceforge/shared/model-profile";
import type { LlmEndpointConfig } from "./config.js";
import { DOCUMENTED_MODEL_PROFILES } from "./model-profile-defaults.js";

const positive = (value: unknown, min: number, max: number): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max ? value : undefined;
const boolean = (value: unknown): boolean | undefined => typeof value === "boolean" ? value : undefined;

/** Allowlisted directory fields only. No name matching, prompt text or inference. */
export function profileFromCatalog(model: Record<string, any>, config: LlmEndpointConfig): ModelProfile | undefined {
  const contextWindowTokens = positive(model.context_length ?? model.max_input_tokens, 1024, 100000000);
  const maxOutputTokens = positive(model.max_output_tokens ?? (config.provider === "anthropic" ? model.max_tokens : model.top_provider?.max_completion_tokens), 1, 10000000);
  const parameters = Array.isArray(model.supported_parameters) && model.supported_parameters.every((value: unknown) => typeof value === "string") ? model.supported_parameters as string[] : undefined;
  const toolCalling = boolean(model.capabilities?.tools?.supported) ?? (parameters ? parameters.includes("tools") : undefined);
  const reasoning = boolean(model.capabilities?.thinking?.supported) ?? (parameters ? parameters.includes("reasoning") || parameters.includes("reasoning_effort") : undefined);
  const adaptiveThinking = boolean(model.capabilities?.thinking?.types?.adaptive?.supported);
  const modalities=model.architecture?.input_modalities;
  const imageInput=Array.isArray(modalities)&&modalities.every((value:unknown)=>typeof value==="string")?modalities.includes("image"):undefined;
  const audioInput=Array.isArray(modalities)&&modalities.every((value:unknown)=>typeof value==="string")?modalities.includes("audio"):undefined;
  if ([contextWindowTokens,maxOutputTokens,toolCalling,reasoning,adaptiveThinking,imageInput,audioInput].every(value=>value === undefined)) {
    const documented=DOCUMENTED_MODEL_PROFILES.find(profile=>profile.model===model.id && profile.protocol===config.provider && profile.baseUrl===config.baseUrl?.replace(/\/+$/,""));
    return documented ? structuredClone(documented) : undefined;
  }
  return ModelProfileSchema.parse({model:model.id,baseUrl:config.baseUrl,protocol:config.provider,source:"catalog",contextWindowTokens,maxOutputTokens,toolCalling,reasoning,adaptiveThinking,imageInput,audioInput});
}

export function applyModelProfile(config: LlmEndpointConfig): LlmEndpointConfig {
  if (!config.modelProfile) return config;
  const profile=ModelProfileSchema.parse(config.modelProfile);
  if (profile.model !== config.model || profile.protocol !== config.provider || profile.baseUrl.replace(/\/+$/,"") !== config.baseUrl?.replace(/\/+$/,""))
    throw new Error("Model capability profile belongs to another connection");
  const contextWindowTokens=config.contextWindowTokens ?? profile.contextWindowTokens;
  const maxOutputTokens=config.maxOutputTokens ?? Math.min(4096,Math.floor((contextWindowTokens ?? 32768)/8),profile.maxOutputTokens ?? Infinity);
  if (profile.maxOutputTokens !== undefined && maxOutputTokens>profile.maxOutputTokens) throw new Error("Configured output exceeds declared model maximum");
  if (profile.reasoning === false && (config.requestOptions?.thinking === "enabled" || config.requestOptions?.reasoningEffort && config.requestOptions.reasoningEffort !== "none"))
    throw new Error("Declared model does not support reasoning");
  if (profile.adaptiveThinking === false && config.provider === "anthropic" && config.requestOptions?.thinking === "enabled")
    throw new Error("Declared model does not support adaptive thinking");
  return {...config,contextWindowTokens,maxOutputTokens};
}
