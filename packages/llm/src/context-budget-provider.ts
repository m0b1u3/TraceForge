import { estimateContextTokens, resolveContextBudget, ModelContextOverflowError, type ModelContextLimits } from "@traceforge/shared/model-context";
import { normalizeContextOverflow } from "./context-overflow.js";
import type { LlmProvider, UsageSnapshot } from "./provider.js";

/** Protocol-independent final request guard and provider-usage calibration.
 * This never edits a request or retries an effect. Consumers own compaction. */
export function withContextBudget(provider: LlmProvider, limits: ModelContextLimits): LlmProvider {
  let multiplier = 1;
  const current = () => ({ ...limits, inputTokenMultiplier: multiplier });
  const observe = (estimate: number, callback?: (usage: UsageSnapshot) => void) => (usage: UsageSnapshot) => {
    if (Number.isSafeInteger(usage.promptTokens) && usage.promptTokens > 0 && estimate > 0)
      multiplier = Math.max(multiplier, usage.promptTokens / estimate);
    callback?.(usage);
  };
  const check = (request: unknown) => {
    const estimate = estimateContextTokens(request);
    if ((limits.contextWindowTokens !== undefined || limits.maximumInputTokens !== undefined) && estimate > resolveContextBudget(current()).input) {
      throw new ModelContextOverflowError("local_guard");
    }
    return estimate;
  };
  const guarded: LlmProvider = {
    get contextLimits() { return current(); },
    extractJson(args) {
      const estimate = check({ system: args.system, user: args.user, schema: args.schema });
      return provider.extractJson({ ...args, onUsage: observe(estimate, args.onUsage) }).catch(error => { throw normalizeContextOverflow(error); });
    },
    runTools(args) {
      const estimate = check({ system: args.system, messages: args.messages, tools: args.tools });
      return provider.runTools({ ...args, onUsage: observe(estimate, args.onUsage) });
    },
    ...(provider.streamTools ? { streamTools: ((args, handlers) => {
      const estimate = check({ system: args.system, messages: args.messages, tools: args.tools });
      return provider.streamTools!(args, { ...handlers, onUsage: observe(estimate, handlers.onUsage ?? args.onUsage) }).catch(error => { throw normalizeContextOverflow(error); });
    }) as NonNullable<LlmProvider["streamTools"]> } : {}),
    ...(provider.embed ? { embed: provider.embed.bind(provider) } : {}),
  };
  return new Proxy(provider, { get(target, key) {
    return key in guarded ? Reflect.get(guarded, key) : Reflect.get(target, key, target);
  } });
}
