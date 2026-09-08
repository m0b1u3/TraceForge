import { SampledResourceBudget, type ProcessResourceSample, type ResourceBudgetDecision } from "./sampled-resource-budget.js";
import type { ExecutionResourceLimits } from "./protocol.js";

export interface ResourceSupervisionPorts {
  /** Native adapter must validate ownership and process birth identities. */
  sample(signal: AbortSignal): Promise<readonly ProcessResourceSample[]>;
  /** Must resolve only when the owned execution boundary is empty. */
  terminateAndConfirm(signal: AbortSignal): Promise<void>;
  now(): number;
}
export type SupervisionResult = { reason: "budget" | "cancelled" | "sampling_failed"; cleanupConfirmed: boolean;
  decision?: ResourceBudgetDecision };

/** No OS/process APIs here. Native adapters supply identity-safe samples and a
 * termination barrier; missing measurements are failures, not zero usage. */
export class ResourceBudgetSupervisor {
  private readonly budget: SampledResourceBudget;
  private running = false;
  constructor(limits: ExecutionResourceLimits, private readonly ports: ResourceSupervisionPorts,
    private readonly intervalMs = 100, private readonly operationTimeoutMs = 2000) {
    this.budget = new SampledResourceBudget(limits);
    for (const value of [intervalMs, operationTimeoutMs]) if (!Number.isSafeInteger(value) || value < 1 || value > 10000) throw new Error("Invalid supervision deadline");
  }
  async run(signal: AbortSignal): Promise<SupervisionResult> {
    if (this.running) throw new Error("Resource supervision is single-use");
    this.running = true;
    let result: SupervisionResult;
    while (true) {
      if (signal.aborted) { result = { reason: "cancelled", cleanupConfirmed: false }; break; }
      try {
        const samples = await this.bounded(this.ports.sample, signal);
        if (signal.aborted) { result = { reason: "cancelled", cleanupConfirmed: false }; break; }
        const decision = this.budget.observe(this.ports.now(), samples);
        if (decision.exceeded) { result = { reason: "budget", decision, cleanupConfirmed: false }; break; }
      } catch {
        result = { reason: signal.aborted ? "cancelled" : "sampling_failed", cleanupConfirmed: false }; break;
      }
      await new Promise<void>(resolve => {
        const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
        const timer = setTimeout(done, this.intervalMs);
        signal.addEventListener("abort", done, { once: true });
        if (signal.aborted) done();
      });
    }
    // Cleanup gets its own deadline, not the already-aborted invocation signal.
    try { await this.bounded(this.ports.terminateAndConfirm); result.cleanupConfirmed = true; } catch { /* retain unknown occupancy */ }
    return result;
  }
  private async bounded<T>(operation: (signal: AbortSignal) => Promise<T>, parent?: AbortSignal): Promise<T> {
    const controller = new AbortController();
    const abort = () => controller.abort(new Error("Resource supervision interrupted"));
    parent?.addEventListener("abort", abort, { once: true });
    if (parent?.aborted) abort();
    const timer = setTimeout(abort, this.operationTimeoutMs);
    let stop: () => void = () => {};
    try {
      return await Promise.race([
        Promise.resolve().then(() => { controller.signal.throwIfAborted(); return operation(controller.signal); }),
        new Promise<never>((_, reject) => {
          stop = () => reject(controller.signal.reason);
          controller.signal.addEventListener("abort", stop, { once: true });
          if (controller.signal.aborted) stop();
        }),
      ]);
    } finally { clearTimeout(timer); parent?.removeEventListener("abort", abort); controller.signal.removeEventListener("abort", stop); controller.abort(); }
  }
}
