import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, parse } from "node:path";
import { z } from "zod";

const endpointShape = {
  provider: z.enum(["anthropic", "openai"]),
  model: z.string(),
  embeddingModel: z.string().min(1).optional(),
  baseUrl: z.string().optional(),
  apiKey: z.string().optional(),
  jsonMode: z.enum(["json_schema", "json_object"]).optional(),
  contextWindowTokens: z.number().int().positive().optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  currency: z.string().regex(/^[A-Z]{3}$/).optional(),
  inputPricePerMillion: z.number().finite().nonnegative().optional(),
  outputPricePerMillion: z.number().finite().nonnegative().optional(),
} as const;

function validatePricing(config: { currency?: string; inputPricePerMillion?: number; outputPricePerMillion?: number }, ctx: z.RefinementCtx): void {
  const pricingFields = [config.currency, config.inputPricePerMillion, config.outputPricePerMillion];
  const configured = pricingFields.filter((value) => value !== undefined).length;
  if (configured !== 0 && configured !== pricingFields.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "currency and both per-million token prices must be configured together",
    });
  }
}

export const LlmEndpointConfigSchema = z.object(endpointShape).superRefine(validatePricing);
export type LlmEndpointConfig = z.infer<typeof LlmEndpointConfigSchema>;

const alternativeRoute = z.object({ id: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/), ...endpointShape }).superRefine(validatePricing);
const rolePolicy = z.object({
  routeIds: z.array(z.string().min(1)).min(1).optional(),
  timeoutMs: z.number().int().positive().optional(),
  maximumAttemptsPerRoute: z.number().int().min(1).max(10).optional(),
  circuitFailureThreshold: z.number().int().min(1).max(100).optional(),
  circuitResetMs: z.number().int().positive().optional(),
  maximumRunTokens: z.number().int().positive().optional(),
  maximumEstimatedCallTokens: z.number().int().positive().optional(),
});
const cognitiveRoles = {
  planner: z.number().int().positive().optional(),
  observer: z.number().int().positive().optional(),
  worker: z.number().int().positive().optional(),
};
const modelResourcePolicy = z.object({
  maximumConcurrentCalls: z.number().int().positive().optional(),
  maximumConcurrentCallsPerRun: z.number().int().positive().optional(),
  maximumQueueDepth: z.number().int().positive().optional(),
  maximumQueueWaitMs: z.number().int().positive().optional(),
  priorityAgingIntervalMs: z.number().int().positive().optional(),
  roleConcurrency: z.object(cognitiveRoles).optional(),
  rolePriorities: z.object(cognitiveRoles).optional(),
});

export const LlmConfigSchema = z.object({
  ...endpointShape,
  alternativeRoutes: z.array(alternativeRoute).optional(),
  rolePolicies: z.object({ planner: rolePolicy.optional(), observer: rolePolicy.optional(), worker: rolePolicy.optional() }).optional(),
  resourcePolicy: modelResourcePolicy.optional(),
}).superRefine((config, ctx) => {
  validatePricing(config, ctx);
  const ids = new Set<string>(["primary"]);
  for (const [index, route] of (config.alternativeRoutes ?? []).entries()) {
    if (ids.has(route.id)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["alternativeRoutes", index, "id"], message: `duplicate model route ${route.id}` });
    ids.add(route.id);
  }
  for (const [role, policy] of Object.entries(config.rolePolicies ?? {})) {
    const unknown = policy?.routeIds?.filter((routeId) => !ids.has(routeId)) ?? [];
    if (unknown.length) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["rolePolicies", role, "routeIds"], message: `unknown model routes: ${unknown.join(", ")}` });
  }
});
export type LlmConfig = z.infer<typeof LlmConfigSchema>;

export function loadLlmConfig(path = "config/llm.json", startDir = process.cwd()): LlmConfig | null {
  try {
    const resolved = resolveConfigPath(path, startDir);
    if (!resolved) return null;
    const raw = readFileSync(resolved, "utf8");
    const parsed = LlmConfigSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function resolveConfigPath(path: string, startDir: string): string | null {
  if (isAbsolute(path)) return existsSync(path) ? path : null;
  let dir = startDir;
  const root = parse(dir).root;
  while (true) {
    const candidate = join(dir, path);
    if (existsSync(candidate)) return candidate;
    if (dir === root) return null;
    dir = dirname(dir);
  }
}
