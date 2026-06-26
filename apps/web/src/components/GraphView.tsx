import { useEffect, useMemo, useState } from "react";
import {
  Background, BaseEdge, Controls, EdgeLabelRenderer, Handle, MarkerType, Position,
  ReactFlow, ReactFlowProvider, getBezierPath, useReactFlow,
  type Edge, type EdgeProps, type Node, type NodeProps, type NodeMouseHandler,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import ELK from "elkjs/lib/elk.bundled.js";
import { Notebook, ShieldCheck, Lightning } from "@phosphor-icons/react";
import { buildGraph, type Graph } from "@traceforge/shared";
import { useStore } from "../store.js";

const elk = new ELK();
const KIND_COLOR: Record<string, string> = { fact: "#047857", task: "#1d4ed8", action: "#7c3aed" };

function clip(v: unknown, max = 96) {
  const s = String(v ?? "").replace(/\s+/g, " ").trim();
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

type NodeData = {
  kind: "fact" | "task" | "action";
  title: string;
  body: string;
  updates: number;
  superseded: boolean;
  meta: Record<string, unknown>;
};

function BwNode({ data }: NodeProps<Node<NodeData>>) {
  const Icon = data.kind === "task" ? ShieldCheck : data.kind === "action" ? Lightning : Notebook;
  return (
    <div className={`flow-card ${data.kind} ${data.superseded ? "superseded" : ""}`}>
      <Handle className="flow-handle" position={Position.Top} type="target" />
      <Handle className="flow-handle" position={Position.Bottom} type="source" />
      <div className="flow-card-head">
        <span className="flow-icon" style={{ color: KIND_COLOR[data.kind] }}><Icon size={13} weight="bold" /></span>
        <div>
          <span style={{ color: KIND_COLOR[data.kind] }}>{data.kind.toUpperCase()}</span>
          <strong>{clip(data.title, 52)}</strong>
        </div>
      </div>
      {data.body && <p>{clip(data.body, 100)}</p>}
      {data.updates > 0 && <small>{data.updates} updates</small>}
    </div>
  );
}
const nodeTypes = { bw: BwNode };

function EventEdge(props: EdgeProps) {
  const { id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, markerEnd, label } = props;
  const [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition });
  const active = (props.data as { active?: boolean } | undefined)?.active === true;
  return (
    <g>
      <path d={path} fill="none" markerEnd={markerEnd}
        style={{ stroke: "#94a3b8", strokeWidth: active ? 2 : 1.25, strokeOpacity: active ? 0.95 : 0.5, strokeDasharray: active ? "9 7" : undefined }}>
        {active ? <animate attributeName="stroke-dashoffset" dur="1.2s" repeatCount="indefinite" values="0;-16" /> : null}
      </path>
      <BaseEdge id={id} path={path} style={{ stroke: "transparent", strokeWidth: 10 }} />
      {label ? (
        <EdgeLabelRenderer>
          <div className="edge-label" style={{ position: "absolute", transform: `translate(-50%,-50%) translate(${labelX}px,${labelY}px)` }}>{String(label)}</div>
        </EdgeLabelRenderer>
      ) : null}
    </g>
  );
}
const edgeTypes = { event: EventEdge };

function toFlow(graph: Graph): { nodes: Node<NodeData>[]; edges: Edge[]; latestId?: string } {
  let latestId: string | undefined; let latestAt = "";
  const nodes: Node<NodeData>[] = graph.nodes.map((n) => {
    const updatedAt = String(n.meta.updatedAt ?? "");
    if (updatedAt > latestAt) { latestAt = updatedAt; latestId = n.id; }
    const body = n.kind === "fact" ? String(n.meta.type ?? "") : n.kind === "task" ? String(n.meta.status ?? "") : String(n.meta.tool ?? "");
    return {
      id: n.id, type: "bw", position: { x: 0, y: 0 },
      data: { kind: n.kind, title: n.label, body, updates: Number(n.meta.updateCount ?? 0), superseded: n.meta.validity === "superseded", meta: n.meta },
    };
  });
  const edges: Edge[] = graph.edges.map((e) => ({
    id: e.id, source: e.source, target: e.target, type: "event", label: e.label,
    markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color: "#64748b" },
    data: { active: e.target === latestId },
  }));
  return { nodes, edges, latestId };
}

async function elkLayout(nodes: Node<NodeData>[], edges: Edge[]): Promise<Node<NodeData>[]> {
  try {
    const g = {
      id: "root",
      layoutOptions: {
        "elk.algorithm": "layered", "elk.direction": "DOWN",
        "elk.spacing.nodeNode": "80", "elk.layered.spacing.nodeNodeBetweenLayers": "120",
        "elk.edgeRouting": "ORTHOGONAL", "elk.padding": "[top=24,left=24,bottom=24,right=24]",
      },
      children: nodes.map((n) => ({ id: n.id, width: 224, height: 104 })),
      edges: edges.map((e) => ({ id: e.id, sources: [e.source], targets: [e.target] })),
    };
    const res = await elk.layout(g);
    return nodes.map((n) => {
      const p = res.children?.find((c) => c.id === n.id);
      return { ...n, position: { x: p?.x ?? 0, y: p?.y ?? 0 }, sourcePosition: Position.Bottom, targetPosition: Position.Top };
    });
  } catch {
    return nodes.map((n, i) => ({ ...n, position: { x: (i % 4) * 240, y: Math.floor(i / 4) * 150 } }));
  }
}

function FocusLatest({ latestId, version }: { latestId?: string; version: number }) {
  const { fitView, setCenter, getNode } = useReactFlow();
  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      const n = latestId ? getNode(latestId) : undefined;
      if (n) void setCenter(n.position.x + 112, n.position.y + 52, { zoom: 0.85, duration: 200 });
      else void fitView({ padding: 0.25, duration: 150 });
    });
    return () => cancelAnimationFrame(raf);
  }, [fitView, setCenter, getNode, latestId, version]);
  return null;
}

function DetailPanel({ graph, nodeId, onClose }: { graph: Graph; nodeId: string; onClose: () => void }) {
  const node = graph.nodes.find((n) => n.id === nodeId);
  if (!node) return null;
  const out = graph.edges.filter((e) => e.source === nodeId);
  const inc = graph.edges.filter((e) => e.target === nodeId);
  const labelOf = (id: string) => graph.nodes.find((n) => n.id === id)?.label ?? id;
  return (
    <div className="tf-gdetail">
      <div className="tf-gdetail-head">
        <span style={{ color: KIND_COLOR[node.kind], fontWeight: 600, fontSize: 11, letterSpacing: "0.08em" }}>{node.kind.toUpperCase()}</span>
        <button className="tf-btn" onClick={onClose}>关闭</button>
      </div>
      <div className="tf-gdetail-title">{node.label}</div>
      <div className="tf-gdetail-id">{node.id}</div>
      <div className="tf-gdetail-meta">
        {Object.entries(node.meta).map(([k, v]) => (
          <div key={k} className="tf-gdetail-kv"><span>{k}</span><span>{String(v)}</span></div>
        ))}
      </div>
      {out.length > 0 && <div className="tf-gdetail-rel"><div className="tf-gdetail-rel-h">依赖证据 →</div>{out.map((e) => <div key={e.id} className="tf-gdetail-link">{labelOf(e.target)}</div>)}</div>}
      {inc.length > 0 && <div className="tf-gdetail-rel"><div className="tf-gdetail-rel-h">← 被引用</div>{inc.map((e) => <div key={e.id} className="tf-gdetail-link">{labelOf(e.source)}</div>)}</div>}
    </div>
  );
}

function GraphInner({ interactive }: { interactive: boolean }) {
  const { facts, tasks, actions } = useStore();
  const [selected, setSelected] = useState<string | null>(null);
  const graph = useMemo(() => buildGraph(facts, tasks, actions), [facts, tasks, actions]);
  const flow = useMemo(() => toFlow(graph), [graph]);
  const [laid, setLaid] = useState<Node<NodeData>[]>([]);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let active = true;
    void elkLayout(flow.nodes, flow.edges).then((n) => { if (active) { setLaid(n); setVersion((v) => v + 1); } });
    return () => { active = false; };
  }, [flow]);

  const onNodeClick: NodeMouseHandler = (_e, node) => { if (interactive) setSelected(node.id); };

  if (graph.nodes.length === 0) {
    return <div className="tf-empty" style={{ padding: 12 }}>暂无图谱数据（记录 Fact/Action 后出现）。</div>;
  }
  return (
    <div className="tf-graph" style={{ position: "relative", width: "100%", height: "100%" }}>
      <ReactFlow
        nodes={laid} edges={flow.edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes} fitView
        nodesDraggable={false} nodesConnectable={false} elementsSelectable={interactive}
        panOnDrag={interactive} zoomOnScroll={interactive} zoomOnPinch={interactive} minZoom={0.2}
        onNodeClick={onNodeClick} proOptions={{ hideAttribution: true }}
        defaultEdgeOptions={{ type: "event" }}
      >
        <FocusLatest latestId={flow.latestId} version={version} />
        <Background color="rgba(148,163,184,0.22)" gap={22} />
        {interactive && <Controls showInteractive={false} />}
      </ReactFlow>
      {interactive && selected && <DetailPanel graph={graph} nodeId={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}

export function GraphView({ interactive }: { interactive: boolean }) {
  return <ReactFlowProvider><GraphInner interactive={interactive} /></ReactFlowProvider>;
}
