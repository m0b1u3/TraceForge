import { useMemo, useState } from "react";
import ReactFlow, { Background, Controls, type Node, type Edge, type NodeMouseHandler } from "reactflow";
import "reactflow/dist/style.css";
import { buildGraph, type Graph } from "@traceforge/shared";
import { useStore } from "../store.js";

const KIND_COLOR: Record<string, string> = { fact: "#46b27f", task: "#36c2cf", action: "#79808f" };

interface NodeData {
  label: string;
  kind: string;
  title: string;
  meta: Record<string, unknown>;
}

function DetailPanel({ graph, nodeId, onClose }: { graph: Graph; nodeId: string; onClose: () => void }) {
  const node = graph.nodes.find((n) => n.id === nodeId);
  if (!node) return null;
  // 关联边：该节点作为 source 或 target 的所有 evidence 边
  const outgoing = graph.edges.filter((e) => e.source === nodeId);
  const incoming = graph.edges.filter((e) => e.target === nodeId);
  const labelOf = (id: string) => graph.nodes.find((n) => n.id === id)?.label ?? id;
  return (
    <div style={{
      position: "absolute", top: 0, right: 0, bottom: 0, width: 280, zIndex: 5,
      background: "var(--tf-panel)", borderLeft: "1px solid var(--tf-border)",
      padding: "12px 14px", overflow: "auto", fontSize: 12,
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
        <span style={{ color: KIND_COLOR[node.kind], fontWeight: 500, textTransform: "uppercase", letterSpacing: "0.06em" }}>{node.kind}</span>
        <button className="tf-btn" onClick={onClose}>关闭</button>
      </div>
      <div style={{ fontFamily: "var(--tf-mono)", marginBottom: 6 }}>{node.label}</div>
      <div style={{ color: "var(--tf-faint)", fontFamily: "var(--tf-mono)", fontSize: 11, marginBottom: 10 }}>{node.id}</div>

      {Object.keys(node.meta).length > 0 && (
        <table style={{ width: "100%", marginBottom: 12 }}>
          <tbody>
            {Object.entries(node.meta).map(([k, v]) => (
              <tr key={k}>
                <td style={{ color: "var(--tf-muted)", paddingRight: 8, verticalAlign: "top" }}>{k}</td>
                <td style={{ fontFamily: "var(--tf-mono)", wordBreak: "break-all" }}>{String(v)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {outgoing.length > 0 && (
        <div style={{ marginBottom: 10 }}>
          <div style={{ color: "var(--tf-muted)", marginBottom: 4 }}>依赖（{outgoing[0].label}）→</div>
          {outgoing.map((e) => <div className="tf-row" key={e.id} style={{ borderBottom: "none" }}>{labelOf(e.target)}</div>)}
        </div>
      )}
      {incoming.length > 0 && (
        <div>
          <div style={{ color: "var(--tf-muted)", marginBottom: 4 }}>← 被引用（{incoming[0].label}）</div>
          {incoming.map((e) => <div className="tf-row" key={e.id} style={{ borderBottom: "none" }}>{labelOf(e.source)}</div>)}
        </div>
      )}
      {outgoing.length === 0 && incoming.length === 0 && (
        <div className="tf-empty">无关联节点。</div>
      )}
    </div>
  );
}

export function GraphView({ interactive }: { interactive: boolean }) {
  const { facts, tasks, actions } = useStore();
  const [selected, setSelected] = useState<string | null>(null);

  const graph = useMemo(() => buildGraph(facts, tasks, actions), [facts, tasks, actions]);
  const { nodes, edges } = useMemo(() => {
    const rfNodes: Node<NodeData>[] = graph.nodes.map((n, i) => ({
      id: n.id,
      data: { label: `${n.kind}: ${n.label}`, kind: n.kind, title: n.label, meta: n.meta },
      position: { x: (i % 4) * 200, y: Math.floor(i / 4) * 120 },
      style: {
        background: KIND_COLOR[n.kind], color: "#0b0d11", border: n.id === selected ? "2px solid #eafdff" : "none",
        borderRadius: 6, fontSize: 11, width: 170, fontFamily: "ui-monospace, monospace",
      },
    }));
    const rfEdges: Edge[] = graph.edges.map((e) => ({
      id: e.id, source: e.source, target: e.target, label: e.label, animated: true,
      style: { stroke: "#1d6b71" },
    }));
    return { nodes: rfNodes, edges: rfEdges };
  }, [graph, selected]);

  const onNodeClick: NodeMouseHandler = (_e, node) => { if (interactive) setSelected(node.id); };

  if (graph.nodes.length === 0) {
    return <div className="tf-empty" style={{ padding: 12 }}>暂无图谱数据（记录 Fact/Action 后出现）。</div>;
  }
  return (
    <div style={{ position: "relative", width: "100%", height: "100%" }}>
      <ReactFlow
        nodes={nodes} edges={edges} fitView
        nodesDraggable={interactive} nodesConnectable={false} elementsSelectable={interactive}
        panOnDrag={interactive} zoomOnScroll={interactive} zoomOnPinch={interactive}
        onNodeClick={onNodeClick}
        proOptions={{ hideAttribution: true }}
      >
        <Background color="#232832" gap={18} />
        {interactive && <Controls />}
      </ReactFlow>
      {interactive && selected && <DetailPanel graph={graph} nodeId={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}
