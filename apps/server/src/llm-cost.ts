import type { LlmConfig } from "@traceforge/llm";
import type { AgentRunUsage } from "@traceforge/shared";

export type UsageCost = Pick<AgentRunUsage, "currency" | "inputCostMicros" | "outputCostMicros" | "totalCostMicros">;

export function calculateUsageCost(
  usage: Pick<AgentRunUsage, "promptTokens" | "completionTokens">,
  config: Pick<LlmConfig, "currency" | "inputPricePerMillion" | "outputPricePerMillion"> | null | undefined,
): UsageCost {
  if (
    !config?.currency
    || config.inputPricePerMillion === undefined
    || config.outputPricePerMillion === undefined
  ) {
    return { currency: null, inputCostMicros: null, outputCostMicros: null, totalCostMicros: null };
  }

  // A per-million-token price multiplied by one token is exactly one micro-unit of currency.
  const inputCostMicros = Math.round(usage.promptTokens * config.inputPricePerMillion);
  const outputCostMicros = Math.round(usage.completionTokens * config.outputPricePerMillion);
  return {
    currency: config.currency,
    inputCostMicros,
    outputCostMicros,
    totalCostMicros: inputCostMicros + outputCostMicros,
  };
}
