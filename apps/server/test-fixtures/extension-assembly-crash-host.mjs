import { readFileSync, writeSync } from "node:fs";
import { ScenarioPackageRegistry } from "@traceforge/scenario-sdk";
import { createDb, getSqliteClient } from "../src/db/client.js";
import { ExtensionAssemblyControl } from "../src/extension-assembly.js";
import { SqlitePackageContextStore } from "../src/package-context-resources.js";
import { contextBinding, contextPackage } from "../src/test-fixtures/context-package.js";

const { databasePath } = JSON.parse(readFileSync(process.argv[2], "utf8"));
const sqlite = getSqliteClient(createDb(databasePath));
const packages = new ScenarioPackageRegistry([contextPackage(["fixture.read"])]);
const store = new SqlitePackageContextStore(sqlite);
const processOptions = { executable: "/fixture/provider", workingDirectory: "/fixture", environment: {},
  attribution: { caseId: "service", runId: "service", workId: "service", workerId: "service", scopeRef: "service",
    leaseId: "service", leaseExpiresAt: "2099-01-01T00:00:00.000Z", actionId: "discover", idempotencyKey: "discover" },
  permissions: { version: 1, platform: "linux", filesystem: { read: [], write: [], deny: [] }, network: "deny",
    process: { access: "sandboxed", interactive: false, background: false }, secrets: "deny", sources: ["fixture"] },
  resources: { cpuTimeMs: 1_000, memoryBytes: 64 * 1024 * 1024, maximumProcesses: 1, writeBytes: 1_024 }, requestTimeoutMs: 1_000 };
const mcp = { source: "fixture.mcp", serverName: "neutral", serverVersion: "2", reviewVersion: 2, packages: [contextBinding], process: processOptions,
  tools: [{ remoteName: "observe", authorizationAction: "fixture.read", validateInput() {}, authorizeInput() {},
    tool: { name: "fixture.observe", source: "fixture.mcp", version: "1", priority: 100, description: "Neutral observation",
      inputSchema: { type: "object" }, providedCapabilities: ["fixture.read"], dependencyCapabilities: [],
      permissionRequirements: {}, risk: "read_only", timeoutMs: 1_000 } }] };
sqlite.function("extension_activation_checkpoint", () => {
  writeSync(1, `${JSON.stringify({ checkpoint: "before-active-switch" })}\n`);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
});
sqlite.exec(`CREATE TEMP TRIGGER extension_assembly_crash BEFORE UPDATE ON extension_assembly_active
  BEGIN SELECT extension_activation_checkpoint(); END;`);
new ExtensionAssemblyControl(sqlite, packages, store, [mcp], []);
