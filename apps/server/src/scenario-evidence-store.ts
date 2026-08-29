import type { KnowledgeNode } from "@traceforge/evidence-graph";
import type { ScenarioEvidencePort } from "@traceforge/scenario-sdk";
import { EvidenceGraphRevisionConflictError, SqliteEvidenceGraphStore } from "./evidence-graph-store.js";

export class ScenarioEvidenceGraphAdapter implements ScenarioEvidencePort {
  constructor(private readonly store: SqliteEvidenceGraphStore) {}

  recordNode(input: Parameters<ScenarioEvidencePort["recordNode"]>[0]): string[] {
    const node: Omit<KnowledgeNode, "version" | "createdAt" | "updatedAt" | "invalidatedAt" | "invalidationReason"> = {
      ...input.node,
      caseId: input.caseId,
      runId: input.runId,
      source: null,
    };
    let lastConflict: EvidenceGraphRevisionConflictError | undefined;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const state = this.store.ensure(input.caseId, input.at);
      try {
        this.store.execute({
          caseId: input.caseId,
          commandId: input.commandId,
          expectedRevision: state.revision,
          command: { type: "add_node", node, at: input.at },
        });
        return [`knowledge-node:${input.node.id}`];
      } catch (error) {
        if (!(error instanceof EvidenceGraphRevisionConflictError)) throw error;
        lastConflict = error;
      }
    }
    throw lastConflict ?? new Error(`Could not record Scenario output ${input.node.id}`);
  }
}
