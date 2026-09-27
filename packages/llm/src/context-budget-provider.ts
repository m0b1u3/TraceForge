import { estimateContextTokens, resolveContextBudget, ModelContextOverflowError, type ModelContextLimits } from "@traceforge/shared/model-context";
import { normalizeContextOverflow } from "./context-overflow.js";
import type { LlmProvider, UsageSnapshot } from "./provider.js";

/** Protocol-independent final request guard and provider-usage calibration.
 * This never edits a request or retries an effect. Consumers own compaction. */
export function withContextBudget(provider: LlmProvider, limits: ModelContextLimits): LlmProvider {
  let multiplier = 1;
  let rejectedInputCeiling: number | undefined;
  const current = () => ({ ...limits, inputTokenMultiplier: multiplier,
    ...(rejectedInputCeiling === undefined ? {} : { maximumInputTokens: Math.min(limits.maximumInputTokens ?? Infinity, rejectedInputCeiling) }) });
  const classify = (error: unknown, estimate: number): never => {
    const normalized = normalizeContextOverflow(error);
    if (normalized instanceof ModelContextOverflowError && normalized.origin === "remote_rejection") {
      // The supplier, rather than a guessed model window, supplied the signal.
      // The next fresh evaluation can compact its unchanged authorized sources.
      const candidate = Math.max(256, Math.floor(estimate * 0.75));
      rejectedInputCeiling = Math.min(rejectedInputCeiling ?? Infinity, candidate);
    }
    throw normalized;
  };
  const observe = (estimate: number, callback?: (usage: UsageSnapshot) => void) => (usage: UsageSnapshot) => {
    if (Number.isSafeInteger(usage.promptTokens) && usage.promptTokens > 0 && estimate > 0)
      multiplier = Math.max(multiplier, usage.promptTokens / estimate);
    callback?.(usage);
  };
  const check = (request: unknown) => {
    const estimate = estimateContextTokens(request);
    if ((limits.contextWindowTokens !== undefined || current().maximumInputTokens !== undefined) && estimate > resolveContextBudget(current()).input) {
      throw new ModelContextOverflowError("local_guard");
    }
    return estimate;
  };
  const guarded: LlmProvider = {
    get contextLimits() { return current(); },
    extractJson(args) {
      const estimate = check({ system: args.system, user: args.user, schema: args.schema });
      return provider.extractJson({ ...args, onUsage: observe(estimate, args.onUsage) }).catch(error => classify(error, estimate));
    },
    runTools(args) {
      const estimate = check({ system: args.system, messages: args.messages, tools: args.tools });
      return provider.runTools({ ...args, onUsage: observe(estimate, args.onUsage) }).catch(error => classify(error, estimate));
    },
    ...(provider.streamTools ? { streamTools: ((args, handlers) => {
      const estimate = check({ system: args.system, messages: args.messages, tools: args.tools });
      return provider.streamTools!(args, { ...handlers, onUsage: observe(estimate, handlers.onUsage ?? args.onUsage) }).catch(error => classify(error, estimate));
    }) as NonNullable<LlmProvider["streamTools"]> } : {}),
    ...(provider.embed ? { embed: provider.embed.bind(provider) } : {}),
  };
  return new Proxy(provider, { get(target, key) {
    return key in guarded ? Reflect.get(guarded, key) : Reflect.get(target, key, target);
  } });
}
