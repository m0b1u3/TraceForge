import { describe, it, expect } from "vitest";
import { buildGraph } from "./graph.js";
import type { Fact, Task, ActionCard } from "./schemas.js";

const fact = (id: string, type = "endpoint"): Fact => ({
  id, caseId: "c", type, title: `fact ${id}`, value: null,
  source: { type: "ai", ref: "" }, confidence: 1, tags: [], createdAt: "t",
});
const task = (id: string): Task => ({
  id, caseId: "c", title: `task ${id}`, status: "open", reason: "", blockedBy: [],
  triggerWhen: [], relatedFacts: [], priority: "medium", createdAt: "t", updatedAt: "t",
});
const action = (id: string, evidenceRefs: string[]): ActionCard => ({
  id, caseId: "c", title: `action ${id}`, goal: "", evidenceRefs, hypothesisRefs: [],
  taskRefs: [], reasoning: "", steps: [], expectedResults: [], riskNotes: [],
  tool: "http_replay", priority: "medium", requiresHumanApproval: true,
  status: "proposed", createdAt: "t", updatedAt: "t",
});

describe("buildGraph", () => {
  it("returns an empty graph for empty inputs", () => {
    expect(buildGraph([], [], [])).toEqual({ nodes: [], edges: [] });
  });

  it("makes one node per entity with the right kind", () => {
    const g = buildGraph([fact("f1")], [task("t1")], [action("a1", [])]);
    expect(g.nodes).toHaveLength(3);
    expect(g.nodes.find((n) => n.id === "f1")?.kind).toBe("fact");
    expect(g.nodes.find((n) => n.id === "t1")?.kind).toBe("task");
    expect(g.nodes.find((n) => n.id === "a1")?.kind).toBe("action");
  });

  it("creates an evidence edge from action to each referenced fact", () => {
    const g = buildGraph([fact("f1"), fact("f2")], [], [action("a1", ["f1", "f2"])]);
    expect(g.edges).toHaveLength(2);
    expect(g.edges).toContainEqual({ id: "a1->f1", source: "a1", target: "f1", label: "evidence" });
    expect(g.edges).toContainEqual({ id: "a1->f2", source: "a1", target: "f2", label: "evidence" });
  });

  it("skips dangling evidenceRefs (fact not present)", () => {
    const g = buildGraph([fact("f1")], [], [action("a1", ["f1", "ghost"])]);
    expect(g.edges).toHaveLength(1);
    expect(g.edges[0].target).toBe("f1");
  });

  it("node label carries the entity title and meta carries type/status", () => {
    const g = buildGraph([fact("f1", "credential")], [task("t1")], []);
    expect(g.nodes.find((n) => n.id === "f1")?.label).toBe("fact f1");
    expect(g.nodes.find((n) => n.id === "f1")?.meta.type).toBe("credential");
    expect(g.nodes.find((n) => n.id === "t1")?.meta.status).toBe("open");
  });
});
