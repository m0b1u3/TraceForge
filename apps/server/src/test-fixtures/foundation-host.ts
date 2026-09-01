import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import type { LlmProvider } from "@traceforge/llm";
import { ScenarioPackageRegistry } from "@traceforge/scenario-sdk";
import { RpcExecutionToolDiscoverySource, ToolProviderProcessClient } from "@traceforge/worker-runtime";
import { createDb, getSqliteClient } from "../db/client.js";
import { registerSecurityAgentFoundation, type SecurityAgentFoundationOptions } from "../security-agent-foundation.js";
import { definition } from "./execution-recovery.js";
import { foundationHostControl, type FoundationHostChannel } from "../foundation-host-control.js";

export interface FoundationHost {
  root: string;
  app: FastifyInstance;
  sqlite: Database.Database;
  rpc: ToolProviderProcessClient;
  requests: Array<Record<string, any>>;
  management: FoundationHostChannel;
  calls(): number;
  request(path: string, body?: unknown): Promise<any>;
  start(id?: string): Promise<void>;
  state(id?: string): Promise<any>;
  close(remove?: boolean): Promise<void>;
}

export async function foundationHost(options: { root?: string; discoveryGate?: Promise<void>; ready?: () => boolean;
  model?: LlmProvider["extractJson"]; modelTimeoutMs?: number; observationToken?: string; objective?: string;
  input?: Record<string, unknown>; failResultCheckpoint?: boolean; empty?: boolean;
  foundation?: Partial<SecurityAgentFoundationOptions> } = {}): Promise<FoundationHost> {
  const root = options.root ?? await mkdtemp(join(tmpdir(), "traceforge-host-"));
  const sqlite: Database.Database = getSqliteClient(createDb(join(root, "state.db")));
  const app = Fastify();
  const requests: Array<Record<string, any>> = []; let calls = 0;
  const rpc = new ToolProviderProcessClient({ executable: process.execPath,
    arguments: [resolve("packages/worker-runtime/test-fixtures/tool-provider.mjs")], workingDirectory: root,
    environment: { TRACEFORGE_TEST_SOURCE: "fixture.host",
      ...(options.observationToken ? { TRACEFORGE_TEST_OBSERVATION: options.observationToken } : {}),
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) },
    attestation: { sandboxed: false, backend: "local-test-only", network: "deny" }, allowUnsandboxedDevelopment: true, requestTimeoutMs: 2000 });
  const source = new RpcExecutionToolDiscoverySource("fixture.host", rpc);
  const neutral = { ...definition, requiredCapabilities: ["fixture.read"], authorizationActions: ["fixture.read"],
    phases: definition.phases.map((p) => ({ ...p, requiredCapabilities: ["fixture.read"] })),
    agentTopology: { ...definition.agentTopology, workerPools: definition.agentTopology.workerPools.map((p) => ({ ...p, capabilities: ["fixture.read"] })) } };
  const provider: LlmProvider = {
    async runTools() { throw new Error("Unexpected model tool execution bypass"); },
    async extractJson(args) {
      const context = JSON.parse(args.user); requests.push(context);
      if (options.model) return options.model(args);
      if (context.transcript.some((entry: { kind: string }) => entry.kind === "tool")) return { type: "complete", summary: "Saved observation", outputs: [] };
      return { type: "invoke_tool", invocation: { id: "first", tool: "fixture.read", input: options.input ?? { candidate: "first candidate" }, rationale: "Observe assigned candidate" } };
    },
  };
  sqlite.prepare("INSERT OR IGNORE INTO cases(id,name,status,scope_rules_json,created_at) VALUES ('case','Neutral','active','{}',?)").run(new Date().toISOString());
  if (options.failResultCheckpoint) app.addHook("preHandler", async (request, reply) => {
    if (request.url.endsWith("/checkpoint") && String((request.body as { commandId?: string })?.commandId).endsWith(":committed")) {
      return reply.code(503).send({ error: "Injected checkpoint acknowledgement failure" });
    }
  });
  registerSecurityAgentFoundation(app, sqlite, provider, root, options.ready ?? (() => true), {
    autoScheduleIntervalMs: 100,
    // This RPC fixture deliberately uses a local unsandboxed child, not production governance.
    allowUnmanagedDevelopmentSources: true,
    scenarioPackageTrust:{allowUnreviewedDevelopmentPackages:true},
    scenarioPackageRegistry: new ScenarioPackageRegistry(options.empty ? [] : [{ id: "neutral", version: "1.0.0", schemaRevision: 1,
      definition: neutral, outputSchemas: [{ kind: "decision", version: 1, validate() {} }], authorizationPolicy: { parseScope: (payload) => ({ payload, allowedActions: ["fixture.read"], deniedActions: [] }) }, createToolSources: () => [] }]),
    modelPolicies: { worker: { maximumAttemptsPerRoute: 1, timeoutMs: options.modelTimeoutMs ?? 300, maximumRunTokens: 10000000 } },
    workContinuationAuthorizer: { async authorize() { return { decision: "allowed", authorizationRef: "fixture-only", expiresAt: "2099-01-01T00:00:00.000Z" }; } },
    toolDiscoverySources: options.empty ? [] : [{ source: "fixture.host", async discover() {
      await options.discoveryGate;
      return (await source.discover()).map((tool) => ({ ...tool, async execute(...args: Parameters<typeof tool.execute>) { calls++; return tool.execute(...args); } }));
    }, async close() { await source.close(); } }],
    ...options.foundation,
  });
  try { await app.listen({ host: "127.0.0.1", port: 0 }); }
  catch (error) {
    await app.close().catch(() => {});
    await rpc.close().catch(() => {});
    sqlite.close();
    if (!options.root) await rm(root, { recursive: true, force: true });
    throw error;
  }
  const address = app.server.address(); if (!address || typeof address === "string") throw new Error("Missing host address");
  const base = `http://127.0.0.1:${address.port}`;
  const management=foundationHostControl(app).management();
  const request = async (path: string, body?: unknown) => {
    const response = await management.fetch(base + path, { method: body === undefined ? "GET" : "POST", signal: AbortSignal.timeout(5000),
      headers: body === undefined ? undefined : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const value = await response.json(); if (!response.ok) throw new Error(`HTTP ${response.status}: ${JSON.stringify(value)}`); return value;
  };
  return { root, app, sqlite, rpc, requests, management, calls: () => calls, request,
    async start(id = "run") {
      await request("/api/scenarios/authorizations", { id: `${id}:scope`, caseId: "case", scenarioKind: "neutral", scope: {}, approvedBy: "test", expiresAt: "2099-01-01T00:00:00.000Z" });
      await request("/api/scenarios/runs", { commandId: `${id}:start`, runId: id, caseId: "case", goal: options.objective ?? "Observe", scopeRef: `${id}:scope`, scenarioKind: "neutral", definitionVersion: 1 });
      await request(`/api/scenarios/runs/${id}/work`, { commandId: `${id}:propose`, expectedRevision: 1,
        proposal: { id: "work", kind: "observe", title: "Observe", objective: options.objective ?? "Observe", idempotencyKey: `${id}:effect`, maxAttempts: 1 } });
    },
    async state(id = "run") { return request(`/api/scenarios/runs/${id}`); },
    async close(remove = true) { await app.close(); await rpc.close(); sqlite.close(); if (remove) await rm(root, { recursive: true, force: true }); },
  };
}
export async function eventually(check: () => Promise<boolean>, timeout = 8000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await check()) return; await new Promise((resolve) => setTimeout(resolve, 25)); }
  throw new Error("Foundation host condition exceeded its bounded deadline");
}
