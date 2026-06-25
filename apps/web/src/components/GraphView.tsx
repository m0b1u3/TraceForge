import { useMemo } from "react";
import ReactFlow, { Background, Controls, type Node, type Edge } from "reactflow";
import "reactflow/dist/style.css";
import { buildGraph } from "@traceforge/shared";
import { useStore } from "../store.js";

const KIND_COLOR: Record<string, string> = { fact: "#46b27f", task: "#36c2cf", action: "#79808f" };

export function GraphView({ interactive }: { interactive: boolean }) {
  const { facts, tasks, actions } = useStore();
  const { nodes, edges } = useMemo(() => {
    const g = buildGraph(facts, tasks, actions);
    const rfNodes: Node[] = g.nodes.map((n, i) => ({
      id: n.id,
      data: { label: `${n.kind}: ${n.label}` },
      position: { x: (i % 4) * 200, y: Math.floor(i / 4) * 120 },
      style: {
        background: KIND_COLOR[n.kind], color: "#0b0d11", border: "none",
        borderRadius: 6, fontSize: 11, width: 170, fontFamily: "ui-monospace, monospace",
      },
    }));
    const rfEdges: Edge[] = g.edges.map((e) => ({
      id: e.id, source: e.source, target: e.target, label: e.label, animated: true,
      style: { stroke: "#1d6b71" },
    }));
    return { nodes: rfNodes, edges: rfEdges };
  }, [facts, tasks, actions]);

  if (nodes.length === 0) {
    return <div className="tf-empty" style={{ padding: 12 }}>暂无图谱数据（记录 Fact/Action 后出现）。</div>;
  }
  return (
    <ReactFlow
      nodes={nodes} edges={edges} fitView
      nodesDraggable={interactive} nodesConnectable={false} elementsSelectable={interactive}
      panOnDrag={interactive} zoomOnScroll={interactive} zoomOnPinch={interactive}
      proOptions={{ hideAttribution: true }}
    >
      <Background color="#232832" gap={18} />
      {interactive && <Controls />}
    </ReactFlow>
  );
}
