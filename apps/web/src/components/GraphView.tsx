import { useEffect, useMemo, useState, memo } from "react";
import {
  Background, BaseEdge, Controls, EdgeLabelRenderer, Handle, MarkerType, Position,
  ReactFlow, ReactFlowProvider, getBezierPath, useReactFlow,
  type Edge, type EdgeProps, type Node, type NodeProps, type NodeMouseHandler,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  ArrowCounterClockwise, Clock, Database, Flag, Lightbulb, Lightning, Notebook, Pause, Play, Robot, ShieldCheck,
} from "@phosphor-icons/react";
import { useStore } from "../store.js";
import type { Fact, Task, ActionCard, TimelineEntry } from "@traceforge/shared";
import { useShallow } from "zustand/react/shallow";

async function loadElk() {
  const { default: ELK } = await import("elkjs/lib/elk.bundled.js");
  return new ELK();
}
let elkPromise: ReturnType<typeof loadElk> | null = null;
async function getElk() {
  if (!elkPromise) elkPromise = loadElk();
  return elkPromise;
}

const KIND_META: Record<string, { label: string; icon: typeof Notebook; color: string; border: string }> = {
  fact: { label: "FACT", icon: Database, color: "#78aef2", border: "#35516d" },
  memory: { label: "MEMORY", icon: Database, color: "#78aef2", border: "#35516d" },
  task: { label: "TASK", icon: Lightbulb, color: "#d7a65a", border: "#5f4b2d" },
  idea: { label: "TASK", icon: Lightbulb, color: "#d7a65a", border: "#5f4b2d" },
  action: { label: "ACTION", icon: Lightning, color: "#aa91d8", border: "#4c4162" },
  solver: { label: "AGENT", icon: Robot, color: "#62c49e", border: "#315b4d" },
  flag: { label: "FLAG", icon: Flag, color: "#d89467", border: "#624436" },
  note: { label: "EVENT", icon: Notebook, color: "#8799a5", border: "#3a4b55" },
};

function clip(v: unknown, max = 96) {
  const s = String(v ?? "").replace(/\s+/g, " ").trim();
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

function formatTime(iso: string) {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString(undefined, { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
  } catch {
    return iso;
  }
}

function kindOf(entry: TimelineEntry): string {
  const t = entry.eventType;
  if (t === "fact_created" || t === "fact_updated") return "fact";
  if (t === "task_created" || t === "task_updated" || t === "task_reopened" || t === "task_reverted") return "task";
  if (t === "action_recorded") return "action";
  if (t === "context_built") return "solver";
  if (t === "flag_submitted") return "flag";
  return "note";
}

function titleOf(entry: TimelineEntry) {
  const t = entry.eventType;
  if (t === "fact_created") return "Fact created";
  if (t === "fact_updated") return "Fact updated";
  if (t === "task_created") return "Task created";
  if (t === "task_updated") return "Task updated";
  if (t === "task_reopened") return "Task reopened";
  if (t === "task_reverted") return "Task reverted";
  if (t === "action_recorded") return "Action recorded";
  if (t === "context_built") return "Context built";
  if (t === "timeline_appended") return "Timeline event";
  return t.replace(/_/g, " ");
}

type FlowNodeData = {
  entry: TimelineEntry;
  kind: string;
  title: string;
  body: string;
  meta: string;
};

function BwNode({ data }: NodeProps<Node<FlowNodeData>>) {
  const meta = KIND_META[data.kind] ?? KIND_META.note;
  const Icon = meta.icon;
  return (
    <div className={`flow-card ${data.kind}`}>
      <Handle className="flow-handle" position={Position.Top} type="target" />
      <Handle className="flow-handle" position={Position.Bottom} type="source" />
      <Handle className="flow-handle" position={Position.Left} type="target" />
      <Handle className="flow-handle" position={Position.Right} type="source" />
      <div className="flow-card-content">
        <div className="flow-card-head">
          <span className="flow-icon" style={{ color: meta.color, borderColor: meta.border }}>
            <Icon size={13} />
          </span>
          <div>
            <span style={{ color: meta.color }}>{meta.label}</span>
            <strong>{clip(data.title, 52)}</strong>
          </div>
        </div>
        <p>{clip(data.body, 108)}</p>
        <small>{data.meta}</small>
      </div>
    </div>
  );
}
const nodeTypes = { bw: BwNode };

function EventEdge(props: EdgeProps) {
  const { id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, markerEnd, label, style } = props;
  const [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition });
  const active = (props.data as { active?: boolean } | undefined)?.active === true;
  return (
    <g>
      <path
        d={path}
        fill="none"
        markerEnd={markerEnd}
        style={{
          stroke: style?.stroke ?? "#94a3b8",
          strokeWidth: active ? 2.1 : 1.25,
          strokeOpacity: active ? 0.95 : 0.5,
          strokeDasharray: active ? "9 7" : (style?.strokeDasharray as string | undefined),
        }}
      >
        {active ? <animate attributeName="stroke-dashoffset" dur="1.2s" repeatCount="indefinite" values="0;-16" /> : null}
      </path>
      <BaseEdge id={id} path={path} style={{ stroke: "transparent", strokeWidth: 10 }} />
      {label ? (
        <EdgeLabelRenderer>
          <div className="edge-label" style={{ position: "absolute", transform: `translate(-50%,-50%) translate(${labelX}px,${labelY}px)` }}>
            {clip(label, 28)}
          </div>
        </EdgeLabelRenderer>
      ) : null}
    </g>
  );
}
const edgeTypes = { event: EventEdge };

function buildTimelineGraph(
  timeline: TimelineEntry[],
  goal: string | null | undefined,
  facts: Fact[],
  tasks: Task[],
  actions: ActionCard[],
) {
  if (timeline.length === 0) return { nodes: [] as Node<FlowNodeData>[], edges: [] as Edge[], focusNodeId: undefined as string | undefined };

  const nodes: Node<FlowNodeData>[] = [];
  const edges: Edge[] = [];
  const taskById = new Map(tasks.map((t) => [t.id, t]));
  const actionById = new Map(actions.map((a) => [a.id, a]));
  const latestNodeByRef = new Map<string, string>();
  const latestNodeByKind = new Map<string, string>();
  let latestContextNode: string | undefined;

  if (goal) {
    nodes.push({
      id: "__goal__",
      type: "bw",
      position: { x: 0, y: 0 },
      width: 240,
      height: 96,
      data: {
        entry: timeline[0],
        kind: "solver",
        title: "Objective",
        body: goal,
        meta: "case goal",
      },
    });
  }

  const addEdge = (source: string | undefined, target: string, label: string, color: string, active = false) => {
    if (!source || source === target) return false;
    const id = `${source}->${target}:${label}`;
    if (edges.some((e) => e.id === id)) return false;
    edges.push({
      id,
      source,
      target,
      type: "event",
      label,
      markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color: "#64748b" },
      style: { stroke: color },
      data: { active },
    });
    return true;
  };

  const addFactEdges = (factIds: string[], target: string, label: string, active: boolean) => {
    let added = false;
    for (const factId of factIds) {
      const source = latestNodeByRef.get(factId);
      added = addEdge(source, target, label, KIND_META.fact.color, active) || added;
    }
    return added;
  };

  for (let i = 0; i < timeline.length; i++) {
    const entry = timeline[i];
    const kind = kindOf(entry);
    const active = i === timeline.length - 1;
    nodes.push({
      id: entry.id,
      type: "bw",
      position: { x: 0, y: 0 },
      width: 240,
      height: 104,
      data: {
        entry,
        kind,
        title: titleOf(entry),
        body: entry.detail,
        meta: formatTime(entry.createdAt),
      },
    });

    const color = KIND_META[kind]?.color ?? "#94a3b8";
    let connected = false;
    if (entry.refId) {
      connected = addEdge(latestNodeByRef.get(entry.refId), entry.id, "update", color, active) || connected;
    }

    if (kind === "task" && entry.refId) {
      const task = taskById.get(entry.refId);
      connected = addFactEdges(task?.relatedFacts ?? [], entry.id, "evidence", active) || connected;
    }

    if (kind === "action" && entry.refId) {
      const action = actionById.get(entry.refId);
      connected = addFactEdges(action?.evidenceRefs ?? [], entry.id, "evidence", active) || connected;
      for (const taskId of action?.taskRefs ?? []) {
        connected = addEdge(latestNodeByRef.get(taskId), entry.id, "task", KIND_META.task.color, active) || connected;
      }
    }

    if (kind === "solver") {
      connected = addEdge(latestContextNode ?? (goal ? "__goal__" : undefined), entry.id, latestContextNode ? "refresh" : "start", color, active) || connected;
    } else if (!connected) {
      connected = addEdge(latestContextNode, entry.id, "uses", color, active) || connected;
    }

    if (!connected) {
      connected = addEdge(latestNodeByKind.get(kind), entry.id, "next", color, active) || connected;
    }

    if (!connected && goal) {
      addEdge("__goal__", entry.id, "related", color, active);
    }

    if (entry.refId) {
      latestNodeByRef.set(entry.refId, entry.id);
    }
    if (kind === "solver") latestContextNode = entry.id;
    latestNodeByKind.set(kind, entry.id);
  }

  return { nodes, edges, focusNodeId: timeline[timeline.length - 1]?.id };
}

async function elkLayout(nodes: Node<FlowNodeData>[], edges: Edge[], direction: "RIGHT" | "DOWN"): Promise<Node<FlowNodeData>[]> {
  const elk = await getElk();
  const isVertical = direction === "DOWN";
  try {
    const g = {
      id: "root",
      layoutOptions: {
        "elk.algorithm": "layered",
        "elk.direction": direction,
        "elk.spacing.nodeNode": isVertical ? "44" : "90",
        "elk.layered.spacing.nodeNodeBetweenLayers": isVertical ? "56" : "130",
        "elk.edgeRouting": "ORTHOGONAL",
        "elk.layered.nodePlacement.strategy": "BRANDES_KOEPF",
        "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
        "elk.layered.layering.strategy": "NETWORK_SIMPLEX",
        "elk.padding": "[top=36,left=36,bottom=36,right=36]",
      },
      children: nodes.map((n) => ({ id: n.id, width: n.width ?? 240, height: n.height ?? 104 })),
      edges: edges.map((e) => ({ id: e.id, sources: [e.source], targets: [e.target] })),
    };
    const res = await elk.layout(g);
    return nodes.map((n) => {
      const p = res.children?.find((c) => c.id === n.id);
      return {
        ...n,
        position: { x: p?.x ?? 0, y: p?.y ?? 0 },
        sourcePosition: isVertical ? Position.Bottom : Position.Right,
        targetPosition: isVertical ? Position.Top : Position.Left,
      };
    });
  } catch {
    return nodes.map((n, i) => ({
      ...n,
      position: isVertical ? { x: 0, y: i * 150 } : { x: Math.floor(i / 4) * 300, y: (i % 4) * 150 },
      sourcePosition: isVertical ? Position.Bottom : Position.Right,
      targetPosition: isVertical ? Position.Top : Position.Left,
    }));
  }
}

function FitOnChange({ focusNodeId, nodes, version, focusLatest }: { focusNodeId?: string; nodes: Node<FlowNodeData>[]; version: number; focusLatest: boolean }) {
  const { fitView, setCenter } = useReactFlow();
  useEffect(() => {
    const frame = requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        if ((focusLatest || nodes.length > 30) && nodes.length > 3 && focusNodeId) {
          const focus = nodes.find((n) => n.id === focusNodeId);
          if (focus) {
            void setCenter(focus.position.x + (focus.width ?? 240) / 2, focus.position.y + (focus.height ?? 104) / 2, { zoom: focusLatest ? 0.55 : 0.42, duration: 180 });
            return;
          }
        }
        void fitView({ padding: 0.18, duration: 140, maxZoom: 0.9 });
      }),
    );
    return () => cancelAnimationFrame(frame);
  }, [fitView, focusLatest, focusNodeId, nodes, setCenter, version]);
  return null;
}

function FlowCanvas({ nodes, edges, focusNodeId, focusLatest, onNodeClick }: { nodes: Node<FlowNodeData>[]; edges: Edge[]; focusNodeId?: string; focusLatest: boolean; onNodeClick?: NodeMouseHandler }) {
  const [layouted, setLayouted] = useState<Node<FlowNodeData>[]>(nodes);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let active = true;
    void elkLayout(nodes, edges, focusLatest ? "RIGHT" : "DOWN").then((next) => {
      if (!active) return;
      setLayouted(next);
      setVersion((v) => v + 1);
    });
    return () => { active = false; };
  }, [nodes, edges, focusLatest]);

  return (
    <ReactFlow
      key={`flow-${nodes.length}`}
      nodes={layouted}
      edges={edges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      fitView
      nodesDraggable={false}
      nodesConnectable={false}
      zoomOnScroll={false}
      panOnScroll
      minZoom={0.36}
      maxZoom={1.25}
      onNodeClick={onNodeClick}
      defaultEdgeOptions={{
        type: "event",
        markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color: "#64748b" },
      }}
      proOptions={{ hideAttribution: true }}
    >
      <FitOnChange focusLatest={focusLatest} focusNodeId={focusNodeId} nodes={layouted} version={version} />
      <Background color="rgba(148,163,184,0.18)" gap={22} />
      <Controls position="bottom-right" showInteractive={false} />
    </ReactFlow>
  );
}

function findEntity(refId: string | null, facts: Fact[], tasks: Task[], actions: ActionCard[]) {
  if (!refId) return undefined;
  return facts.find((f) => f.id === refId) ?? tasks.find((t) => t.id === refId) ?? actions.find((a) => a.id === refId);
}

function DetailPanel({ entry, onClose, facts, tasks, actions }: { entry: TimelineEntry; onClose: () => void; facts: Fact[]; tasks: Task[]; actions: ActionCard[] }) {
  const entity = findEntity(entry.refId, facts, tasks, actions);
  return (
    <div className="graph-detail open">
      <div className="tf-gdetail-head">
        <span>{titleOf(entry)}</span>
        <button className="tf-btn" onClick={onClose}>Close</button>
      </div>
      <div className="tf-gdetail-title">{entry.detail}</div>
      <div className="tf-gdetail-id">{entry.id}</div>
      <div className="tf-gdetail-meta">
        <div className="tf-gdetail-kv"><span>time</span><span>{formatTime(entry.createdAt)}</span></div>
        <div className="tf-gdetail-kv"><span>type</span><span>{entry.eventType}</span></div>
        {entry.refId && <div className="tf-gdetail-kv"><span>ref</span><span>{entry.refId}</span></div>}
      </div>
      {entity && (
        <div className="tf-gdetail-rel">
          <div className="tf-gdetail-rel-h">Referenced entity</div>
          <div className="tf-gdetail-link">{entity.title}</div>
        </div>
      )}
    </div>
  );
}

const SpeedButton = memo(function SpeedButton({ value, speed, setSpeed }: { value: number; speed: number; setSpeed: (speed: number) => void }) {
  return (
    <button className={speed === value ? "active" : ""} type="button" aria-label={`Set replay speed to ${value}x`} aria-pressed={speed === value} onClick={() => setSpeed(value)}>
      {value}x
    </button>
  );
});

function GraphInner({ interactive }: { interactive: boolean }) {
  const { timeline, activeRun, facts, tasks, actions } = useStore(useShallow((state) => ({ timeline: state.timeline, activeRun: state.activeRun, facts: state.facts, tasks: state.tasks, actions: state.actions })));
  const [cursor, setCursor] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(2);
  const [selected, setSelected] = useState<TimelineEntry | null>(null);

  const visible = useMemo(() => timeline.slice(0, cursor), [timeline, cursor]);
  const graph = useMemo(() => buildTimelineGraph(visible, activeRun?.goal, facts, tasks, actions), [visible, activeRun?.goal, facts, tasks, actions]);

  useEffect(() => {
    if (!playing) return;
    if (cursor >= timeline.length) {
      setPlaying(false);
      return;
    }
    const timer = window.setTimeout(() => setCursor((c) => Math.min(c + 1, timeline.length)), Math.max(60, 500 / speed));
    return () => window.clearTimeout(timer);
  }, [cursor, playing, speed, timeline.length]);

  useEffect(() => {
    // 新事件到达时自动推进 cursor 到最新，保持“活态”
    if (!playing && timeline.length > 0 && cursor < timeline.length) {
      setCursor(timeline.length);
    }
  }, [timeline.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const current = visible[visible.length - 1];

  const onNodeClick: NodeMouseHandler = (_e, node) => {
    if (!interactive) return;
    const entry = visible.find((e) => e.id === node.id);
    if (entry) setSelected(entry);
  };

  if (timeline.length === 0) {
    return <div className="tf-empty">No events to replay. Start an agent run to see the reasoning chain.</div>;
  }

  return (
    <div className="graph-wrapper">
      <div className="graph-canvas" onClick={() => setSelected(null)}>
        <ReactFlowProvider>
          <FlowCanvas nodes={graph.nodes} edges={graph.edges} focusLatest={interactive} focusNodeId={graph.focusNodeId} onNodeClick={onNodeClick} />
        </ReactFlowProvider>
      </div>
      <div className="graph-footer">
        <div className="replay-controls">
          <button
            type="button"
            aria-label={playing ? "Pause graph replay" : "Start graph replay"}
            onClick={() => {
              if (playing) setPlaying(false);
              else {
                if (cursor >= timeline.length) setCursor(0);
                setPlaying(true);
              }
            }}
          >
            {playing ? <Pause size={14} /> : <Play size={14} />}
            {playing ? "Pause" : "Replay"}
          </button>
          <button
            type="button"
            aria-label="Reset graph replay"
            onClick={() => {
              setPlaying(false);
              setCursor(0);
            }}
          >
            <ArrowCounterClockwise size={14} />
          </button>
          {[1, 2, 4].map((v) => (
            <SpeedButton key={v} value={v} speed={speed} setSpeed={setSpeed} />
          ))}
        </div>
        <input
          aria-label="Graph replay progress"
          max={timeline.length}
          min={0}
          type="range"
          value={cursor}
          onChange={(e) => {
            setPlaying(false);
            setCursor(Number(e.target.value));
          }}
        />
        <div className="current-event">
          <span>{cursor} / {timeline.length}</span>
          <strong>{current ? clip(current.detail, 80) : "Ready"}</strong>
        </div>
      </div>
      {interactive && selected && (
        <DetailPanel entry={selected} onClose={() => setSelected(null)} facts={facts} tasks={tasks} actions={actions} />
      )}
    </div>
  );
}

export function GraphView({ interactive }: { interactive: boolean }) {
  return <ReactFlowProvider><GraphInner interactive={interactive} /></ReactFlowProvider>;
}
