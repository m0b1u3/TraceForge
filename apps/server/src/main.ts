import { pathToFileURL, fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import Fastify from "fastify";
import websocket from "@fastify/websocket";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import { createDb, getSqliteClient } from "./db/client.js";
import { EventBus } from "./event-bus.js";
import { registerRoutes } from "./routes.js";
import { LlmConfigService, type LlmSecretBundle, type LlmSecretStore } from "./llm-config-service.js";
import { registerSecurityAgentFoundation, type SecurityAgentFoundationOptions } from "./security-agent-foundation.js";
import { startLocalExecutionNodeService } from "./execution-node-service.js";
import { loadToolProviderTrustRoots } from "./tool-provider-control-plane.js";
import type { ScenarioAuthorizationPort } from "@traceforge/scenario-sdk";
import { readFoundationRestoreFence } from "./db/foundation-restore-fence.js";
import { registerFoundationInspectionRoutes } from "./foundation-backup.js";
import { foundationHostControl, registerFoundationHostControl } from "./foundation-host-control.js";
import { loadOrCreateVaultKey, SqliteEncryptedSecretVault } from "./execution-session-gateway.js";
import { resolveFoundationActiveDatabase } from "./foundation-recovery-activation.js";
import { resolveFoundationDeployment } from "./foundation-deployment.js";
import { loadScenarioHostConfiguration } from "./scenario-host-configuration.js";

// 运行时数据固定放在项目根目录 data/ 下，避免受 process.cwd() 影响（tsx watch 从 apps/server 启动）
const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const DEFAULT_DB_PATH = resolve(PROJECT_ROOT, "data/traceforge.sqlite");
const DEFAULT_MCP_CONFIG_PATH = resolve(PROJECT_ROOT, "config/mcp.json");
const DEFAULT_LLM_CONFIG_PATH = resolve(PROJECT_ROOT, "config/llm.json");
const DEFAULT_SCENARIO_CONFIG_PATH = resolve(PROJECT_ROOT, "config/scenarios.json");

export function trustedUiOrigin(origin: string | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!origin) return true;
  const configured = new Set((env.TRACEFORGE_ALLOWED_ORIGINS ?? "").split(",").map((value) => value.trim()).filter(Boolean));
  if (configured.has(origin)) return true;
  try {
    const url = new URL(origin);
    return (url.protocol === "http:" || url.protocol === "https:")
      && ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  } catch {
    return false;
  }
}

export function resolveListenConfig(env: NodeJS.ProcessEnv = process.env): { host: string; port: number } {
  const host = env.TRACEFORGE_HOST?.trim() || "127.0.0.1";
  const rawPort = env.TRACEFORGE_PORT?.trim() || "4000";
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`TRACEFORGE_PORT must be an integer between 1 and 65535, received ${JSON.stringify(rawPort)}`);
  }
  return { host, port };
}

export async function buildServer(
  dbPath = DEFAULT_DB_PATH,
  _mcpConfigPath = DEFAULT_MCP_CONFIG_PATH,
  llmConfigPath = DEFAULT_LLM_CONFIG_PATH,
  projectRoot = PROJECT_ROOT,
  webRoot?: string,
  hostOptions: Pick<SecurityAgentFoundationOptions, "backup"|"offlineMedia"|"retentionAuthorizer"|"recoveryReadiness"|"recoveryActivation"|"deployment">
    & { llmSecretStore?: LlmSecretStore } = {},
) {
  const app = Fastify({ logger: true });
  await app.register(cors, {
    origin: (origin, callback) => callback(null, trustedUiOrigin(origin)),
  });
  app.addHook("onRequest", async (request, reply) => {
    const origin = typeof request.headers.origin === "string" ? request.headers.origin : undefined;
    if (!trustedUiOrigin(origin)) return reply.code(403).send({ error: "untrusted UI origin" });
  });
  await app.register(websocket);
  if (webRoot && existsSync(webRoot)) {
    await app.register(fastifyStatic, { root: webRoot, index: "index.html" });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith("/api/") || request.url === "/ws") return reply.code(404).send({ error: "not found" });
      return reply.sendFile("index.html");
    });
  }

  const { llmSecretStore: suppliedLlmSecretStore, ...foundationHostOptions } = hostOptions;
  const selected=resolveFoundationActiveDatabase(dbPath,foundationHostOptions.recoveryActivation);
  const deploymentContext={databasePath:selected.path,activeCandidate:selected.candidate};
  const effectiveHostOptions={...foundationHostOptions,deployment:foundationHostOptions.deployment?{...foundationHostOptions.deployment,startupContext:deploymentContext}:undefined};
  // Fail closed before opening/migrating the active database or connecting MCP/model/execution dependencies.
  const deployment=resolveFoundationDeployment(effectiveHostOptions.deployment,deploymentContext);
  const db = createDb(selected.path,{activeCandidate:selected.candidate});
  const sqlite = getSqliteClient(db);
  if (readFoundationRestoreFence(sqlite)) {
    // Stop here, before MCP connections, model initialization, package assembly or native node startup.
    registerFoundationHostControl(app, sqlite);
    registerFoundationInspectionRoutes(app, sqlite, effectiveHostOptions.recoveryReadiness, effectiveHostOptions.recoveryActivation);
    app.get("/api/health", async () => ({ status: "inspection_only", llmConfigured: false, mcpTools: 0, executionNodeReady: false, executionProcessReady: false,
      deployment:deployment?{managed:true,releaseId:deployment.manifest.releaseId,deploymentGeneration:deployment.manifest.deploymentGeneration,switchGeneration:deployment.pointer.switchGeneration}:{managed:false} }));
    app.addHook("onClose", async () => { if (sqlite.open) sqlite.close(); });
    return app;
  }
  const bus = new EventBus();

  if (existsSync(_mcpConfigPath)) {
    app.log.warn({ configPath: _mcpConfigPath }, "Legacy MCP config is ignored; install MCP through the governed Provider/Profile path");
  }

  let llmVault: SqliteEncryptedSecretVault | undefined;
  const vault = () => llmVault ??= new SqliteEncryptedSecretVault(sqlite, loadOrCreateVaultKey(projectRoot));
  const llmSecretStore: LlmSecretStore = suppliedLlmSecretStore ?? {
    load() {
      let stored: LlmSecretBundle = { alternativeRoutes: {} };
      try { stored = vault().get<LlmSecretBundle>("llm-config-secrets:v1"); }
      catch (error) {
        if (!(error instanceof Error) || !error.message.includes("is unavailable")) throw error;
      }
      const environmentKey = process.env.TRACEFORGE_LLM_API_KEY?.trim();
      return environmentKey ? { ...stored, primary: environmentKey } : stored;
    },
    save(secrets) { vault().put("llm-config-secrets:v1", secrets); },
  };
  const llmService = new LlmConfigService(llmConfigPath, { secretStore: llmSecretStore });
  let llmConfigured = false;
  try {
    llmService.initializeFromConfig();
    llmConfigured = true;
  } catch (err) {
    app.log.warn({ err }, "LLM provider not initialized from config; save settings before running Agent");
  }
  const provider = llmService.getProvider();
  const scenarioHost = loadScenarioHostConfiguration(projectRoot === PROJECT_ROOT
    ? DEFAULT_SCENARIO_CONFIG_PATH : resolve(projectRoot, "config/scenarios.json"));
  let scenarioAuthorization: ScenarioAuthorizationPort | undefined;
  const authorizationProxy: ScenarioAuthorizationPort = {
    requireAction(scopeRef, caseId, action) {
      if (!scenarioAuthorization) throw new Error("Scenario authorization is not assembled");
      return scenarioAuthorization.requireAction(scopeRef, caseId, action);
    },
    authorizeResource(scopeRef, caseId, action, resourceKind, value) {
      if (!scenarioAuthorization) throw new Error("Scenario authorization is not assembled");
      return scenarioAuthorization.authorizeResource(scopeRef, caseId, action, resourceKind, value);
    },
  };
  const executionNodeService = await startLocalExecutionNodeService(projectRoot, authorizationProxy, sqlite);

  registerSecurityAgentFoundation(app, sqlite, provider, projectRoot, () => llmService.hasProvider(), {
    ...effectiveHostOptions,
    scenarioPackageTrust: scenarioHost.trust,
    loadScenarioPackageDescriptors: (scenarioHost.trust.installations?.length ?? 0) > 0,
    scenarioProcessLaunches: scenarioHost.launches,
    onScenarioAuthorizationReady: (authorization) => { scenarioAuthorization = authorization; },
    modelRoutes: llmService.getModelRoutes(),
    modelPolicies: llmService.getRolePolicies(),
    modelResourcePolicy: llmService.getResourcePolicy(),
    onAgentEvent: (event) => bus.emit({ type: "scenario_agent_event", event }),
    executionNode: executionNodeService.client,
    toolProviderTrustRoots: loadToolProviderTrustRoots(resolve(projectRoot, "config/tool-provider-trust-roots.json")),
  });
  // Register application APIs after the host transport fence. No unguarded legacy API back door.
  registerRoutes(app, db, bus, provider, llmService, projectRoot);

  app.get("/api/health", async () => {
    const executionNode = await executionNodeService.health();
    return {
      status: "ok",
      llmConfigured,
      mcpTools: 0,
      executionNodeReady: executionNode.state !== "stopped",
      executionProcessReady: executionNode.processReady,
      executionNode,
      deployment:deployment?{managed:true,releaseId:deployment.manifest.releaseId,deploymentGeneration:deployment.manifest.deploymentGeneration,switchGeneration:deployment.pointer.switchGeneration}:{managed:false},
    };
  });

  app.get("/ws", { websocket: true }, (socket) => {
    const off = bus.subscribe((e) => socket.send(JSON.stringify(e)));
    socket.on("close", off);
  });

  app.addHook("onClose", async () => {
    await executionNodeService.close();
  });

  return app;
}

export { foundationHostControl };
export type { LlmSecretBundle, LlmSecretStore };

// 直接运行时启动（用 pathToFileURL 规范化，跨平台可靠：Windows 下 argv[1] 是反斜杠路径，
// 直接拼 file:// 永不等于 import.meta.url，会导致 listen 不执行、进程空跑退出）
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const app = await buildServer(process.env.TRACEFORGE_DB ?? DEFAULT_DB_PATH);
  const listen = resolveListenConfig();
  await app.listen(listen);
  console.log(`TraceForge server listening on http://${listen.host}:${listen.port}`);
}
