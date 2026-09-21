/** Provider-neutral input sizing. Estimates are deliberately conservative, not
 * a claim to implement any supplier's tokenizer. Configuration is authoritative. */
export interface ModelContextLimits {
  contextWindowTokens?: number;
  maxOutputTokens?: number;
  /** Runtime calibration from provider-reported input usage, never user text. */
  inputTokenMultiplier?: number;
  maximumInputTokens?: number;
  contextWindowSource?: "configured" | "conservative_fallback";
}
/** Only an explicit input rejection, never a timeout or partial model result. */
export class ModelContextOverflowError extends Error {
  readonly name = "ModelContextOverflowError";
  readonly status = 400;
  constructor(readonly origin: "local_guard" | "remote_rejection") {
    super("Model input exceeds context budget; rebuild from authorized history");
  }
}
export function estimateContextTokens(value: unknown): number {
  const text = typeof value === "string" ? value : JSON.stringify(value) ?? "";
  const other = text.replace(/[\x00-\x7f]/g, "");
  return Math.ceil((text.length - other.length) / 3) + new TextEncoder().encode(other).length;
}
export function resolveContextBudget(limits: ModelContextLimits = {}) {
  const window = limits.contextWindowTokens ?? 32768;
  // Unknown-window sizing is a compaction estimate, not a wire-level cap.
  const output = limits.contextWindowTokens === undefined
    ? Math.min(limits.maxOutputTokens ?? 4096, Math.floor(window / 8))
    : limits.maxOutputTokens ?? Math.min(4096, Math.floor(window / 8));
  const multiplier = limits.inputTokenMultiplier ?? 1;
  if (!Number.isSafeInteger(window) || window < 1024 || !Number.isSafeInteger(output) || output < 1 || output >= window)
    throw new Error("Invalid model context/output budget");
  const safety = Math.max(256, Math.ceil(window * 0.05));
  if (!Number.isFinite(multiplier) || multiplier < 1) throw new Error("Invalid model token estimate calibration");
  if (limits.maximumInputTokens !== undefined && (!Number.isSafeInteger(limits.maximumInputTokens) || limits.maximumInputTokens < 1))
    throw new Error("Invalid context operational budget");
  const input = Math.floor(Math.min(window - output - safety, limits.maximumInputTokens ?? Infinity) / multiplier);
  if (input < 256) throw new Error("Model output reservation leaves no context budget");
  return { window, output, input, multiplier, trigger: Math.floor(input * 0.9), target: Math.floor(input * 0.65),
    source: limits.contextWindowSource ?? (limits.contextWindowTokens === undefined ? "conservative_fallback" : "configured"), estimator: "ascii3-utf8-v1" } as const;
}
