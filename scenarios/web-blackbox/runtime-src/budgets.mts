import type { CapabilityReceipt, JsonObject } from "./contracts.mjs";
import { boundedInteger, sha } from "./validation.mjs";

export type Capability = (name: string, action: string, input: unknown, suffix: string) => Promise<CapabilityReceipt>;

export class BudgetExhausted extends Error {}

export interface InvestigationBudgets {
  urls: number;
  hypotheses: number;
  variants: number;
  requestsPerCall: number;
  totalRequests: number;
}

export async function budgets(capability: Capability): Promise<InvestigationBudgets> {
  const receipt = await capability("traceforge.scenario.authorization@1", "require", { action: "scope.read" }, "budget-scope");
  const values = receipt.output?.scopePayload?.budgets ?? {};
  return {
    urls: boundedInteger(values.urls ?? 64, 1, 512, "Authorized URL budget"),
    hypotheses: boundedInteger(values.hypotheses ?? 16, 1, 128, "Authorized hypothesis budget"),
    variants: boundedInteger(values.variants ?? 1, 1, 16, "Authorized experiment variants"),
    requestsPerCall: boundedInteger(values.requestsPerCall ?? 6, 1, 100, "Authorized request batch"),
    totalRequests: boundedInteger(values.totalRequests ?? 128, 1, 4096, "Authorized total HTTP requests"),
  };
}

/**
 * Run-scoped durable admission. Unknown dispatches retain their reservation.
 *
 * The ledger stores a 64-bit prefix of each request identity. The Host bounds one
 * state value to 256 KiB; full SHA-256 hex entries would exceed that bound before
 * the authorized 4096-request maximum, failing requests with a storage error
 * instead of an explicit budget signal. 4096 entries x 16 hex chars stays ~78 KB.
 * Collisions within a single Run are negligible (birthday bound ~2^32 entries)
 * and fail safe: a colliding identity is treated as already reserved.
 */
export async function reserveRequest(capability: Capability, identity: string): Promise<void> {
  const limit = (await budgets(capability)).totalRequests;
  const key = "web.request-budget.v1";
  const loaded = await capability("traceforge.scenario.state@1", "read", { operation: "read", key }, `budget-read:${sha(identity)}`);
  const revision = loaded.output?.revision ?? 0;
  const used: JsonObject = loaded.output?.value ?? { version: 1, ids: [] };
  if (used.version !== 1 || !Array.isArray(used.ids) || used.ids.length > 4096
    || used.ids.some((value: unknown) => typeof value !== "string" || !/^[a-f0-9]{16}$/.test(value))) {
    throw new Error("Invalid HTTP budget ledger");
  }
  const id = sha(identity).slice(0, 16);
  if (used.ids.includes(id)) return;
  if (used.ids.length >= limit) {
    throw new BudgetExhausted(`HTTP request budget exhausted (${used.ids.length}/${limit}); request user authorization before continuing`);
  }
  await capability("traceforge.scenario.state@1", "compare_and_set", {
    operation: "compare_and_set", commandId: `${key}:${revision}:${id}`, key, expectedRevision: revision,
    value: { version: 1, ids: [...used.ids, id] },
  }, `budget-reserve:${id}`);
}
