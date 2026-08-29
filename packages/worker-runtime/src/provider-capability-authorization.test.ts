import { describe, expect, it } from "vitest";
import type { EffectivePermissionProfile } from "@traceforge/orchestration-core";
import type { ProviderCapabilityAuthorizationDecision, ProviderCapabilityInvocation } from "./provider-capability-broker.js";
import { PolicyProviderCapabilityAuthorizer, type ProviderCapabilityPolicy } from "./provider-capability-authorization.js";

const permissions: EffectivePermissionProfile = {
  version: 1, platform: "linux", filesystem: { read: [], write: [], deny: [] }, network: "brokered",
  process: { access: "sandboxed", interactive: false, background: false }, secrets: "handles_only", sources: ["fixture"],
};

const policy: ProviderCapabilityPolicy = {
  capability: "fixture.lookup",
  actions: ["fixture.inspect"],
  permissionRequirements: { network: "brokered" },
  risk: "read_only",
};

function invocation(): ProviderCapabilityInvocation {
  return {
    provider: { id: "provider.fixture", version: "1.0.0", generation: 1 }, parentRequestId: "parent-1",
    capability: "fixture.lookup", action: "fixture.inspect", idempotencyKey: "effect-1", input: {}, depth: 1,
    attribution: {
      caseId: "case-1", runId: "run-1", workId: "work-1", workerId: "worker-1", scopeRef: "scope-1",
      leaseId: "lease-1", leaseExpiresAt: "2100-01-01T00:00:00.000Z", idempotencyKey: "tool-effect-1",
      effectivePermissions: permissions,
    },
  };
}

describe("PolicyProviderCapabilityAuthorizer", () => {
  it("composes effective permissions and Scenario scope for ordinary capabilities", async () => {
    let approvalCalls = 0;
    const authorizer = new PolicyProviderCapabilityAuthorizer([policy], {
      async authorize() { return { decision: "approved", authorizationRef: "scope-authorization-1" }; },
    }, {
      async authorize() { approvalCalls += 1; return { decision: "approved" }; },
    });

    await expect(authorizer.authorize(invocation())).resolves.toEqual({
      decision: "approved", authorizationRef: "scope-authorization-1",
    });
    expect(approvalCalls).toBe(0);
  });

  it("rejects unknown capabilities, actions, insufficient permissions, and denied scope", async () => {
    const authorizer = new PolicyProviderCapabilityAuthorizer([policy], {
      async authorize() { return { decision: "rejected", reason: "outside scope" }; },
    }, { async authorize() { return { decision: "approved" }; } });

    await expect(authorizer.authorize({ ...invocation(), capability: "fixture.unknown" })).resolves.toMatchObject({ decision: "rejected", reason: expect.stringContaining("no authorization policy") });
    await expect(authorizer.authorize({ ...invocation(), action: "fixture.change" })).resolves.toMatchObject({ decision: "rejected", reason: expect.stringContaining("not allowed") });
    await expect(authorizer.authorize({
      ...invocation(), attribution: { ...invocation().attribution, effectivePermissions: { ...permissions, network: "deny" } },
    })).resolves.toMatchObject({ decision: "rejected", reason: expect.stringContaining("Effective permissions") });
    await expect(authorizer.authorize(invocation())).resolves.toEqual({ decision: "rejected", reason: "outside scope" });
  });

  it("requires durable approval for privileged policies and preserves the scope authorization", async () => {
    let decision: ProviderCapabilityAuthorizationDecision = { decision: "pending", approvalRef: "approval-1" };
    const authorizer = new PolicyProviderCapabilityAuthorizer([{ ...policy, risk: "privileged" }], {
      async authorize() { return { decision: "approved", authorizationRef: "scope-authorization-1" }; },
    }, {
      async authorize() { return decision; },
    });

    await expect(authorizer.authorize(invocation())).resolves.toEqual({
      decision: "pending", approvalRef: "approval-1", authorizationRef: "scope-authorization-1",
    });
    decision = { decision: "approved" };
    await expect(authorizer.authorize(invocation())).resolves.toEqual({
      decision: "approved", authorizationRef: "scope-authorization-1",
    });
  });

  it("rejects duplicate policies and policies without explicit actions", () => {
    const scopes = { async authorize() { return { decision: "approved" as const, authorizationRef: "scope-1" }; } };
    const approvals = { async authorize() { return { decision: "approved" as const }; } };
    expect(() => new PolicyProviderCapabilityAuthorizer([policy, policy], scopes, approvals)).toThrow(/Duplicate/);
    expect(() => new PolicyProviderCapabilityAuthorizer([{ ...policy, actions: [] }], scopes, approvals)).toThrow(/explicit actions/);
  });
});
