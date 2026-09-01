import { describe, expect, it } from "vitest";
import type { ScenarioWorkItem, WorkerDescriptor } from "@traceforge/orchestration-core";
import { BoundedOutputDistiller } from "./distiller.js";
import type { WorkerAssignment, WorkerCheckpointDocument, WorkerCheckpointStore, WorkerControlPlaneClient } from "./model.js";
import { WorkerHost } from "./runtime.js";

const worker: WorkerDescriptor = { id: "neutral-worker", roles: ["operator"], capabilities: [], maxConcurrentWork: 1,
  status: "online", heartbeatAt: "2026-09-01T00:00:00.000Z" };
const work: ScenarioWorkItem = { id: "neutral-work", runId: "neutral-run", phaseId: "phase", kind: "task", title: "Evaluate",
  objective: "Produce an attributable result", priority: 1, status: "running", allowedWorkerRoles: ["operator"], requiredCapabilities: [],
  hypothesisIds: [], evidenceRefs: ["evidence:input"], workerId: worker.id, leaseId: "lease", leaseExpiresAt: "2099-01-01T00:00:00.000Z",
  attempt: 1, maxAttempts: 1, idempotencyKey: "effect", latestCheckpoint: null, resumeFromCheckpoint: false,
  pendingApproval: null, approvalHistory: [], grantedActionKeys: [], resultSummary: null, error: null,
  createdAt: "2026-09-01T00:00:00.000Z", startedAt: "2026-09-01T00:00:00.000Z", finishedAt: null };
const assignment: WorkerAssignment = { runId: work.runId, leaseId: "lease", leaseExpiresAt: work.leaseExpiresAt!, runRevision: 1,
  runContext: { caseId: "neutral-case", goal: "Evaluate", scopeRef: "scope", activePhaseId: "phase", directives: [] }, work };

class MemoryCheckpoints implements WorkerCheckpointStore {
  value?: WorkerCheckpointDocument;
  async save(value: WorkerCheckpointDocument) { this.value = structuredClone(value); return "memory:checkpoint"; }
  async load() { if (!this.value) throw new Error("missing"); return structuredClone(this.value); }
}

describe("framework-only Agent Harness integration host", () => {
  it("runs a WorkerHost to completion without Server, SQLite, or a Scenario package", async () => {
    let completion: unknown;
    const control: WorkerControlPlaneClient = {
      async register() {}, async heartbeat() {}, async assignments() { return [assignment]; }, async refresh() { return assignment; },
      async renew() { return assignment; }, async checkpoint() { return assignment; }, async requestApproval() {},
      async complete(_assignment, _command, summary, outputs) { completion = { summary, outputs }; }, async fail() {}, async block() {},
    };
    const host = new WorkerHost(worker, control, { async decide() {
      return { type: "complete", summary: "Attributable completion", outputs: [
        { id: "output", kind: "result", summary: "Result", refs: ["evidence:input"] },
      ] };
    } }, { async catalog() { return { tools: [], requestedCapabilities: [], unresolvedCapabilities: [], registryRevision: 0 }; },
      async execute() { throw new Error("no tool should execute"); } }, { async review() { return { action: "continue" }; } },
    new MemoryCheckpoints(), new BoundedOutputDistiller(), { ownershipPollMs: 30_000 });

    await expect(host.execute(assignment)).resolves.toMatchObject({ outcome: "completed", turns: 1 });
    expect(completion).toEqual({ summary: "Attributable completion", outputs: [
      { id: "output", kind: "result", summary: "Result", refs: ["evidence:input"] },
    ] });
  });
});
