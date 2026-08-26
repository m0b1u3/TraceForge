import type { FastifyInstance } from "fastify";
import type { Db } from "./db/client.js";
import { getSqliteClient } from "./db/client.js";
import { CaseStore } from "./stores/case-store.js";
import type { EventBus } from "./event-bus.js";
import type { LlmProvider } from "@traceforge/llm";
import type { McpManager } from "@traceforge/extension";
import type { CaseSummary } from "@traceforge/shared";
import { LlmConfigService, type LlmConfigDto } from "./llm-config-service.js";

/**
 * Small application control surface shared by the desktop shell and the
 * standalone security-agent foundation. Agent execution itself belongs to
 * registerSecurityAgentFoundation; this module must not grow another runtime.
 */
export function registerRoutes(
  app: FastifyInstance,
  db: Db,
  bus: EventBus,
  _provider?: LlmProvider,
  mcp?: McpManager,
  llmService?: LlmConfigService,
  _projectRoot?: string,
): void {
  const cases = new CaseStore(db);
  const sqlite = getSqliteClient(db);

  app.get("/api/cases", async () => cases.list());

  app.post("/api/cases", async (request, reply) => {
    const body = (request.body ?? {}) as { name?: string; allowHosts?: string[] };
    if (!body.name?.trim()) return reply.code(400).send({ error: "name required" });
    const created = cases.create(body.name.trim(), [{ caseId: "", allowHosts: body.allowHosts ?? [], denyHosts: [] }]);
    bus.emit({ type: "case_created", case: created });
    return reply.code(201).send(created);
  });

  app.patch("/api/cases/:caseId", async (request, reply) => {
    const { caseId } = request.params as { caseId: string };
    const body = (request.body ?? {}) as { name?: string; status?: "active" | "paused" | "archived" };
    const updated = cases.update(caseId, body);
    return updated ?? reply.code(404).send({ error: "case not found" });
  });

  app.delete("/api/cases/:caseId", async (request, reply) => {
    const { caseId } = request.params as { caseId: string };
    if (!cases.delete(caseId)) return reply.code(404).send({ error: "case not found" });
    bus.emit({ type: "case_deleted", caseId });
    return { deleted: true };
  });

  app.get("/api/cases/summary", async (): Promise<CaseSummary[]> => cases.list().map((entry) => {
    const latest = sqlite.prepare(`
      SELECT status, updated_at FROM scenario_event_streams
      WHERE case_id = ? ORDER BY created_at DESC LIMIT 1
    `).get(entry.id) as { status: string; updated_at: string } | undefined;
    const pendingApproval = Boolean(sqlite.prepare(`
      SELECT 1 FROM scenario_work_approvals WHERE case_id = ? AND status = 'pending' LIMIT 1
    `).get(entry.id));
    const runStatus: CaseSummary["runStatus"] = pendingApproval
      ? "waiting"
      : latest?.status === "running"
        ? "running"
        : latest?.status === "paused"
          ? "waiting"
        : latest?.status === "failed" || latest?.status === "cancelled"
          ? "failed"
          : latest?.status === "completed"
            ? "completed"
            : "idle";
    return {
      id: entry.id,
      name: entry.name,
      status: entry.status,
      target: entry.scopeRules.flatMap((rule) => rule.allowHosts)[0] ?? null,
      runStatus,
      trafficCount: 0,
      findingCount: 0,
      severityCounts: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
      pendingApproval,
      lastActivityAt: latest?.updated_at ?? entry.createdAt,
      createdAt: entry.createdAt,
    };
  }));

  if (llmService) {
    app.get("/api/config/llm", async () => llmService.load());
    app.post("/api/config/llm/reveal-key", async (_request, reply) => {
      reply.header("cache-control", "no-store");
      reply.header("pragma", "no-cache");
      return { apiKey: llmService.revealApiKey() };
    });
    app.post("/api/config/llm", async (request, reply) => {
      const body = request.body as LlmConfigDto;
      if (!body.provider || !body.model) return reply.code(400).send({ error: "provider and model are required" });
      try { return llmService.reload(body); }
      catch (error) { return reply.code(500).send({ error: (error as Error).message }); }
    });
    app.post("/api/config/llm/test", async (request, reply) => {
      const body = request.body as LlmConfigDto;
      if (!body.provider || !body.model) return reply.code(400).send({ error: "provider and model are required" });
      return llmService.test(body);
    });
  }

  app.get("/api/mcp/tools", async () => mcp?.listTools() ?? []);
}
