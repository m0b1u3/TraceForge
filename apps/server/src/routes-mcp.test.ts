import { afterEach, describe, it, expect, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { createDb } from "./db/client.js";
import { EventBus } from "./event-bus.js";
import { registerRoutes } from "./routes.js";
import { McpManager } from "@traceforge/extension";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

let app: FastifyInstance;
let mcp: McpManager;
let workspace: string;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "tf-routes-mcp-"));
  mcp = new McpManager();
  await mcp.connectAll([{
    name: "poc",
    command: process.execPath,
    args: [resolve("packages/mcp-poc-server/dist/main.js")],
    env: { TRACEFORGE_WORKSPACE: workspace },
  }]);
  app = Fastify();
  const db = createDb(":memory:");
  const bus = new EventBus();
  registerRoutes(app, db, bus, undefined, mcp);
  await app.ready();
});

afterEach(async () => {
  await app.close();
  await mcp.closeAll();
  await rm(workspace, { recursive: true, force: true });
});

describe("mcp routes", () => {
  it("GET /api/mcp/tools lists the namespaced tools", async () => {
    const res = await app.inject({ url: "/api/mcp/tools" });
    expect(res.statusCode).toBe(200);
    const tools = res.json();
    expect(tools).toHaveLength(3);
    expect(tools.some((tool: { serverName: string; toolName: string }) => tool.serverName === "poc" && tool.toolName === "read_file")).toBe(true);
  });
});
