import type { FastifyInstance } from "fastify";
import type { ExecutionToolDiscoveryRuntime } from "@traceforge/worker-runtime";

export function registerExecutionToolRuntimeRoutes(app: FastifyInstance, runtime: ExecutionToolDiscoveryRuntime, startupState?: () => string): void {
  app.get("/api/security-tools/runtime", async () => ({ ...runtime.snapshot(), ...(startupState ? { startupState: startupState() } : {}) }));
}
