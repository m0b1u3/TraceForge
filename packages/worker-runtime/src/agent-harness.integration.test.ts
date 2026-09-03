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

  it("replays a durable terminal command after replacing the checkpoint store and Host", async () => {
    const firstStore = new MemoryCheckpoints();
    let current = structuredClone(assignment); let modelCalls = 0; let completions = 0;
    const firstControl: WorkerControlPlaneClient = {
      async register() {}, async heartbeat() {}, async assignments() { return [current]; }, async refresh() { return current; },
      async renew() { return current; }, async checkpoint(_assignment, input) {
        current = { ...current, runRevision: current.runRevision + 1, work: { ...current.work, latestCheckpoint: {
          id: input.checkpointId, workId: current.work.id, leaseId: current.leaseId, progressSummary: input.progressSummary,
          payloadRef: "memory:checkpoint", createdAt: "2026-09-01T00:00:00.000Z" } } };
        if (input.progressSummary === "Completion decision persisted") throw new Error("host interrupted after durable terminal checkpoint");
        return current;
      }, async requestApproval() {}, async complete() { completions++; }, async fail() {}, async block() {},
    };
    const first = new WorkerHost(worker, firstControl, { async decide() { modelCalls++; return { type: "complete", summary: "Done", outputs: [] }; } },
      { async catalog() { return { tools: [], requestedCapabilities: [], unresolvedCapabilities: [], registryRevision: 0 }; },
        async execute() { throw new Error("no tool"); } }, { async review() { return { action: "continue" }; } }, firstStore,
      new BoundedOutputDistiller(), { ownershipPollMs: 30_000 });
    await expect(first.execute(current)).resolves.toMatchObject({ outcome: "failed",
      reason: "host interrupted after durable terminal checkpoint" });
    expect(firstStore.value).toMatchObject({ version: 3, journal: { terminal: { outcome: "completed" } }, pendingControl: { type: "complete" } });

    const replacementStore = new MemoryCheckpoints(); replacementStore.value = JSON.parse(JSON.stringify(firstStore.value));
    const replacementControl: WorkerControlPlaneClient = { ...firstControl,
      async refresh() { return current; }, async checkpoint() { throw new Error("terminal replay must not write a new checkpoint"); },
      async complete(_assignment, commandId) { completions++; expect(commandId).toBe("complete:lease"); },
    };
    const replacement = new WorkerHost({ ...worker, id: "replacement-worker" }, replacementControl,
      { async decide() { modelCalls++; throw new Error("terminal replay must not call the model"); } },
      { async validateCheckpoint() { throw new Error("terminal replay must not enter the tool gateway"); },
        async catalog() { throw new Error("terminal replay must not discover tools"); }, async execute() { throw new Error("no tool"); } },
      { async review() { throw new Error("terminal replay must not call the observer"); } }, replacementStore,
      new BoundedOutputDistiller(), { ownershipPollMs: 30_000 });
    await expect(replacement.execute(current)).resolves.toMatchObject({ outcome: "completed", turns: 1 });
    expect({ modelCalls, completions }).toEqual({ modelCalls: 1, completions: 1 });
  });
});
