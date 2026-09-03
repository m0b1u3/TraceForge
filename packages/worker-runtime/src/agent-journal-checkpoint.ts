import { createAgentExecutionJournal } from "@traceforge/agent-runtime";
import type { WorkerDescriptor } from "@traceforge/orchestration-core";
import { upgradeWorkerCheckpoint, validateWorkerCheckpoint } from "./checkpoint-store.js";
import type { CurrentWorkerCheckpointDocument, WorkerAssignment, WorkerCheckpointStore } from "./model.js";

/**
 * Bridges host-owned checkpoint persistence with the host-independent Agent
 * Execution Journal. It is the only place that upgrades legacy checkpoint
 * cognitive fields into the current journal envelope.
 */
export class AgentJournalCheckpointAdapter {
  constructor(
    private readonly store: WorkerCheckpointStore,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  sessionId(assignment: Pick<WorkerAssignment, "runId" | "work">): string {
    return `agent:run:${encodeURIComponent(assignment.runId)}:work:${encodeURIComponent(assignment.work.id)}`;
  }

  async restore(worker: WorkerDescriptor, assignment: WorkerAssignment): Promise<CurrentWorkerCheckpointDocument> {
    const identity = { caseId: assignment.runContext.caseId, workKey: assignment.work.idempotencyKey,
      sessionId: this.sessionId(assignment), workerId: worker.id, leaseId: assignment.leaseId };
    const existing = assignment.work.latestCheckpoint;
    if (existing) {
      const document = validateWorkerCheckpoint(await this.store.load(existing.payloadRef));
      if (document.runId !== assignment.runId || document.workId !== assignment.work.id) {
        throw new Error("Checkpoint does not belong to this assignment");
      }
      return upgradeWorkerCheckpoint(document, identity);
    }
    return validateWorkerCheckpoint({
      version: 3,
      caseId: identity.caseId,
      workKey: identity.workKey,
      workerId: identity.workerId,
      runId: assignment.runId,
      workId: assignment.work.id,
      leaseId: identity.leaseId,
      journal: createAgentExecutionJournal({ sessionId: identity.sessionId, initialEntries: [{
        turn: 0,
        kind: "system",
        summary: "Work execution started",
        refs: [...new Set([assignment.runContext.scopeRef, ...assignment.work.evidenceRefs, ...assignment.work.hypothesisIds])],
      }] }),
      pendingInvocation: null,
      pendingControl: null,
      savedAt: this.now(),
    }) as CurrentWorkerCheckpointDocument;
  }

  async save(document: CurrentWorkerCheckpointDocument): Promise<string> {
    validateWorkerCheckpoint(document);
    return this.store.save(document);
  }
}
