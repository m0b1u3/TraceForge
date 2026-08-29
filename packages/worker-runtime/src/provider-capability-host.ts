import {
  PolicyProviderCapabilityAuthorizer,
  type ProviderCapabilityApprovalPort,
  type ProviderCapabilityPolicy,
  type ProviderCapabilityScopeAuthorizationPort,
} from "./provider-capability-authorization.js";
import {
  ProviderCapabilityBroker,
  type ProviderCapabilityBrokerLimits,
  type ProviderCapabilityHandler,
  type ProviderCapabilityHost,
  type ProviderCapabilityInvocation,
  type ProviderCapabilityReceipt,
  type ProviderCapabilityReceiptPort,
} from "./provider-capability-broker.js";

export interface ProviderCapabilityHostRegistryOptions {
  handlers: ProviderCapabilityHandler[];
  policies: ProviderCapabilityPolicy[];
  receipts: ProviderCapabilityReceiptPort;
  scopes: ProviderCapabilityScopeAuthorizationPort;
  approvals: ProviderCapabilityApprovalPort;
  limits?: Partial<ProviderCapabilityBrokerLimits>;
  createId?: () => string;
  now?: () => string;
}

export interface ProviderCapabilityHostSnapshot {
  enabled: true;
  capabilities: Array<{ capability: string; actions: string[]; risk: ProviderCapabilityPolicy["risk"] }>;
}

/** Validated composition boundary between generic capability policy and execution handlers. */
export class ProviderCapabilityHostRegistry implements ProviderCapabilityHost {
  private readonly broker: ProviderCapabilityBroker;
  private readonly snapshotValue: ProviderCapabilityHostSnapshot;

  constructor(options: ProviderCapabilityHostRegistryOptions) {
    if (!options.handlers.length && !options.policies.length) {
      throw new Error("Provider capability host requires at least one Handler and Policy");
    }
    const handlers = new Set(options.handlers.map((handler) => handler.capability));
    const policies = new Set(options.policies.map((policy) => policy.capability));
    const missingPolicies = [...handlers].filter((capability) => !policies.has(capability));
    const missingHandlers = [...policies].filter((capability) => !handlers.has(capability));
    if (missingPolicies.length || missingHandlers.length) {
      throw new Error([
        missingPolicies.length ? `Handlers without Policy: ${missingPolicies.sort().join(", ")}` : "",
        missingHandlers.length ? `Policies without Handler: ${missingHandlers.sort().join(", ")}` : "",
      ].filter(Boolean).join("; "));
    }
    const authorizer = new PolicyProviderCapabilityAuthorizer(options.policies, options.scopes, options.approvals);
    this.broker = new ProviderCapabilityBroker({
      authorizer,
      receipts: options.receipts,
      handlers: options.handlers,
      limits: options.limits,
      createId: options.createId,
      now: options.now,
    });
    this.snapshotValue = {
      enabled: true,
      capabilities: options.policies
        .map((policy) => ({ capability: policy.capability, actions: [...policy.actions].sort(), risk: policy.risk }))
        .sort((left, right) => left.capability.localeCompare(right.capability)),
    };
  }

  invoke(input: ProviderCapabilityInvocation): Promise<ProviderCapabilityReceipt> {
    return this.broker.invoke(input);
  }

  snapshot(): ProviderCapabilityHostSnapshot {
    return {
      enabled: true,
      capabilities: this.snapshotValue.capabilities.map((entry) => ({ ...entry, actions: [...entry.actions] })),
    };
  }
}

export function createProviderCapabilityHost(
  options: ProviderCapabilityHostRegistryOptions,
): ProviderCapabilityHostRegistry | undefined {
  if (!options.handlers.length && !options.policies.length) return undefined;
  return new ProviderCapabilityHostRegistry(options);
}
