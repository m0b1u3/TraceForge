import { describe, expect, it } from "vitest";
import type { PermissionProfile } from "@traceforge/orchestration-core";
import type { ToolExecutionResult } from "./model.js";
import {
  createExecutionToolRegistry,
  PolicyExecutionToolGateway,
  type ToolGatewayPolicy,
  type ToolInvocationBinding,
  type ToolInvocationBindingInput,
  type ToolInvocationBindingStore,
  type ToolReceiptStore,
} from "./tool-gateway.js";
import { ExecutionToolDiscoveryRuntime } from "./tool-discovery.js";
import { assignment } from "./test-fixtures.js";

class Receipts implements ToolReceiptStore {
  values = new Map<string, ToolExecutionResult>();
  async get(key: string) { return this.values.get(key); }
  async put(key: string, value: ToolExecutionResult) { this.values.set(key, value); }
}

class Bindings implements ToolInvocationBindingStore {
  async assertReceiptIdentity() {}
  async beginExecution() {}
  async markUncertain() {}
  async assertWorkReady() {}
  values = new Map<string, ToolInvocationBinding>();
  closed = new Set<string>();
  async prepare(input: ToolInvocationBindingInput) {
    const existing = this.values.get(input.idempotencyKey);
    if (existing) {
      const comparable = { ...existing, schemaVersion: undefined, status: undefined, createdAt: undefined, updatedAt: undefined };
      if (JSON.stringify(comparable) !== JSON.stringify(input)) throw new Error("binding conflict");
      return existing;
    }
    if (this.closed.has(`${input.tool.source}@${input.tool.version}`)) throw new Error("admission closed");
    const value: ToolInvocationBinding = {
      schemaVersion: 1, ...structuredClone(input), status: "prepared",
      createdAt: "2026-08-29T00:00:00.000Z", updatedAt: "2026-08-29T00:00:00.000Z",
    };
    this.values.set(input.idempotencyKey, value);
    return value;
  }
  async complete(key: string) {
    const value = this.values.get(key);
    if (value) this.values.set(key, { ...value, status: "completed" });
  }
  async release(key: string, _reason: string) {
    const value = this.values.get(key);
    if (value) this.values.set(key, { ...value, status: "released" });
  }
  async hasOpenBindings(source: string, version: string) {
    return [...this.values.values()].some((value) => value.tool.source === source && value.tool.version === version && value.status === "prepared");
  }
  async closeAdmission(source: string, version: string, _reason: string) { this.closed.add(`${source}@${version}`); }
  async openAdmission(source: string, version: string) { this.closed.delete(`${source}@${version}`); }
}

const permissions: PermissionProfile = {
  version: 1,
  platform: "windows",
  filesystem: { read: [], write: [], deny: [] },
  network: "direct",
  process: { access: "sandboxed", interactive: false, background: false },
  secrets: "handles_only",
};

const policy: ToolGatewayPolicy = {
  allowedRisks: ["read_only"],
  permissionLayers: () => [{ source: "test", profile: permissions }],
};

describe("PolicyExecutionToolGateway", () => {
  it.each(["approval","dispatch"])("rechecks host authorization after %s waits without executing the tool",async phase=>{
    let allowed=true,effects=0;const receipts=new Receipts(),bindings=new Bindings();
    if(phase==="dispatch")bindings.beginExecution=async()=>{allowed=false;};
    const gateway=new PolicyExecutionToolGateway(createExecutionToolRegistry([{name:"read",source:"test",version:"1",priority:1,
      description:"Read",inputSchema:{},providedCapabilities:["evidence.read"],dependencyCapabilities:[],permissionRequirements:{},risk:"privileged",timeoutMs:1000,
      async execute(){effects++;return {status:"succeeded",summary:"Read",raw:"",refs:[],retryable:false};}}]),
      {async authorize(){if(phase==="approval")allowed=false;return {decision:"approved"};}},receipts,
      {...policy,allowedRisks:["privileged"],assertAuthorized(){if(!allowed)throw new Error("Scope revoked");}},undefined,bindings);
    const {assignment:current,worker}=assignment();current.work.requiredCapabilities=["evidence.read"];
    await expect(gateway.execute({worker,assignment:current,invocation:{id:"first",tool:"read",input:{},rationale:"Read"},idempotencyKey:"first"})).rejects.toThrow(phase==="approval"?"Scope revoked":"reconciliation");
    expect(effects).toBe(0);expect(receipts.values.size).toBe(0);
  });
  it("keeps a cancelled dispatched action uncertain and refuses its late result as a receipt", async () => {
    const receipts = new Receipts(), bindings = new Bindings(), controller = new AbortController();
    let uncertain = false, started!: () => void, release!: (value: ToolExecutionResult) => void, seen: AbortSignal | undefined;
    bindings.markUncertain = async () => { uncertain = true; };
    const ready = new Promise<void>((r) => { started = r; });
    const gateway = new PolicyExecutionToolGateway(createExecutionToolRegistry([{ name: "read", source: "test", version: "1", priority: 1,
      description: "Read", inputSchema: {}, providedCapabilities: ["evidence.read"], dependencyCapabilities: [], permissionRequirements: {}, risk: "read_only", timeoutMs: 10000,
      execute(_input, context) { seen = context.signal; started(); return new Promise((resolve) => { release = resolve; }); } }]), { async authorize() { return { decision: "approved" }; } }, receipts, policy, undefined, bindings);
    const { assignment: current, worker } = assignment();
    current.work.requiredCapabilities = ["evidence.read"];
    const call = gateway.execute({ worker, assignment: current, invocation: { id: "first", tool: "read", input: {}, rationale: "Observe" }, idempotencyKey: "first", signal: controller.signal });
    const rejected = expect(call).rejects.toThrow("reconciliation"); await ready; controller.abort(new Error("operator stopped")); await rejected;
    expect(seen?.aborted).toBe(true); expect(uncertain).toBe(true); expect(receipts.values.size).toBe(0);
    release({ status: "succeeded", summary: "late", raw: "late", refs: [], retryable: false }); await new Promise((r) => setTimeout(r, 0)); expect(receipts.values.size).toBe(0);
  });
  it("rejects a pre-cancelled request before discovery or invocation preparation", async () => {
    const bindings = new Bindings(), controller = new AbortController(); controller.abort(new Error("already stopped"));
    const gateway = new PolicyExecutionToolGateway(createExecutionToolRegistry([]), { async authorize() { throw new Error("must not authorize"); } }, new Receipts(), policy, undefined, bindings);
    await expect(gateway.execute({ ...assignment(),
      invocation: { id: "first", tool: "read", input: {}, rationale: "Observe" }, idempotencyKey: "first", signal: controller.signal })).rejects.toThrow("already stopped");
    expect(bindings.values.size).toBe(0);
  });
  it("refreshes due discovery sources before resolving the model catalog", async () => {
    const adapter = {
      name: "discovered", source: "external", version: "1.0.0", priority: 100, description: "Discovered", inputSchema: {},
      providedCapabilities: ["evidence.read"], dependencyCapabilities: [], permissionRequirements: {}, risk: "read_only" as const, timeoutMs: 1_000,
      async execute() { return { status: "succeeded" as const, summary: "done", raw: "", refs: [], retryable: false }; },
    };
    const discovery = new ExecutionToolDiscoveryRuntime([{ source: "external", async discover() { return [adapter]; } }]);
    const gateway = new PolicyExecutionToolGateway(
      discovery.registry, { async authorize() { return { decision: "approved" }; } }, new Receipts(), policy, discovery,
    );
    const input = assignment();
    input.assignment.work.requiredCapabilities = ["evidence.read"];
    expect((await gateway.catalog(input.worker, input.assignment)).tools.map((tool) => tool.name)).toEqual(["discovered"]);
    expect(discovery.snapshot().sources[0].status).toBe("ready");
  });

  it("filters tools by capability and persists idempotent receipts", async () => {
    let executions = 0;
    let permissionSources: string[] = [];
    const receipts = new Receipts();
    const gateway = new PolicyExecutionToolGateway(createExecutionToolRegistry([{
      name: "read", source: "test", version: "1.0.0", priority: 100, description: "Read", inputSchema: {}, providedCapabilities: ["evidence.read"], dependencyCapabilities: [], permissionRequirements: { network: "brokered" }, risk: "read_only", timeoutMs: 1_000,
      async execute(_input, context) {
        executions += 1;
        permissionSources = context.effectivePermissions.sources;
        return { status: "succeeded", summary: "done", raw: "raw", refs: [], retryable: false };
      },
    }]), { async authorize() { return { decision: "approved" }; } }, receipts, policy);
    const input = assignment();
    input.assignment.work.requiredCapabilities = ["evidence.read"];
    expect((await gateway.catalog(input.worker, input.assignment)).tools.map((tool) => tool.name)).toEqual(["read"]);
    const request = { worker: input.worker, assignment: input.assignment, invocation: { id: "call_1", tool: "read", input: {}, rationale: "read" }, idempotencyKey: "effect:call_1" };
    const first = await gateway.execute(request);
    await gateway.execute(request);
    expect(executions).toBe(1);
    expect(permissionSources).toEqual(["test"]);
    expect(first.metadata?.effectivePermissions).toMatchObject({ network: "direct", sources: ["test"] });
  });

  it("does not dispatch when the tool contract changed after its checkpoint", async () => {
    let calls = 0;
    const gateway = new PolicyExecutionToolGateway(createExecutionToolRegistry([{
      name: "read", source: "test", version: "2", priority: 1, description: "Read", inputSchema: {},
      providedCapabilities: ["evidence.read"], dependencyCapabilities: [], permissionRequirements: {}, risk: "read_only", timeoutMs: 1000,
      async execute() { calls++; return { status: "succeeded", summary: "done", raw: "", refs: [], retryable: false }; },
    }]), { async authorize() { return { decision: "approved" }; } }, new Receipts(), policy);
    const input = assignment();
    input.assignment.work.requiredCapabilities = ["evidence.read"];
    await expect(gateway.execute({ ...input, invocation: { id: "first", tool: "read", input: {}, rationale: "Observe" },
      idempotencyKey: "effect:first", expectedContractFingerprint: "0".repeat(64) })).rejects.toThrow("contract changed");
    expect(calls).toBe(0);
  });

  it("removes tools whose permission requirements exceed the effective profile", async () => {
    const gateway = new PolicyExecutionToolGateway(createExecutionToolRegistry([{
      name: "network", source: "test", version: "1.0.0", priority: 100, description: "Network", inputSchema: {}, providedCapabilities: ["network.read"], dependencyCapabilities: [], permissionRequirements: { network: "brokered" }, risk: "read_only", timeoutMs: 1_000,
      async execute() { return { status: "succeeded", summary: "done", raw: "", refs: [], retryable: false }; },
    }]), { async authorize() { return { decision: "approved" }; } }, new Receipts(), {
      allowedRisks: ["read_only"],
      permissionLayers: () => [{ source: "offline-run", profile: { ...permissions, network: "deny" } }],
    });
    const input = assignment();
    input.worker.capabilities.push("network.read");
    input.assignment.work.requiredCapabilities = ["network.read"];
    expect((await gateway.catalog(input.worker, input.assignment)).tools).toEqual([]);
    await expect(gateway.execute({
      worker: input.worker,
      assignment: input.assignment,
      invocation: { id: "call_network", tool: "network", input: {}, rationale: "network" },
      idempotencyKey: "effect:call_network",
    })).rejects.toThrow(/outside worker policy/);
  });

  it("returns an approval requirement without executing privileged tools", async () => {
    let executions = 0;
    const gateway = new PolicyExecutionToolGateway(createExecutionToolRegistry([{
      name: "privileged", source: "test", version: "1.0.0", priority: 100, description: "Privileged", inputSchema: {}, providedCapabilities: ["host.privileged"], dependencyCapabilities: [], permissionRequirements: {}, risk: "privileged", timeoutMs: 1_000,
      async execute() { executions += 1; return { status: "succeeded", summary: "done", raw: "", refs: [], retryable: false }; },
    }]), { async authorize() { return { decision: "pending", approvalRef: "approval_1" }; } }, new Receipts(), { ...policy, allowedRisks: ["privileged"] });
    const input = assignment();
    input.worker.capabilities.push("host.privileged");
    input.assignment.work.requiredCapabilities = ["host.privileged"];
    const result = await gateway.execute({
      worker: input.worker, assignment: input.assignment,
      invocation: { id: "call_1", tool: "privileged", input: {}, rationale: "required action" }, idempotencyKey: "effect:call_1",
    });
    expect(result).toMatchObject({ status: "approval_required", approvalRef: "approval_1" });
    expect(executions).toBe(0);
    input.assignment.work.grantedActionKeys.push("effect:call_1");
    const resumed = await gateway.execute({
      worker: input.worker, assignment: input.assignment,
      invocation: { id: "call_1", tool: "privileged", input: {}, rationale: "required action" }, idempotencyKey: "effect:call_1",
    });
    expect(resumed.status).toBe("succeeded");
    expect(executions).toBe(1);
  });

  it("pins a prepared invocation to its exact tool contract across approval resume", async () => {
    const bindings = new Bindings();
    const registry = createExecutionToolRegistry([{
      name: "bounded", source: "managed.neutral", version: "1.0.0", priority: 100, description: "Bounded",
      inputSchema: { type: "object" }, providedCapabilities: ["host.bounded"], dependencyCapabilities: [],
      permissionRequirements: {}, risk: "privileged" as const, timeoutMs: 1_000,
      async execute() { return { status: "succeeded" as const, summary: "done", raw: "", refs: [], retryable: false }; },
    }]);
    const gateway = new PolicyExecutionToolGateway(
      registry,
      { async authorize() { return { decision: "pending" as const, approvalRef: "approval-binding" }; } },
      new Receipts(),
      { ...policy, allowedRisks: ["privileged"] },
      undefined,
      bindings,
    );
    const input = assignment();
    input.worker.capabilities.push("host.bounded");
    input.assignment.work.requiredCapabilities = ["host.bounded"];
    const request = {
      worker: input.worker, assignment: input.assignment,
      invocation: { id: "binding-call", tool: "bounded", input: { candidate: "first" }, rationale: "inspect" },
      idempotencyKey: "effect:binding-call",
    };
    await expect(gateway.execute(request)).resolves.toMatchObject({ status: "approval_required" });
    expect(bindings.values.get(request.idempotencyKey)).toMatchObject({
      status: "prepared",
      tool: { name: "bounded", source: "managed.neutral", version: "1.0.0", contractFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) },
      inputFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      attribution: { caseId: input.assignment.runContext.caseId, runId: input.assignment.runId, workId: input.assignment.work.id },
    });

    registry.synchronize("managed.neutral", [{
      ...registry.get("bounded")!.provider,
      version: "2.0.0",
      async execute() { return { status: "succeeded" as const, summary: "new", raw: "", refs: [], retryable: false }; },
    }]);
    input.assignment.work.grantedActionKeys.push(request.idempotencyKey);
    await expect(gateway.execute(request)).rejects.toThrow("binding conflict");
    expect(bindings.values.get(request.idempotencyKey)?.status).toBe("prepared");
  });

  it("returns adapter failures as durable observations instead of crashing the Work", async () => {
    let executions = 0;
    const receipts = new Receipts();
    const gateway = new PolicyExecutionToolGateway(createExecutionToolRegistry([{
      name: "read", source: "test", version: "1.0.0", priority: 100, description: "Read", inputSchema: {}, providedCapabilities: ["evidence.read"], dependencyCapabilities: [], permissionRequirements: {}, risk: "read_only", timeoutMs: 1_000,
      async execute() { executions += 1; throw new Error("target is outside authorization"); },
    }]), { async authorize() { return { decision: "approved" }; } }, receipts, policy);
    const input = assignment();
    input.assignment.work.requiredCapabilities = ["evidence.read"];
    const request = {
      worker: input.worker,
      assignment: input.assignment,
      invocation: { id: "call_failed", tool: "read", input: {}, rationale: "read" },
      idempotencyKey: "effect:call_failed",
    };
    const first = await gateway.execute(request);
    const replay = await gateway.execute(request);
    expect(first).toMatchObject({ status: "failed", retryable: false });
    expect(first.summary).toContain("outside authorization");
    expect(replay).toEqual(first);
    expect(executions).toBe(1);
  });

  it("exposes only the minimal provider set including transitive dependencies", async () => {
    const registry = createExecutionToolRegistry([{
      name: "request", source: "test", version: "1.0.0", priority: 100, description: "Request", inputSchema: {},
      providedCapabilities: ["web.request"], dependencyCapabilities: ["session.open"], permissionRequirements: {}, risk: "read_only", timeoutMs: 1_000,
      async execute() { return { status: "succeeded", summary: "done", raw: "", refs: [], retryable: false }; },
    }, {
      name: "session", source: "test", version: "1.0.0", priority: 100, description: "Session", inputSchema: {},
      providedCapabilities: ["session.open"], dependencyCapabilities: [], permissionRequirements: {}, risk: "read_only", timeoutMs: 1_000,
      async execute() { return { status: "succeeded", summary: "done", raw: "", refs: [], retryable: false }; },
    }, {
      name: "unrelated", source: "test", version: "1.0.0", priority: 100, description: "Unrelated", inputSchema: {},
      providedCapabilities: ["filesystem.read"], dependencyCapabilities: [], permissionRequirements: {}, risk: "read_only", timeoutMs: 1_000,
      async execute() { return { status: "succeeded", summary: "done", raw: "", refs: [], retryable: false }; },
    }]);
    const gateway = new PolicyExecutionToolGateway(registry, { async authorize() { return { decision: "approved" }; } }, new Receipts(), policy);
    const input = assignment();
    input.worker.capabilities.push("web.request", "session.open", "filesystem.read");
    input.assignment.work.requiredCapabilities = ["web.request"];
    expect((await gateway.catalog(input.worker, input.assignment)).tools.map((tool) => tool.name)).toEqual(["request", "session"]);
  });

  it("removes unhealthy and draining providers from future catalogs", async () => {
    const adapter = (name: string, priority: number) => ({
      name, source: "test", version: "1.0.0", priority, description: name, inputSchema: {}, providedCapabilities: ["evidence.read"], dependencyCapabilities: [],
      permissionRequirements: {}, risk: "read_only" as const, timeoutMs: 1_000,
      async execute() { return { status: "succeeded" as const, summary: "done", raw: "", refs: [], retryable: false }; },
    });
    const registry = createExecutionToolRegistry([adapter("primary", 100), adapter("fallback", 10)]);
    const gateway = new PolicyExecutionToolGateway(registry, { async authorize() { return { decision: "approved" }; } }, new Receipts(), policy);
    const input = assignment();
    input.assignment.work.requiredCapabilities = ["evidence.read"];
    expect((await gateway.catalog(input.worker, input.assignment)).tools.map((tool) => tool.name)).toEqual(["primary"]);
    registry.setHealth("primary", "unavailable", "health probe failed");
    expect((await gateway.catalog(input.worker, input.assignment)).tools.map((tool) => tool.name)).toEqual(["fallback"]);
    registry.setLifecycle("fallback", "draining");
    expect((await gateway.catalog(input.worker, input.assignment)).tools).toEqual([]);
  });

  it("removes a provider after repeated retryable results", async () => {
    const registry = createExecutionToolRegistry([{
      name: "unstable", source: "test", version: "1.0.0", priority: 100, description: "Unstable", inputSchema: {},
      providedCapabilities: ["evidence.read"], dependencyCapabilities: [], permissionRequirements: {}, risk: "read_only", timeoutMs: 1_000,
      async execute() { return { status: "failed" as const, summary: "temporary transport failure", raw: "", refs: [], retryable: true }; },
    }], 2);
    const gateway = new PolicyExecutionToolGateway(registry, { async authorize() { return { decision: "approved" }; } }, new Receipts(), policy);
    const input = assignment();
    input.assignment.work.requiredCapabilities = ["evidence.read"];
    for (const id of ["first", "second"]) {
      await gateway.execute({
        worker: input.worker, assignment: input.assignment,
        invocation: { id, tool: "unstable", input: {}, rationale: "read" }, idempotencyKey: `effect:${id}`,
      });
    }
    expect(registry.get("unstable")).toMatchObject({ health: "unavailable", consecutiveFailures: 2 });
    expect((await gateway.catalog(input.worker, input.assignment)).tools).toEqual([]);
  });

  it("honors an adapter's explicit retryable transport error", async () => {
    const registry = createExecutionToolRegistry([{
      name: "remote", source: "test", version: "1.0.0", priority: 100, description: "Remote", inputSchema: {},
      providedCapabilities: ["evidence.read"], dependencyCapabilities: [], permissionRequirements: {}, risk: "read_only", timeoutMs: 1_000,
      async execute() { throw Object.assign(new Error("provider disconnected"), { retryable: true }); },
    }], 1);
    const gateway = new PolicyExecutionToolGateway(registry, { async authorize() { return { decision: "approved" }; } }, new Receipts(), policy);
    const input = assignment();
    input.assignment.work.requiredCapabilities = ["evidence.read"];
    const result = await gateway.execute({
      worker: input.worker, assignment: input.assignment,
      invocation: { id: "remote", tool: "remote", input: {}, rationale: "read" }, idempotencyKey: "effect:remote",
    });
    expect(result).toMatchObject({ status: "failed", retryable: true });
    expect(registry.get("remote")).toMatchObject({ health: "unavailable" });
  });
});
