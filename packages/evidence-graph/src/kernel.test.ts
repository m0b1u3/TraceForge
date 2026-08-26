import { describe, expect, it } from "vitest";
import { EvidenceGraphKernel } from "./kernel.js";
import type { EvidenceGraphCommand, EvidenceGraphState, KnowledgeNodeKind, KnowledgeNodeStatus } from "./model.js";

const at = (step: number) => `2026-08-24T10:${String(step).padStart(2, "0")}:00.000Z`;

function apply(kernel: EvidenceGraphKernel, state: EvidenceGraphState | undefined, command: EvidenceGraphCommand): EvidenceGraphState {
  return kernel.execute(state, command).state;
}

function addNode(kernel: EvidenceGraphKernel, state: EvidenceGraphState, input: {
  id: string; kind: KnowledgeNodeKind; status?: KnowledgeNodeStatus; properties?: Record<string, unknown>;
  source?: { type: "tool_result" | "traffic"; ref: string; observedAt: string; producerId: string } | null;
}, step: number): EvidenceGraphState {
  return apply(kernel, state, {
    type: "add_node",
    node: {
      id: input.id, caseId: "case_1", runId: "run_1", kind: input.kind,
      title: input.id, summary: `Summary for ${input.id}`,
      status: input.status ?? (input.kind === "finding" || input.kind === "hypothesis" || input.kind === "validation_conclusion" ? "candidate" : "active"),
      confidence: 0.7, properties: input.properties ?? {}, source: input.source ?? null,
    },
    at: at(step),
  });
}

function addEdge(kernel: EvidenceGraphKernel, state: EvidenceGraphState, id: string, sourceId: string, targetId: string, relation: "supports" | "derived_from" | "validates" | "impacts", step: number) {
  return apply(kernel, state, { type: "add_edge", edge: { id, sourceId, targetId, relation, rationale: `Trace ${id}` }, at: at(step) });
}

describe("EvidenceGraphKernel", () => {
  it("requires every Evidence node to carry an auditable source", () => {
    const kernel = new EvidenceGraphKernel();
    const state = apply(kernel, undefined, { type: "initialize_graph", caseId: "case_1", at: at(0) });
    expect(() => addNode(kernel, state, { id: "evidence_1", kind: "evidence" }, 1)).toThrow(/auditable source/);
  });

  it("rejects relation shapes that do not match their domain meaning", () => {
    const kernel = new EvidenceGraphKernel();
    let state = apply(kernel, undefined, { type: "initialize_graph", caseId: "case_1", at: at(0) });
    state = addNode(kernel, state, { id: "task_1", kind: "task" }, 1);
    state = addNode(kernel, state, { id: "finding_1", kind: "finding" }, 2);
    expect(() => addEdge(kernel, state, "edge_1", "task_1", "finding_1", "validates", 3)).toThrow(/cannot connect/);
  });

  it("verifies a Finding only with hypothesis, causal conclusion, impact and two independent signals", () => {
    const kernel = new EvidenceGraphKernel();
    let state = apply(kernel, undefined, { type: "initialize_graph", caseId: "case_1", at: at(0) });
    state = addNode(kernel, state, { id: "entity_1", kind: "entity" }, 1);
    state = addNode(kernel, state, { id: "hypothesis_1", kind: "hypothesis" }, 2);
    state = addNode(kernel, state, { id: "finding_1", kind: "finding", status: "validating" }, 3);
    state = addNode(kernel, state, {
      id: "conclusion_1", kind: "validation_conclusion", status: "resolved",
      properties: { causalMechanism: "Controlled state change", reproduction: "Repeatable bounded comparison", concreteImpact: "Unauthorized state exposure" },
    }, 4);
    state = addNode(kernel, state, { id: "evidence_1", kind: "evidence", source: { type: "traffic", ref: "traffic:first", observedAt: at(5), producerId: "tool:first" } }, 5);
    state = addNode(kernel, state, { id: "evidence_2", kind: "evidence", source: { type: "tool_result", ref: "receipt:second", observedAt: at(6), producerId: "tool:second" } }, 6);
    state = addEdge(kernel, state, "derived", "finding_1", "hypothesis_1", "derived_from", 7);
    state = addEdge(kernel, state, "impact", "finding_1", "entity_1", "impacts", 8);
    state = addEdge(kernel, state, "validates", "conclusion_1", "finding_1", "validates", 9);
    state = addEdge(kernel, state, "supports_1", "evidence_1", "conclusion_1", "supports", 10);
    expect(() => apply(kernel, state, { type: "transition_node", nodeId: "finding_1", status: "verified", reason: "Review complete", at: at(11) }))
      .toThrow(/two distinct/);
    state = addEdge(kernel, state, "supports_2", "evidence_2", "finding_1", "supports", 12);
    state = apply(kernel, state, { type: "transition_node", nodeId: "finding_1", status: "verified", reason: "Evidence chain complete", at: at(13) });
    expect(state.nodes.find((node) => node.id === "finding_1")?.status).toBe("verified");
  });

  it("propagates source invalidation to dependent conclusions and verified Findings", () => {
    const kernel = new EvidenceGraphKernel();
    let state = apply(kernel, undefined, { type: "initialize_graph", caseId: "case_1", at: at(0) });
    state = addNode(kernel, state, { id: "evidence_1", kind: "evidence", source: { type: "traffic", ref: "traffic:first", observedAt: at(1), producerId: "tool:first" } }, 1);
    state = addNode(kernel, state, { id: "conclusion_1", kind: "validation_conclusion", status: "resolved" }, 2);
    state = addNode(kernel, state, { id: "finding_1", kind: "finding", status: "validating" }, 3);
    state = addEdge(kernel, state, "support", "evidence_1", "conclusion_1", "supports", 4);
    state = addEdge(kernel, state, "validate", "conclusion_1", "finding_1", "validates", 5);
    state = apply(kernel, state, { type: "invalidate_node", nodeId: "evidence_1", reason: "Source attribution withdrawn", at: at(6) });
    expect(state.nodes.find((node) => node.id === "evidence_1")?.status).toBe("invalidated");
    expect(state.nodes.find((node) => node.id === "conclusion_1")?.status).toBe("needs_review");
    expect(state.nodes.find((node) => node.id === "finding_1")?.status).toBe("needs_review");
  });

  it("propagates invalidation against dependency-oriented relation direction", () => {
    const kernel = new EvidenceGraphKernel();
    let state = apply(kernel, undefined, { type: "initialize_graph", caseId: "case_1", at: at(0) });
    state = addNode(kernel, state, { id: "entity_1", kind: "entity" }, 1);
    state = addNode(kernel, state, { id: "hypothesis_1", kind: "hypothesis" }, 2);
    state = addNode(kernel, state, { id: "finding_1", kind: "finding", status: "validating" }, 3);
    state = addEdge(kernel, state, "derived", "finding_1", "hypothesis_1", "derived_from", 4);
    state = addEdge(kernel, state, "impact", "finding_1", "entity_1", "impacts", 5);
    state = apply(kernel, state, { type: "invalidate_node", nodeId: "hypothesis_1", reason: "Premise disproved", at: at(6) });
    expect(state.nodes.find((node) => node.id === "finding_1")?.status).toBe("needs_review");
  });
});
