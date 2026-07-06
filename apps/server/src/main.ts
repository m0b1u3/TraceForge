import { pathToFileURL, fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import Fastify from "fastify";
import websocket from "@fastify/websocket";
import cors from "@fastify/cors";
import { createDb } from "./db/client.js";
import { EventBus } from "./event-bus.js";
import { registerRoutes } from "./routes.js";
import { McpManager, loadMcpConfig } from "@traceforge/extension";

// 配置文件固定放在项目根目录，避免受 process.cwd() 影响（tsx watch 从 apps/server 启动）
const DEFAULT_MCP_CONFIG_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "../../../config/mcp.json");

export async function buildServer(dbPath = "traceforge.sqlite", mcpConfigPath = DEFAULT_MCP_CONFIG_PATH) {
  const app = Fastify({ logger: true });
  await app.register(cors, { origin: true });
  await app.register(websocket);

  const db = createDb(dbPath);
  const bus = new EventBus();

  const mcp = new McpManager();
  const configs = loadMcpConfig(mcpConfigPath);
  if (configs.length === 0) {
    app.log.warn(`MCP config loaded no servers from ${mcpConfigPath}`);
  }
  await mcp.connectAll(configs);

  registerRoutes(app, db, bus, undefined, mcp);

  app.get("/ws", { websocket: true }, (socket) => {
    const off = bus.subscribe((e) => socket.send(JSON.stringify(e)));
    socket.on("close", off);
  });

  app.addHook("onClose", async () => { await mcp.closeAll(); });

  return app;
}

// 直接运行时启动（用 pathToFileURL 规范化，跨平台可靠：Windows 下 argv[1] 是反斜杠路径，
// 直接拼 file:// 永不等于 import.meta.url，会导致 listen 不执行、进程空跑退出）
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const app = await buildServer(process.env.TRACEFORGE_DB ?? "live.sqlite");
  await app.listen({ port: 4000, host: "127.0.0.1" });
  console.log("TraceForge server listening on http://127.0.0.1:4000");
}
