import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { ExecutionToolDiscoveryRuntime, staticExecutionToolSource, type ExecutionToolAdapter } from "@traceforge/worker-runtime";
import { registerExecutionToolRuntimeRoutes } from "./execution-tool-runtime-routes.js";

const adapter: ExecutionToolAdapter = {
  name: "knowledge.read", source: "test", version: "1.0.0", priority: 100, description: "Read knowledge", inputSchema: {},
  providedCapabilities: ["knowledge.read"], dependencyCapabilities: [], permissionRequirements: {}, risk: "read_only", timeoutMs: 1_000,
  async execute() { return { status: "succeeded", summary: "done", raw: "", refs: [], retryable: false }; },
};

describe("execution tool runtime routes", () => {
  it("returns lifecycle metadata without executable implementations", async () => {
    const app = Fastify();
    const runtime = new ExecutionToolDiscoveryRuntime([staticExecutionToolSource("test", [adapter])]);
    await runtime.refresh();
    registerExecutionToolRuntimeRoutes(app, runtime);
    const response = await app.inject({ method: "GET", url: "/api/security-tools/runtime" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: "ready", sources: [{ source: "test", status: "ready" }],
      providers: [{ tool: { name: "knowledge.read", providedCapabilities: ["knowledge.read"] }, lifecycle: "active", health: "healthy" }],
    });
    expect(response.body).not.toContain("execute");
    await app.close();
  });
});
