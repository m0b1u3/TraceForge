import { useMemo, useState } from "react";
import ReactFlow, {
  Background, Controls, Handle, Position, MarkerType,
  type Node, type Edge, type NodeMouseHandler, type NodeProps,
} from "reactflow";
import "reactflow/dist/style.css";
import { buildGraph, type Graph } from "@traceforge/shared";
import { useStore } from "../store.js";

const KIND = {
  fact: { label: "FACT", color: "#5cc99a", dim: "rgba(92,201,154,0.5)" },
  task: { label: "TASK", color: "#4ad6e0", dim: "rgba(74,214,224,0.5)" },
  action: { label: "ACTION", color: "#b79bff", dim: "rgba(183,155,255,0.5)" },
} as const;

interface NodeData {
  kind: keyof typeof KIND;
  title: string;
  meta: Record<string, unknown>;
  selected: boolean;
}

// BreachWeave 风格节点：深色卡片 + 左侧类型色条 + 类型徽章 + 标题 + 副信息
function GraphNode({ data }: NodeProps<NodeData>) {
  const k = KIND[data.kind] ?? KIND.fact;
  const metaStr = Object.entries(data.meta).slice(0, 2).map(([key, v]) => `${key}: ${String(v)}`).join(" · ");
  return (
    <div className={`tf-gnode ${data.selected ? "is-sel" : ""}`} style={{ ["--gn" as string]: k.color }}>
      <Handle type="target" position={Position.Top} className="tf-gnode-h" />
      <div className="tf-gnode-bar" />
      <div className="tf-gnode-in">
        <div className="tf-gnode-badge" style={{ color: k.color }}>{k.label}</div>
        <div className="tf-gnode-title">{data.title}</div>
        {metaStr && <div className="tf-gnode-meta">{metaStr}</div>}
      </div>
      <Handle type="source" position={Position.Bottom} className="tf-gnode-h" />
    </div>
  );
}

const nodeTypes = { tf: GraphNode };

function DetailPanel({ graph, nodeId, onClose }: { graph: Graph; nodeId: string; onClose: () => void }) {
  const node = graph.nodes.find((n) => n.id === nodeId);
  if (!node) return null;
  const outgoing = graph.edges.filter((e) => e.source === nodeId);
  const incoming = graph.edges.filter((e) => e.target === nodeId);
  const labelOf = (id: string) => graph.nodes.find((n) => n.id === id)?.label ?? id;
  const k = KIND[node.kind as keyof typeof KIND] ?? KIND.fact;
  return (
    <div className="tf-gdetail">
      <div className="tf-gdetail-head">
        <span style={{ color: k.color, fontWeight: 600, fontSize: 11, letterSpacing: "0.08em" }}>{k.label}</span>
        <button className="tf-btn" onClick={onClose}>关闭</button>
      </div>
      <div className="tf-gdetail-title">{node.label}</div>
      <div className="tf-gdetail-id">{node.id}</div>
      {Object.keys(node.meta).length > 0 && (
        <div className="tf-gdetail-meta">
          {Object.entries(node.meta).map(([key, v]) => (
            <div key={key} className="tf-gdetail-kv"><span>{key}</span><span>{String(v)}</span></div>
          ))}
        </div>
      )}
      {outgoing.length > 0 && (
        <div className="tf-gdetail-rel">
          <div className="tf-gdetail-rel-h">依赖证据 →</div>
          {outgoing.map((e) => <div key={e.id} className="tf-gdetail-link">{labelOf(e.target)}</div>)}
        </div>
      )}
      {incoming.length > 0 && (
        <div className="tf-gdetail-rel">
          <div className="tf-gdetail-rel-h">← 被引用</div>
          {incoming.map((e) => <div key={e.id} className="tf-gdetail-link">{labelOf(e.source)}</div>)}
        </div>
      )}
      {outgoing.length === 0 && incoming.length === 0 && <div className="tf-empty">无关联节点。</div>}
    </div>
  );
}

export function GraphView({ interactive }: { interactive: boolean }) {
  const { facts, tasks, actions } = useStore();
  const [selected, setSelected] = useState<string | null>(null);

  const graph = useMemo(() => buildGraph(facts, tasks, actions), [facts, tasks, actions]);
  const { nodes, edges } = useMemo(() => {
    // 按 kind 分层：fact 一行、task 一行、action 一行，列内均布
    const rows: Record<string, number> = { fact: 0, task: 1, action: 2 };
    const colIdx: Record<string, number> = { fact: 0, task: 0, action: 0 };
    const rfNodes: Node<NodeData>[] = graph.nodes.map((n) => {
      const row = rows[n.kind] ?? 0;
      const col = colIdx[n.kind]++;
      return {
        id: n.id, type: "tf",
        data: { kind: n.kind as keyof typeof KIND, title: n.label, meta: n.meta, selected: n.id === selected },
        position: { x: col * 230, y: row * 150 },
      };
    });
    const rfEdges: Edge[] = graph.edges.map((e) => ({
      id: e.id, source: e.source, target: e.target, label: e.label,
      type: "smoothstep", animated: true,
      style: { stroke: "rgba(92,201,154,0.45)", strokeWidth: 1.5 },
      labelStyle: { fill: "#79808f", fontSize: 10, fontFamily: "var(--tf-mono, monospace)" },
      labelBgStyle: { fill: "#101216" }, labelBgPadding: [4, 2] as [number, number], labelBgBorderRadius: 4,
      markerEnd: { type: MarkerType.ArrowClosed, color: "rgba(92,201,154,0.6)", width: 14, height: 14 },
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
        nodes={nodes} edges={edges} nodeTypes={nodeTypes} fitView
        nodesDraggable={interactive} nodesConnectable={false} elementsSelectable={interactive}
        panOnDrag={interactive} zoomOnScroll={interactive} zoomOnPinch={interactive}
        onNodeClick={onNodeClick} minZoom={0.3}
        proOptions={{ hideAttribution: true }}
      >
        <Background color="#1c2029" gap={22} size={1} />
        {interactive && <Controls showInteractive={false} />}
      </ReactFlow>
      {interactive && selected && <DetailPanel graph={graph} nodeId={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}
