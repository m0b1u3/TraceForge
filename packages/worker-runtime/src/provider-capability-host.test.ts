import { describe, expect, it } from "vitest";
import type { EffectivePermissionProfile } from "@traceforge/orchestration-core";
import { createProviderCapabilityHost, ProviderCapabilityHostRegistry } from "./provider-capability-host.js";
import type { ProviderCapabilityInvocation, ProviderCapabilityReceipt } from "./provider-capability-broker.js";

const permissions: EffectivePermissionProfile = {
  version: 1, platform: "linux", filesystem: { read: [], write: [], deny: [] }, network: "deny",
  process: { access: "sandboxed", interactive: false, background: false }, secrets: "handles_only", sources: ["fixture"],
};

const call: ProviderCapabilityInvocation = {
  provider: { id: "provider.fixture", version: "1.0.0", generation: 1 }, parentRequestId: "parent-1",
  capability: "fixture.lookup", action: "fixture.inspect", idempotencyKey: "effect-1", input: {}, depth: 1,
  attribution: {
    caseId: "case-1", runId: "run-1", workId: "work-1", workerId: "worker-1", scopeRef: "scope-1",
    leaseId: "lease-1", leaseExpiresAt: "2100-01-01T00:00:00.000Z", idempotencyKey: "tool-effect-1",
    effectivePermissions: permissions,
  },
};

function options() {
  const receipts = new Map<string, ProviderCapabilityReceipt>();
  return {
    handlers: [{ capability: "fixture.lookup", async execute() { return { output: { state: "available" }, refs: [] }; } }],
    policies: [{ capability: "fixture.lookup", actions: ["fixture.inspect"], permissionRequirements: {}, risk: "read_only" as const }],
    receipts: {
      async get(providerId: string, idempotencyKey: string) { return receipts.get(`${providerId}:${idempotencyKey}`); },
      async put(receipt: ProviderCapabilityReceipt) { receipts.set(`${receipt.provider.id}:${receipt.idempotencyKey}`, receipt); },
    },
    scopes: { async authorize() { return { decision: "approved" as const, authorizationRef: "scope-1" }; } },
    approvals: { async authorize() { return { decision: "approved" as const }; } },
    createId: () => "receipt-1",
    now: () => "2026-08-28T12:00:00.000Z",
  };
}

describe("ProviderCapabilityHostRegistry", () => {
  it("keeps the host disabled when both Handler and Policy registries are empty", () => {
    expect(createProviderCapabilityHost({ ...options(), handlers: [], policies: [] })).toBeUndefined();
  });

  it("validates and executes a matched neutral Handler and Policy", async () => {
    const host = createProviderCapabilityHost(options());
    expect(host?.snapshot()).toEqual({
      enabled: true,
      capabilities: [{ capability: "fixture.lookup", actions: ["fixture.inspect"], risk: "read_only" }],
    });
    await expect(host?.invoke(call)).resolves.toMatchObject({ status: "succeeded", output: { state: "available" } });
  });

  it("rejects Handlers without Policy and Policies without Handler", () => {
    expect(() => new ProviderCapabilityHostRegistry({ ...options(), policies: [] })).toThrow(/Handlers without Policy/);
    expect(() => new ProviderCapabilityHostRegistry({ ...options(), handlers: [] })).toThrow(/Policies without Handler/);
  });

  it("returns defensive snapshots that cannot mutate authorization policy", () => {
    const host = new ProviderCapabilityHostRegistry(options());
    const snapshot = host.snapshot();
    snapshot.capabilities[0].actions.push("fixture.change");
    expect(host.snapshot().capabilities[0].actions).toEqual(["fixture.inspect"]);
  });
});
