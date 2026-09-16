import type { LlmProvider } from "./provider.js";
import type { LlmConfig, LlmEndpointConfig } from "./config.js";
import { MODEL_PROTOCOL_ADAPTERS } from "./protocol-adapters.js";
import { normalizeModelConnection, modelConnectionFetch, type ModelConnectionDependencies } from "./connections.js";
import { proxyFetch } from "@traceforge/shared/proxy";
import { withContextBudget } from "./context-budget-provider.js";
import { resolveContextBudget } from "@traceforge/shared/model-context";
import { applyModelProfile } from "./model-profile.js";
import { AttachmentInputError } from "@traceforge/shared/message-attachments";
import { attachmentContent } from "./attachment-content.js";

export function createProvider(input: LlmEndpointConfig, dependencies: ModelConnectionDependencies = {}): LlmProvider {
  const config = applyModelProfile(normalizeModelConnection(input));
  if (config.credentialRef && !dependencies.credentials) throw new Error("Managed model credential resolver is not configured");
  const apiKey = config.credentialRef ? "managed-credential-resolved-at-dispatch" : config.apiKey;
  if (!apiKey) throw new Error("apiKey is missing");
  if (/[\r\n]/.test(apiKey)) throw new Error("Invalid API key");
  const fetchImpl = modelConnectionFetch(config, { ...dependencies, fetch: dependencies.fetch ?? proxyFetch() ?? globalThis.fetch });
  const outputTokens = resolveContextBudget(config).output;
  const opts = { apiKey, model: config.model, embeddingModel: config.embeddingModel, baseUrl: config.baseUrl, jsonMode: config.jsonMode,
    fetch: fetchImpl, requestOptions: config.requestOptions, maxOutputTokens: outputTokens, continuationScope: config.credentialRef };
  // Exhaustive protocol registry. Supplier selection never selects a constructor.
  const Adapter = MODEL_PROTOCOL_ADAPTERS[config.provider];
  if (!Adapter) throw new Error("Unsupported model wire protocol");
  const provider = new Adapter(opts);
  const imageRun=provider.runTools.bind(provider), imageStream=provider.streamTools?.bind(provider);
  const checkImages=(args:import("./provider.js").RunToolsArgs)=>{
    for(const message of args.messages)for(const item of message.attachments??[]){
      if(item.kind==="text"||item.kind==="reference")continue;
      const capability=item.kind==="image"?"imageInput":item.kind==="document"?"documentInput":"audioInput";
      if(config.modelProfile?.[capability]!==true || item.kind==="audio"&&config.provider!=="openai")throw new AttachmentInputError();
    }
  };
  provider.runTools=async args=>{checkImages(args);return imageRun(args);};
  (provider as LlmProvider).validateInput=messages=>{
    checkImages({system:"",messages,tools:[]});
    for(const message of messages)attachmentContent(message,config.provider);
  };
  if(imageStream)provider.streamTools=async(args,handlers)=>{checkImages(args);return imageStream(args,handlers);};
  if (config.modelProfile?.toolCalling === false) {
    const run=provider.runTools.bind(provider), stream=provider.streamTools?.bind(provider);
    provider.runTools=async args=> { if(args.tools.length) throw new Error("Declared model does not support tool calling"); return run(args); };
    if(stream) provider.streamTools=async(args,handlers)=>{ if(args.tools.length) throw new Error("Declared model does not support tool calling"); return stream(args,handlers); };
  }
  return withContextBudget(provider, {
    contextWindowTokens: config.contextWindowTokens, maxOutputTokens: outputTokens,
  });
}

export function createProviderFromConfig(config: LlmConfig | null): LlmProvider {
  if (!config) throw new Error("LLM config missing: create config/llm.json before starting AI features");
  return createProvider(config);
}
