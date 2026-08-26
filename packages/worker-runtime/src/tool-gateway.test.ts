import { describe, expect, it } from "vitest";
import type { PermissionProfile } from "@traceforge/orchestration-core";
import type { ToolExecutionResult } from "./model.js";
import { PolicyExecutionToolGateway, type ToolGatewayPolicy, type ToolReceiptStore } from "./tool-gateway.js";
import { assignment } from "./test-fixtures.js";

class Receipts implements ToolReceiptStore {
  values = new Map<string, ToolExecutionResult>();
  async get(key: string) { return this.values.get(key); }
  async put(key: string, value: ToolExecutionResult) { this.values.set(key, value); }
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
  it("filters tools by capability and persists idempotent receipts", async () => {
    let executions = 0;
    let permissionSources: string[] = [];
    const receipts = new Receipts();
    const gateway = new PolicyExecutionToolGateway([{
      name: "read", description: "Read", inputSchema: {}, requiredCapabilities: ["evidence.read"], permissionRequirements: { network: "brokered" }, risk: "read_only", timeoutMs: 1_000,
      async execute(_input, context) {
        executions += 1;
        permissionSources = context.effectivePermissions.sources;
        return { status: "succeeded", summary: "done", raw: "raw", refs: [], retryable: false };
      },
    }], { async authorize() { return { decision: "approved" }; } }, receipts, policy);
    const input = assignment();
    expect((await gateway.catalog(input.worker, input.assignment)).map((tool) => tool.name)).toEqual(["read"]);
    const request = { worker: input.worker, assignment: input.assignment, invocation: { id: "call_1", tool: "read", input: {}, rationale: "read" }, idempotencyKey: "effect:call_1" };
    const first = await gateway.execute(request);
    await gateway.execute(request);
    expect(executions).toBe(1);
    expect(permissionSources).toEqual(["test"]);
    expect(first.metadata?.effectivePermissions).toMatchObject({ network: "direct", sources: ["test"] });
  });

  it("removes tools whose permission requirements exceed the effective profile", async () => {
    const gateway = new PolicyExecutionToolGateway([{
      name: "network", description: "Network", inputSchema: {}, requiredCapabilities: [], permissionRequirements: { network: "brokered" }, risk: "read_only", timeoutMs: 1_000,
      async execute() { return { status: "succeeded", summary: "done", raw: "", refs: [], retryable: false }; },
    }], { async authorize() { return { decision: "approved" }; } }, new Receipts(), {
      allowedRisks: ["read_only"],
      permissionLayers: () => [{ source: "offline-run", profile: { ...permissions, network: "deny" } }],
    });
    const input = assignment();
    expect(await gateway.catalog(input.worker, input.assignment)).toEqual([]);
    await expect(gateway.execute({
      worker: input.worker,
      assignment: input.assignment,
      invocation: { id: "call_network", tool: "network", input: {}, rationale: "network" },
      idempotencyKey: "effect:call_network",
    })).rejects.toThrow(/outside worker policy/);
  });

  it("returns an approval requirement without executing privileged tools", async () => {
    let executions = 0;
    const gateway = new PolicyExecutionToolGateway([{
      name: "privileged", description: "Privileged", inputSchema: {}, requiredCapabilities: [], permissionRequirements: {}, risk: "privileged", timeoutMs: 1_000,
      async execute() { executions += 1; return { status: "succeeded", summary: "done", raw: "", refs: [], retryable: false }; },
    }], { async authorize() { return { decision: "pending", approvalRef: "approval_1" }; } }, new Receipts(), { ...policy, allowedRisks: ["privileged"] });
    const input = assignment();
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

  it("returns adapter failures as durable observations instead of crashing the Work", async () => {
    let executions = 0;
    const receipts = new Receipts();
    const gateway = new PolicyExecutionToolGateway([{
      name: "read", description: "Read", inputSchema: {}, requiredCapabilities: ["evidence.read"], permissionRequirements: {}, risk: "read_only", timeoutMs: 1_000,
      async execute() { executions += 1; throw new Error("target is outside authorization"); },
    }], { async authorize() { return { decision: "approved" }; } }, receipts, policy);
    const input = assignment();
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
});
