import { afterEach, describe, expect, it } from "vitest";
import { ScenarioPackageRegistry } from "@traceforge/scenario-sdk";
import { createFoundationMcpSource, mcpToolProfileDigest, type FoundationMcpServer } from "./mcp-execution-source.js";
import { fixtureMcpNode } from "./test-fixtures/mcp-node.js";
import { contextBinding, contextPackage, contextText } from "./test-fixtures/context-package.js";
import { foundationHost, eventually } from "./test-fixtures/foundation-host.js";
import { database } from "./test-fixtures/execution-recovery.js";
import { ToolProviderFairScheduler } from "@traceforge/worker-runtime";
import { ProcessExecutionCapacity } from "./process-execution-capacity.js";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const packages = () => new ScenarioPackageRegistry([contextPackage(["fixture.read"])]);
function config(fixture: ReturnType<typeof fixtureMcpNode>): FoundationMcpServer {
  return { source: "fixture.mcp", serverName: "neutral", serverVersion: "1", reviewVersion: 1,
    packages: [{ id: "neutral", version: "1.0.0", schemaRevision: 1 }], tools: [{ remoteName: "observe", authorizationAction: "fixture.read",
    authorizeInput() {}, // neutral fixture has no external target
    validateInput(input) { if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length) throw new Error("Invalid input"); },
    tool: { name: "fixture.mcp.observe", source: "fixture.mcp", version: "1", priority: 100, description: "Host-reviewed neutral observation",
      inputSchema: fixture.inputSchema, providedCapabilities: ["fixture.read"], dependencyCapabilities: [], permissionRequirements: {}, risk: "read_only", timeoutMs: 1000 } }],
    process: { executable: "fixture-only", workingDirectory: "/fixture", attribution: { runId: "service", caseId: "service", workId: "service", workerId: "service",
      leaseId: "service", leaseExpiresAt: "2099-01-01", scopeRef: "service", actionId: "discovery", idempotencyKey: "discovery" },
      permissions: { version: 1, platform: "linux", filesystem: { read: [], write: [], deny: [] }, network: "deny", process: { access: "sandboxed", background: false, interactive: false }, secrets: "deny", sources: ["test-only"] },
      resources: { cpuTimeMs: 10000, memoryBytes: 128 * 1024 * 1024, maximumProcesses: 1, writeBytes: 0 }, requestTimeoutMs: 150, maximumFrameBytes: 8192 } };
}
async function host(fixture: ReturnType<typeof fixtureMcpNode>, server = config(fixture), overrides: { failResultCheckpoint?: boolean; root?: string; denied?: boolean; invalidInput?: boolean; perWork?: number } = {}) {
  const pkg = contextPackage(["fixture.read"]);
  if (overrides.denied) (pkg.authorizationPolicy as { authorizeResource?: () => string }).authorizeResource = () => { throw new Error("Denied"); };
  const h = await foundationHost({ ...overrides, foundation: { scenarioPackageRegistry: new ScenarioPackageRegistry([pkg]), executionNode: fixture.node,
    contextResourceContents: [{ package: contextBinding, resourceId: "first", content: contextText }],
    toolDiscoverySources: [], mcpServers: [server], executionSchedulingLimits:{perWork:overrides.perWork??1} }, model: async (args) => {
    const c = JSON.parse(args.user);
    if (c.transcript.some((t: { kind: string }) => t.kind === "tool")) return { type: "complete", summary: "Observed", outputs: [] };
    return { type: "invoke_tool", invocation: { id: "first", tool: "fixture.mcp.observe", input: overrides.invalidInput ? { extra: true } : {}, rationale: "Observe" } };
  } }); cleanup.push(() => h.sqlite.open ? h.close() : undefined); return h;
}

describe("MCP controlled foundation assembly", () => {
  it("retains discovery against the shared global quota across sources and restart",async()=>{
    const f=fixtureMcpNode(),sqlite=database();cleanup.push(()=>{sqlite.close();});
    const capacity=new ProcessExecutionCapacity(sqlite,new ToolProviderFairScheduler({global:1,maximumWaitMs:15}));
    const source=createFoundationMcpSource(config(f),f.node,sqlite,packages(),()=>null,capacity);cleanup.push(()=>source.close!());
    await source.discover();expect(f.starts).toHaveLength(1);expect(capacity.scheduler.snapshot().retained).toBe(1);
    const restored=new ProcessExecutionCapacity(sqlite,new ToolProviderFairScheduler({global:1,maximumWaitMs:15}));
    const other=fixtureMcpNode(),otherConfig=config(other);otherConfig.source="another.mcp";otherConfig.tools.forEach(t=>t.tool.source=otherConfig.source);
    const next=createFoundationMcpSource(otherConfig,other.node,sqlite,packages(),()=>null,restored);cleanup.push(()=>next.close!());
    await expect(next.discover()).rejects.toMatchObject({reason:"wait_timeout"});expect(other.starts).toHaveLength(0);
    expect(restored.scheduler.snapshot()).toMatchObject({active:0,retained:1});
  });
  it("cancels a queued MCP discovery on source shutdown without starting another process",async()=>{
    const f=fixtureMcpNode(),sqlite=database();cleanup.push(()=>{sqlite.close();});
    const capacity=new ProcessExecutionCapacity(sqlite,new ToolProviderFairScheduler({global:1}));
    const source=createFoundationMcpSource(config(f),f.node,sqlite,packages(),()=>null,capacity);
    await source.discover();const pending=source.discover();await source.close!();
    await expect(pending).rejects.toMatchObject({reason:"cancelled"});expect(f.starts).toHaveLength(1);
    expect(capacity.scheduler.snapshot()).toMatchObject({active:0,retained:1,queued:0});
  });
  it("refuses to compose without an Execution Node", () => {
    const sqlite = database(); cleanup.push(() => { sqlite.close(); });
    expect(() => createFoundationMcpSource(config(fixtureMcpNode()), undefined, sqlite, packages(), () => null)).toThrow("Execution Node");
  });
  it.each(["invalidAttestation", "schemaMismatch", "versionMismatch"] as const)("rejects %s before admitting tools and closes the process", async (mode) => {
    const fixture = fixtureMcpNode({ [mode]: true }); const sqlite = database(); cleanup.push(() => { sqlite.close(); });
    const source = createFoundationMcpSource(config(fixture), fixture.node, sqlite, packages(), () => null);
    await expect(source.discover()).rejects.toThrow(); expect(fixture.calls()).toBe(0); expect(fixture.terminated()).toBe(1);
  });
  it("runs via HTTP Worker/Gateway, strips untrusted instructions, records output, and isolates processes across Runs", async () => {
    const f = fixtureMcpNode(); const h = await host(f); await h.start("first");
    await eventually(async () => (await h.state("first")).workItems[0]?.status === "completed");
    await h.start("second"); await eventually(async () => (await h.state("second")).workItems[0]?.status === "completed");
    expect(f.calls()).toBe(2); expect(f.starts).toHaveLength(3); expect(f.terminated()).toBe(3);
    expect(f.starts.slice(1).map((s) => s.attribution.runId)).toEqual(["first", "second"]);
    expect(JSON.stringify(h.requests)).not.toContain("UNTRUSTED_");
    expect(JSON.stringify(h.requests)).toContain("neutral observation");
    expect(h.sqlite.prepare("SELECT count(*) AS n FROM worker_tool_receipts").get()).toEqual({ n: 2 });
    expect(f.messages.filter((m) => m.method === "tools/call").every((m) => !JSON.stringify(m).includes("scopeRef"))).toBe(true);
    expect(h.sqlite.prepare("SELECT state,count(*) AS n FROM process_execution_occupancy GROUP BY state").all()).toEqual([{state:"terminal_observed",n:3}]);
    const service=await h.request("/api/security-tools/process-occupancies?caseId=service&runId=service");
    expect(service.items).toHaveLength(1);expect(service.items[0].identity.kind).toBe("service");
    expect(await h.request("/api/security-tools/process-capacity-policy")).toMatchObject({limits:{perWork:1},coverage:{
      builtinProcess:true,defaultManagedProviders:true,mcpTools:["fixture.mcp"],customSourcesAndScenarioExecutionPorts:"host_scoped",automaticCleanupProofIssuer:false}});
    expect(await h.request("/api/foundation/extension-assembly")).toMatchObject({state:"ready",generation:1,
      unitCounts:{package:1,skill:1,mcp_tool_profile:1}});
  });
  it.each(["denied", "invalidInput"] as const)("records %s without starting an invocation process", async (mode) => {
    const f = fixtureMcpNode(); const h = await host(f, config(f), { [mode]: true }); await h.start();
    await eventually(async () => (await h.state()).workItems[0]?.status === "completed");
    expect(f.calls()).toBe(0); expect(f.starts).toHaveLength(1);
    expect(h.sqlite.prepare("SELECT result_json FROM worker_tool_receipts").get()).toMatchObject({ result_json: expect.stringContaining("rejected by host") });
  });
  it("retains host approval requirements despite MCP readOnlyHint", async () => {
    const f = fixtureMcpNode(); const server = config(f); server.tools[0]!.tool.risk = "privileged";
    const h = await host(f, server); await h.start();
    await eventually(async () => (await h.state()).workItems[0]?.status === "waiting_approval");
    expect(f.calls()).toBe(0); expect(f.starts).toHaveLength(1);
  });
  it("requires input-scope authorization independently of a valid schema and tool grant", async () => {
    const f = fixtureMcpNode(); const server = config(f); server.tools[0]!.authorizeInput = () => { throw new Error("Out of scope"); };
    const h = await host(f, server); await h.start();
    await eventually(async () => (await h.state()).workItems[0]?.status === "completed");
    expect(f.calls()).toBe(0); expect(f.starts).toHaveLength(1);
  });
  it("does not let another installed Package use a profile with matching capabilities", async () => {
    const f = fixtureMcpNode(); const server = config(f), other = contextPackage(["fixture.read"]);
    other.id = "other"; other.version = "1.0.0"; other.definition = { ...other.definition, kind: "other-neutral", version: 1 };
    other.resourceManifest = undefined; server.packages = [{ id: other.id, version: other.version, schemaRevision: other.schemaRevision }];
    const h = await foundationHost({ foundation: { scenarioPackageRegistry: new ScenarioPackageRegistry([contextPackage(["fixture.read"]), other]),
      executionNode: f.node, contextResourceContents: [{ package: contextBinding, resourceId: "first", content: contextText }],
      toolDiscoverySources: [], mcpServers: [server] }, model: async (args) => JSON.parse(args.user).transcript.some((entry: { kind: string }) => entry.kind === "tool")
      ? { type: "complete", summary: "Rejected cross-Package use", outputs: [] }
      : { type: "invoke_tool", invocation: { id: "first", tool: "fixture.mcp.observe", input: {}, rationale: "Observe" } } });
    cleanup.push(() => h.close()); await h.start();
    await eventually(async () => (await h.state()).workItems[0]?.status === "completed");
    expect(f.calls()).toBe(0); expect(f.starts).toHaveLength(1);
  });
  it("cuts off a revoked MCP profile after discovery and before invocation", async () => {
    const f = fixtureMcpNode(); const server = config(f); let h!: Awaited<ReturnType<typeof foundationHost>>;
    h = await foundationHost({ foundation: { scenarioPackageRegistry: packages(), executionNode: f.node,
      contextResourceContents: [{ package: contextBinding, resourceId: "first", content: contextText }],
      toolDiscoverySources: [], mcpServers: [server], extensionAssembly: { revokeAuthorizer: { async authorize() {
        return { decision: "allowed" as const, authorizationRef: "independent-extension-review", expiresAt: "2099-01-01T00:00:00.000Z" };
      } } } }, model: async (args) => {
      if (JSON.parse(args.user).transcript.some((entry: { kind: string }) => entry.kind === "tool")) {
        return { type: "complete", summary: "Profile withdrawal observed", outputs: [] };
      }
      await h.request("/api/foundation/extension-assembly/profiles/revoke", { commandId: "withdraw_tool_profile", kind: "mcp_tool",
        source: server.source, profileDigest: mcpToolProfileDigest(server), actor: "operator", reason: "review withdrawn" });
      return { type: "invoke_tool", invocation: { id: "first", tool: "fixture.mcp.observe", input: {}, rationale: "Observe" } };
    } }); cleanup.push(() => h.close());
    await h.start(); await eventually(async () => (await h.state()).workItems[0]?.status === "completed");
    expect(f.calls()).toBe(0); expect(f.starts).toHaveLength(1);
    expect(await h.request("/api/foundation/extension-assembly")).toMatchObject({ state: "unavailable", reason: expect.stringMatching(/revoked/i) });
  });
  it("refuses to publish discovery when cleanup cannot be confirmed", async () => {
    const f = fixtureMcpNode(); const sqlite = database(); cleanup.push(() => { sqlite.close(); });
    const node = { ...f.node, terminateProcess: async () => { throw new Error("cleanup failed"); } };
    const source = createFoundationMcpSource(config(f), node, sqlite, packages(), () => null);
    await expect(source.discover()).rejects.toThrow("cleanup"); expect(f.calls()).toBe(0);
    // The protocol fixture has no OS process; explicitly settle its waiting event stream.
    await f.node.terminateProcess({ operationId: "test-terminate:process-1", processId: "process-1", adoptionToken: "process-1", force: true });
  });
  it("does not turn an interrupted MCP call into an automatic retry", async () => {
    const f = fixtureMcpNode({ hangCall: true }); const h = await host(f); await h.start();
    await eventually(async () => (await h.state()).workItems[0]?.status === "blocked");
    expect(f.calls()).toBe(1); expect(f.terminated()).toBe(2);
    expect(h.sqlite.prepare("SELECT status FROM tool_invocation_executions").get()).toEqual({ status: "uncertain" });
  });
  it("restores a confirmed MCP observation after a host restart without calling MCP again", async () => {
    const f = fixtureMcpNode(); const first = await host(f, config(f), { failResultCheckpoint: true }); await first.start();
    await eventually(async () => (await first.state()).workItems[0]?.status === "failed");
    const before = await first.state(); await first.close(false);
    // One old discovery remains held: explicitly provision another service slot, not a cleanup exemption.
    const nextFixture = fixtureMcpNode(); const next = await host(nextFixture, config(nextFixture), { root: first.root,perWork:2 });
    await next.request("/api/scenarios/runs/run/work/work/continue", { commandId: "continue", actor: "test", reason: "Read confirmed observation",
      expectedRevision: before.revision, checkpointRef: before.workItems[0].latestCheckpoint.payloadRef });
    await eventually(async () => (await next.state()).workItems[0]?.status === "completed");
    expect(nextFixture.calls()).toBe(0); expect(JSON.stringify(next.requests)).toContain("neutral observation");
    expect(next.sqlite.prepare("SELECT count(*) AS n FROM process_execution_occupancy WHERE state!='released'").get()).toEqual({n:3});
  });
});
