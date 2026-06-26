import type { Fact, Task, ActionCard } from "./schemas.js";

export interface GraphNode {
  id: string;
  kind: "fact" | "task" | "action";
  label: string;
  meta: Record<string, unknown>;
}
export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  label: string;
}
export interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export function buildGraph(facts: Fact[], tasks: Task[], actions: ActionCard[]): Graph {
  const nodes: GraphNode[] = [
    ...facts.map((f): GraphNode => ({ id: f.id, kind: "fact", label: f.title, meta: { type: f.type, confidence: f.confidence, updateCount: f.updateCount, updatedAt: f.updatedAt, validity: f.validity } })),
    ...tasks.map((t): GraphNode => ({ id: t.id, kind: "task", label: t.title, meta: { status: t.status, priority: t.priority, updateCount: t.updateCount, updatedAt: t.updatedAt } })),
    ...actions.map((a): GraphNode => ({ id: a.id, kind: "action", label: a.title, meta: { tool: a.tool, status: a.status } })),
  ];
  const factIds = new Set(facts.map((f) => f.id));
  const edges: GraphEdge[] = [];
  for (const a of actions) {
    for (const factId of a.evidenceRefs) {
      if (factIds.has(factId)) {
        edges.push({ id: `${a.id}->${factId}`, source: a.id, target: factId, label: "evidence" });
      }
    }
  }
  return { nodes, edges };
}
