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
import { McpManager, loadMcpConfig } from "@traceforge/extension";
import { LlmConfigService } from "./llm-config-service.js";
import { registerSecurityAgentFoundation } from "./security-agent-foundation.js";
import { startLocalExecutionNodeService } from "./execution-node-service.js";

// 运行时数据固定放在项目根目录 data/ 下，避免受 process.cwd() 影响（tsx watch 从 apps/server 启动）
const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const DEFAULT_DB_PATH = resolve(PROJECT_ROOT, "data/traceforge.sqlite");
const DEFAULT_MCP_CONFIG_PATH = resolve(PROJECT_ROOT, "config/mcp.json");
const DEFAULT_LLM_CONFIG_PATH = resolve(PROJECT_ROOT, "config/llm.json");

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
  mcpConfigPath = DEFAULT_MCP_CONFIG_PATH,
  llmConfigPath = DEFAULT_LLM_CONFIG_PATH,
  projectRoot = PROJECT_ROOT,
  webRoot?: string,
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

  const db = createDb(dbPath);
  const bus = new EventBus();

  const mcp = new McpManager();
  const configs = loadMcpConfig(mcpConfigPath);
  if (configs.length === 0) {
    app.log.warn(`MCP config loaded no servers from ${mcpConfigPath}`);
  }
  await mcp.connectAll(configs);

  const llmService = new LlmConfigService(llmConfigPath);
  let llmConfigured = false;
  try {
    llmService.initializeFromConfig();
    llmConfigured = true;
  } catch (err) {
    app.log.warn({ err }, "LLM provider not initialized from config; save settings before running Agent");
  }
  const provider = llmService.getProvider();
  const executionNodeService = await startLocalExecutionNodeService(projectRoot, getSqliteClient(db));

  registerRoutes(app, db, bus, provider, mcp, llmService, projectRoot);
  registerSecurityAgentFoundation(app, getSqliteClient(db), provider, projectRoot, () => llmService.hasProvider(), {
    modelRoutes: llmService.getModelRoutes(),
    modelPolicies: llmService.getRolePolicies(),
    modelResourcePolicy: llmService.getResourcePolicy(),
    onAgentEvent: (event) => bus.emit({ type: "scenario_agent_event", event }),
    executionNode: executionNodeService.client,
  });

  app.get("/api/health", async () => ({
    status: "ok",
    llmConfigured,
    mcpTools: mcp.listTools().length,
    executionNodeReady: true,
    executionProcessReady: executionNodeService.processReady,
  }));

  app.get("/ws", { websocket: true }, (socket) => {
    const off = bus.subscribe((e) => socket.send(JSON.stringify(e)));
    socket.on("close", off);
  });

  app.addHook("onClose", async () => {
    await Promise.all([mcp.closeAll(), executionNodeService.close()]);
  });

  return app;
}

// 直接运行时启动（用 pathToFileURL 规范化，跨平台可靠：Windows 下 argv[1] 是反斜杠路径，
// 直接拼 file:// 永不等于 import.meta.url，会导致 listen 不执行、进程空跑退出）
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const app = await buildServer(process.env.TRACEFORGE_DB ?? DEFAULT_DB_PATH);
  const listen = resolveListenConfig();
  await app.listen(listen);
  console.log(`TraceForge server listening on http://${listen.host}:${listen.port}`);
}
