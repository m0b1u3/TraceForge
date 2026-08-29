import {
  satisfiesPermissionRequirements,
  type PermissionRequirements,
} from "@traceforge/orchestration-core";
import type { ExecutionRisk } from "./model.js";
import type {
  ProviderCapabilityAuthorizationDecision,
  ProviderCapabilityAuthorizationPort,
  ProviderCapabilityInvocation,
} from "./provider-capability-broker.js";

export interface ProviderCapabilityPolicy {
  capability: string;
  actions: string[];
  permissionRequirements: PermissionRequirements;
  risk: ExecutionRisk;
}

export interface ProviderCapabilityScopeDecision {
  decision: "approved" | "rejected";
  authorizationRef?: string;
  reason?: string;
}

export interface ProviderCapabilityScopeAuthorizationPort {
  authorize(input: {
    invocation: ProviderCapabilityInvocation;
    policy: ProviderCapabilityPolicy;
  }): Promise<ProviderCapabilityScopeDecision>;
}

export interface ProviderCapabilityApprovalPort {
  authorize(input: {
    invocation: ProviderCapabilityInvocation;
    policy: ProviderCapabilityPolicy;
    scopeAuthorizationRef: string;
  }): Promise<ProviderCapabilityAuthorizationDecision>;
}

/** Composes platform permissions, Scenario scope and durable human approval. */
export class PolicyProviderCapabilityAuthorizer implements ProviderCapabilityAuthorizationPort {
  private readonly policies = new Map<string, ProviderCapabilityPolicy>();

  constructor(
    policies: ProviderCapabilityPolicy[],
    private readonly scopes: ProviderCapabilityScopeAuthorizationPort,
    private readonly approvals: ProviderCapabilityApprovalPort,
  ) {
    for (const policy of policies) {
      if (!policy.capability.trim()) throw new Error("Provider capability policy identity is required");
      if (this.policies.has(policy.capability)) throw new Error(`Duplicate Provider capability policy ${policy.capability}`);
      if (!policy.actions.length || policy.actions.some((action) => !action.trim())) {
        throw new Error(`Provider capability policy ${policy.capability} requires explicit actions`);
      }
      this.policies.set(policy.capability, {
        ...policy,
        capability: policy.capability.trim(),
        actions: [...new Set(policy.actions.map((action) => action.trim()))],
      });
    }
  }

  async authorize(invocation: ProviderCapabilityInvocation): Promise<ProviderCapabilityAuthorizationDecision> {
    const policy = this.policies.get(invocation.capability);
    if (!policy) return { decision: "rejected", reason: `Provider capability ${invocation.capability} has no authorization policy` };
    if (!policy.actions.includes(invocation.action)) {
      return { decision: "rejected", reason: `Action ${invocation.action} is not allowed for Provider capability ${invocation.capability}` };
    }
    if (!satisfiesPermissionRequirements(invocation.attribution.effectivePermissions, policy.permissionRequirements)) {
      return { decision: "rejected", reason: `Effective permissions do not satisfy Provider capability ${invocation.capability}` };
    }

    const scope = await this.scopes.authorize({ invocation, policy });
    if (scope.decision === "rejected") return { decision: "rejected", reason: scope.reason ?? "Scenario scope rejected Provider capability" };
    if (!scope.authorizationRef?.trim()) throw new Error("Approved Provider capability scope is missing an authorization reference");
    if (policy.risk !== "privileged" && policy.risk !== "destructive") {
      return { decision: "approved", authorizationRef: scope.authorizationRef };
    }

    const approval = await this.approvals.authorize({
      invocation,
      policy,
      scopeAuthorizationRef: scope.authorizationRef,
    });
    if (approval.decision === "approved") {
      return { decision: "approved", authorizationRef: scope.authorizationRef };
    }
    return { ...approval, authorizationRef: scope.authorizationRef };
  }
}
