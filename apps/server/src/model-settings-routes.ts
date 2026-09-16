import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { MODEL_PROTOCOLS, MODEL_SUPPLIER_IDS } from "@traceforge/shared/model-protocol";
import type { LlmConfigService } from "./llm-config-service.js";
import type { ModelAccounts } from "./model-accounts.js";
import { ModelCatalogError } from "@traceforge/llm";
import { ModelProfileSchema } from "@traceforge/shared/model-profile";

const configSchema = z.object({
  provider: z.enum(MODEL_PROTOCOLS), supplier: z.enum(MODEL_SUPPLIER_IDS).optional(),
  modelProfile: ModelProfileSchema.nullish(),
  model: z.string().trim().min(1).max(200), baseUrl: z.string().min(1).max(2048),
  apiKey: z.string().min(1).max(8192).refine(key => !/[\r\n]/.test(key)).optional(),
  credentialRef: z.string().regex(/^[a-z][a-z0-9_.:-]{0,127}$/).optional(),
  authMode: z.enum(["api_key", "bearer"]).optional(), jsonMode: z.enum(["json_schema", "json_object"]).optional(),
  contextWindowTokens: z.number().int().positive().max(100000000).nullish(),
  maxOutputTokens: z.number().int().positive().max(10000000).nullish(),
  requestOptions: z.object({ includeReasoningContinuation: z.boolean().optional(), thinking: z.enum(["enabled", "disabled"]).optional(),
    reasoningEffort: z.enum(["none", "minimal", "low", "medium", "high", "max"]).optional(),
    temperature: z.number().min(0).max(2).optional() }).strict().optional(),
}).strict();
const requestSchema = z.object({ expectedRevision: z.string().regex(/^[a-f0-9]{64}$/), config: configSchema }).strict();

export function registerModelSettingsRoutes(app: FastifyInstance, service: LlmConfigService, accounts?: ModelAccounts): void {
  const snapshot = async () => {
    const list = accounts ? await accounts.list() : [];
    return { ...service.settings(), suppliers: service.connectionCatalog(), testScope: "structured_ping", accounts: list, subscriptionLogin: list.length > 0 };
  };
  app.post("/api/desktop/models/account", { bodyLimit: 1024 }, async (request, reply) => {
    const parsed = z.object({ operation: z.enum(["begin", "poll", "cancel", "disconnect"]), id: z.string().max(128) }).strict().safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_account_operation" });
    if (!accounts) return reply.code(409).send({ error: "account_registration_unavailable" });
    try { return await accounts.operate(parsed.data.operation, parsed.data.id); }
    catch { return reply.code(409).send({ error: "account_operation_unconfirmed", message: "账号操作未确认。请读取状态核对，必要时重新登录。" }); }
  });
  app.get("/api/desktop/models", async (_request, reply) => {
    try { return await snapshot(); }
    catch { return reply.code(503).send({ error: "model_settings_unavailable", message: "无法读取模型配置或安全存储。请先检查宿主，不会覆盖现有配置。" }); }
  });
  app.post("/api/desktop/models/discover", { bodyLimit: 20000 }, async (request, reply) => {
    const parsed = z.object({ expectedRevision: z.string().regex(/^[a-f0-9]{64}$/), config: configSchema.extend({ model: z.string().max(200) }) }).strict().safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_model_settings" });
    try {
      if (parsed.data.config.credentialRef && !accounts) return reply.code(409).send({ error: "account_registration_unavailable" });
      accounts?.assertConnection(parsed.data.config);
      if (service.settings().revision !== parsed.data.expectedRevision) return reply.code(409).send({ error: "model_settings_changed" });
      return await service.discover(parsed.data.config);
    } catch (error) { return reply.code(503).send({ error: error instanceof ModelCatalogError ? error.code : "unavailable" }); }
  });
  for (const operation of ["save", "test"] as const) {
    app.post(`/api/desktop/models/${operation}`, { bodyLimit: 20000 }, async (request, reply) => {
      const parsed = requestSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: "invalid_model_settings", message: "模型配置格式不正确，请检查必填字段与参数范围。" });
      try {
        if (parsed.data.config.credentialRef && !accounts) return reply.code(409).send({ error: "account_registration_unavailable" });
        accounts?.assertConnection(parsed.data.config);
        if (service.settings().revision !== parsed.data.expectedRevision) return reply.code(409).send({ error: "model_settings_changed", message: "宿主配置已改变，请重新读取后再操作。" });
        if (operation === "test") return { ...await service.test(parsed.data.config), scope: "structured_ping", saved: false };
        service.reload(parsed.data.config);
        return await snapshot();
      } catch { return reply.code(503).send({ error: "model_settings_failed", message: "模型配置操作未完成。请重新读取核对，并检查端点、凭据与安全存储。" }); }
    });
  }
}
