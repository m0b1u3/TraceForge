import type { ModelProfile } from "@traceforge/shared/model-profile";

/** Immutable documented defaults, copied into user configuration on selection.
 * Reviewed 2026-09-15: https://api-docs.deepseek.com/quick_start/pricing/
 * 1M/384K conservatively expressed in decimal tokens. Not live account limits.
 * Exact endpoint/model matches only; never apply these to an arbitrary proxy.
 */
export const DOCUMENTED_MODEL_PROFILES: readonly ModelProfile[] = Object.freeze([
  {model:"deepseek-flash",baseUrl:"https://api.deepseek.com",protocol:"openai",source:"documentation",contextWindowTokens:1000000,maxOutputTokens:384000,toolCalling:true,reasoning:true,imageInput:true},
  {model:"deepseek-flash",baseUrl:"https://api.deepseek.com/v1",protocol:"openai",source:"documentation",contextWindowTokens:1000000,maxOutputTokens:384000,toolCalling:true,reasoning:true,imageInput:true},
]);
