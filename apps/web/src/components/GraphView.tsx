import { useEffect, useMemo, useState, memo } from "react";
import {
  Background, BaseEdge, Controls, EdgeLabelRenderer, Handle, MarkerType, Position,
  ReactFlow, ReactFlowProvider, getBezierPath, useReactFlow,
  type Edge, type EdgeProps, type Node, type NodeProps, type NodeMouseHandler,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  ArrowCounterClockwise, Pause, Play,
} from "@phosphor-icons/react";
import { useStore } from "../store.js";
import type { Fact, Task, ActionCard, Hypothesis, TimelineEntry } from "@traceforge/shared";
import { useShallow } from "zustand/react/shallow";
import { FeedbackState } from "./ui/feedback-state.js";

const KIND_META: Record<string, { label: string }> = {
  fact: { label: "Fact" },
  memory: { label: "Memory" },
  task: { label: "Task" },
  idea: { label: "Task" },
  action: { label: "Action" },
  solver: { label: "Agent" },
  flag: { label: "Flag" },
  hypothesis: { label: "Hypothesis" },
  note: { label: "Event" },
  goal: { label: "Objective" },
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
  if (t === "hypothesis") return "hypothesis";
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

export type FlowNodeData = {
  entry: TimelineEntry;
  kind: string;
  title: string;
  body: string;
  meta: string;
  active?: boolean;
};

function BwNode({ data }: NodeProps<Node<FlowNodeData>>) {
  const meta = KIND_META[data.kind] ?? KIND_META.note;
  return (
    <div className={`flow-card ${data.kind}${data.active ? " is-active" : ""}`}>
      <Handle className="flow-handle" position={Position.Top} type="target" />
      <Handle className="flow-handle" position={Position.Bottom} type="source" />
      <Handle className="flow-handle" position={Position.Left} type="target" />
      <Handle className="flow-handle" position={Position.Right} type="source" />
      <div className="flow-card-head">
        <span className="flow-kind"><i aria-hidden="true" />{meta.label}</span>
        <span className="flow-time">{data.meta}</span>
      </div>
      <strong className="flow-title">{clip(data.body, 96)}</strong>
      <span className="flow-sub">{data.title}</span>
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
          stroke: style?.stroke ?? "var(--border-strong)",
          strokeWidth: active ? 2 : 1.4,
          strokeOpacity: active ? 0.95 : 0.65,
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
export const GRAPH_NODE_WINDOW_SIZE = 240;

export type GraphNodeSelection = { type: "fact"; id: string } | { type: "task"; id: string } | { type: "timeline"; id: string };

export function graphNodeSelection(entry: TimelineEntry): GraphNodeSelection {
  const kind = kindOf(entry);
  if (entry.refId && kind === "fact") return { type: "fact", id: entry.refId };
  if (entry.refId && kind === "task") return { type: "task", id: entry.refId };
  return { type: "timeline", id: entry.id };
}

export function graphTimelineWindow(timeline: TimelineEntry[], cursor: number, limit = GRAPH_NODE_WINDOW_SIZE, pinnedId?: string | null) {
  const end = Math.min(timeline.length, Math.max(0, cursor));
  let start = Math.max(0, end - limit);
  if (pinnedId) {
    const pinnedIndex = timeline.findIndex((entry) => entry.id === pinnedId);
    if (pinnedIndex >= 0 && pinnedIndex < start) start = pinnedIndex;
  }
  return { entries: timeline.slice(start, end), start, end, truncated: start > 0 };
}

export function buildTimelineGraph(
  timeline: TimelineEntry[],
  goal: string | null | undefined,
  facts: Fact[],
  tasks: Task[],
  actions: ActionCard[],
  hypotheses: Hypothesis[] = [],
) {
  if (timeline.length === 0) return { nodes: [] as Node<FlowNodeData>[], edges: [] as Edge[], focusNodeId: undefined as string | undefined };

  const nodes: Node<FlowNodeData>[] = [];
  const edges: Edge[] = [];
  const taskById = new Map(tasks.map((t) => [t.id, t]));
  const actionById = new Map(actions.map((a) => [a.id, a]));
  const edgeIds = new Set<string>();
  const latestNodeByRef = new Map<string, string>();
  const latestNodeByKind = new Map<string, string>();
  let latestContextNode: string | undefined;

  if (goal) {
    nodes.push({
      id: "__goal__",
      type: "bw",
      position: { x: 0, y: 0 },
      width: 264,
      height: 108,
      data: {
        entry: timeline[0],
        kind: "goal",
        title: "Case goal",
        body: goal,
        meta: "objective",
      },
    });
  }

  const addEdge = (source: string | undefined, target: string, label: string, active = false) => {
    if (!source || source === target) return false;
    const id = `${source}->${target}:${label}`;
    if (edgeIds.has(id)) return false;
    edgeIds.add(id);
    edges.push({
      id,
      source,
      target,
      type: "event",
      label,
      markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color: "#7A8794" },
      style: { stroke: "var(--border-strong)" },
      data: { active },
    });
    return true;
  };

  const addFactEdges = (factIds: string[], target: string, label: string, active: boolean) => {
    let added = false;
    for (const factId of factIds) {
      const source = latestNodeByRef.get(factId);
      added = addEdge(source, target, label, active) || added;
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
      width: 264,
      height: 108,
      data: {
        entry,
        kind,
        title: titleOf(entry),
        body: entry.detail,
        meta: formatTime(entry.createdAt),
        active,
      },
    });

    let connected = false;
    if (entry.refId) {
      connected = addEdge(latestNodeByRef.get(entry.refId), entry.id, "update", active) || connected;
    }

    if (kind === "task" && entry.refId) {
      const task = taskById.get(entry.refId);
      connected = addFactEdges(task?.relatedFacts ?? [], entry.id, "evidence", active) || connected;
    }

    if (kind === "action" && entry.refId) {
      const action = actionById.get(entry.refId);
      connected = addFactEdges(action?.evidenceRefs ?? [], entry.id, "evidence", active) || connected;
      for (const taskId of action?.taskRefs ?? []) {
        connected = addEdge(latestNodeByRef.get(taskId), entry.id, "task", active) || connected;
      }
    }

    if (kind === "solver") {
      connected = addEdge(latestContextNode ?? (goal ? "__goal__" : undefined), entry.id, latestContextNode ? "refresh" : "start", active) || connected;
    } else if (!connected) {
      connected = addEdge(latestContextNode, entry.id, "uses", active) || connected;
    }

    if (!connected) {
      connected = addEdge(latestNodeByKind.get(kind), entry.id, "next", active) || connected;
    }

    if (!connected && goal) {
      addEdge("__goal__", entry.id, "related", active);
    }

    if (entry.refId) {
      latestNodeByRef.set(entry.refId, entry.id);
    }
    if (kind === "solver") latestContextNode = entry.id;
    latestNodeByKind.set(kind, entry.id);
  }

  // Hypotheses have no timeline entries of their own; they are synthesized as
  // virtual nodes at the live tail and wired to the facts that support them.
  for (const hypothesis of hypotheses) {
    const id = `hyp-${hypothesis.id}`;
    const entry: TimelineEntry = {
      id,
      caseId: hypothesis.caseId,
      eventType: "hypothesis",
      refId: null,
      detail: hypothesis.statement,
      createdAt: hypothesis.updatedAt || hypothesis.createdAt,
    };
    nodes.push({
      id,
      type: "bw",
      position: { x: 0, y: 0 },
      width: 264,
      height: 108,
      data: {
        entry,
        kind: "hypothesis",
        title: "Hypothesis",
        body: hypothesis.statement,
        meta: hypothesis.status,
      },
    });
    let connected = false;
    for (const factId of hypothesis.basedOnFactIds) {
      connected = addEdge(latestNodeByRef.get(factId), id, "supports") || connected;
    }
    if (!connected) {
      addEdge(latestContextNode ?? (goal ? "__goal__" : undefined), id, "related");
    }
  }

  return { nodes, edges, focusNodeId: timeline[timeline.length - 1]?.id };
}

type LayoutPosition = { x: number; y: number };
const layoutCache = new Map<string, Map<string, LayoutPosition>>();
const MAX_LAYOUT_CACHE_ENTRIES = 16;

function layoutKey(nodes: Node<FlowNodeData>[], edges: Edge[], direction: "RIGHT" | "DOWN") {
  return `${direction}|${nodes.map((node) => node.id).join(",")}|${edges.map((edge) => `${edge.source}>${edge.target}`).join(",")}`;
}

export function layeredLayout(nodes: Node<FlowNodeData>[], edges: Edge[], direction: "RIGHT" | "DOWN"): Node<FlowNodeData>[] {
  const cacheKey = layoutKey(nodes, edges, direction);
  const cached = layoutCache.get(cacheKey);
  const isVertical = direction === "DOWN";
  const applyPosition = (node: Node<FlowNodeData>, position: LayoutPosition): Node<FlowNodeData> => ({
    ...node,
    position,
    sourcePosition: isVertical ? Position.Bottom : Position.Right,
    targetPosition: isVertical ? Position.Top : Position.Left,
  });
  if (cached) return nodes.map((node) => applyPosition(node, cached.get(node.id) ?? { x: 0, y: 0 }));

  const order = new Map(nodes.map((node, index) => [node.id, index]));
  const indegree = new Map(nodes.map((node) => [node.id, 0]));
  const outgoing = new Map(nodes.map((node) => [node.id, [] as string[]]));
  const incoming = new Map(nodes.map((node) => [node.id, [] as string[]]));

  for (const edge of edges) {
    if (!indegree.has(edge.source) || !indegree.has(edge.target) || edge.source === edge.target) continue;
    outgoing.get(edge.source)?.push(edge.target);
    incoming.get(edge.target)?.push(edge.source);
    indegree.set(edge.target, (indegree.get(edge.target) ?? 0) + 1);
  }

  const layer = new Map<string, number>();
  const queue = nodes.filter((node) => indegree.get(node.id) === 0).map((node) => node.id);
  for (const id of queue) layer.set(id, 0);
  let cursor = 0;
  while (cursor < queue.length) {
    const source = queue[cursor++];
    const nextLayer = (layer.get(source) ?? 0) + 1;
    for (const target of outgoing.get(source) ?? []) {
      layer.set(target, Math.max(layer.get(target) ?? 0, nextLayer));
      const nextIndegree = (indegree.get(target) ?? 1) - 1;
      indegree.set(target, nextIndegree);
      if (nextIndegree === 0) queue.push(target);
    }
  }

  // Malformed imported data may contain cycles. Place remaining nodes after
  // their latest resolved predecessor instead of failing the entire graph.
  for (const node of nodes) {
    if (layer.has(node.id)) continue;
    const predecessorLayers = (incoming.get(node.id) ?? []).map((id) => layer.get(id)).filter((value): value is number => value !== undefined);
    layer.set(node.id, predecessorLayers.length > 0 ? Math.max(...predecessorLayers) + 1 : 0);
  }

  const groups = new Map<number, string[]>();
  for (const node of nodes) {
    const nodeLayer = layer.get(node.id) ?? 0;
    const group = groups.get(nodeLayer) ?? [];
    group.push(node.id);
    groups.set(nodeLayer, group);
  }
  for (const group of groups.values()) group.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));

  const positions = new Map<string, LayoutPosition>();
  const positioned = nodes.map((node) => {
    const nodeLayer = layer.get(node.id) ?? 0;
    const group = groups.get(nodeLayer) ?? [node.id];
    const lane = group.indexOf(node.id) - (group.length - 1) / 2;
    const position = isVertical ? { x: lane * 290, y: nodeLayer * 168 } : { x: nodeLayer * 330, y: lane * 148 };
    positions.set(node.id, position);
    return applyPosition(node, position);
  });

  layoutCache.set(cacheKey, positions);
  if (layoutCache.size > MAX_LAYOUT_CACHE_ENTRIES) layoutCache.delete(layoutCache.keys().next().value!);
  return positioned;
}

function FitOnChange({ focusNodeId, nodes, focusLatest, pinnedNodeId }: { focusNodeId?: string; nodes: Node<FlowNodeData>[]; focusLatest: boolean; pinnedNodeId?: string | null }) {
  const { fitView, setCenter } = useReactFlow();
  useEffect(() => {
    const frame = requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        if (pinnedNodeId) {
          const pinned = nodes.find((n) => n.id === pinnedNodeId);
          if (pinned) {
            void setCenter(pinned.position.x + (pinned.width ?? 264) / 2, pinned.position.y + (pinned.height ?? 108) / 2, { zoom: 0.8, duration: 220 });
            return;
          }
        }
        // Small chains should remain fully visible. Centering the latest node on a
        // four-step replay clips the first node and makes the sequence look broken.
        if ((focusLatest || nodes.length > 30) && nodes.length > 8 && focusNodeId) {
          const focus = nodes.find((n) => n.id === focusNodeId);
          if (focus) {
            void setCenter(focus.position.x + (focus.width ?? 264) / 2, focus.position.y + (focus.height ?? 108) / 2, { zoom: focusLatest ? 0.55 : 0.42, duration: 180 });
            return;
          }
        }
        void fitView({ padding: 0.18, duration: 140, maxZoom: 0.9 });
      }),
    );
    return () => cancelAnimationFrame(frame);
  }, [fitView, focusLatest, focusNodeId, nodes, pinnedNodeId, setCenter]);
  return null;
}

function FlowCanvas({ nodes, edges, focusNodeId, focusLatest, pinnedNodeId, onNodeClick, onPaneClick }: { nodes: Node<FlowNodeData>[]; edges: Edge[]; focusNodeId?: string; focusLatest: boolean; pinnedNodeId?: string | null; onNodeClick?: NodeMouseHandler; onPaneClick?: () => void }) {
  const layouted = useMemo(() => layeredLayout(nodes, edges, focusLatest ? "RIGHT" : "DOWN"), [nodes, edges, focusLatest]);

  return (
    <ReactFlow
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
      onPaneClick={onPaneClick}
      defaultEdgeOptions={{
        type: "event",
        markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color: "#7A8794" },
      }}
      proOptions={{ hideAttribution: true }}
    >
      <FitOnChange focusLatest={focusLatest} focusNodeId={focusNodeId} nodes={layouted} pinnedNodeId={pinnedNodeId} />
      <Background color="rgba(148,163,184,0.18)" gap={22} />
      <Controls position="bottom-right" showInteractive={false} />
    </ReactFlow>
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
  const { timeline, runGoal, facts, tasks, actions, hypotheses, selectedFactId, selectedTaskId, selectedTimelineNodeId, selectFact, selectTask, selectTimelineNode, setKnowledgeDialog } = useStore(useShallow((state) => ({
    timeline: state.timeline,
    runGoal: state.activeRun?.goal ?? null,
    facts: state.facts,
    tasks: state.tasks,
    actions: state.actions,
    hypotheses: state.hypotheses,
    selectedFactId: state.selectedFactId,
    selectedTaskId: state.selectedTaskId,
    selectedTimelineNodeId: state.selectedTimelineNodeId,
    selectFact: state.selectFact,
    selectTask: state.selectTask,
    selectTimelineNode: state.selectTimelineNode,
    setKnowledgeDialog: state.setKnowledgeDialog,
  })));
  const [cursor, setCursor] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(2);

  // The selected entity is pinned into the visible window so its node stays
  // on the canvas even when newer events would push it past the cap.
  const selectedNodeId = useMemo(() => {
    if (selectedTimelineNodeId) return selectedTimelineNodeId;
    const refId = selectedFactId ?? selectedTaskId;
    if (!refId) return null;
    for (let i = timeline.length - 1; i >= 0; i--) {
      if (timeline[i].refId === refId) return timeline[i].id;
    }
    return null;
  }, [timeline, selectedFactId, selectedTaskId, selectedTimelineNodeId]);

  const timelineWindow = useMemo(() => graphTimelineWindow(timeline, cursor, GRAPH_NODE_WINDOW_SIZE, selectedNodeId), [timeline, cursor, selectedNodeId]);
  const visible = timelineWindow.entries;
  const liveTail = cursor >= timeline.length;
  const graph = useMemo(() => buildTimelineGraph(visible, runGoal, facts, tasks, actions, liveTail ? hypotheses : []), [visible, runGoal, facts, tasks, actions, hypotheses, liveTail]);
  const nodes = useMemo(
    () => graph.nodes.map((node) => (node.id === selectedNodeId ? { ...node, selected: true } : node)),
    [graph.nodes, selectedNodeId],
  );

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
    if (node.id.startsWith("hyp-")) {
      setKnowledgeDialog("hypotheses");
      return;
    }
    const entry = visible.find((e) => e.id === node.id);
    if (!entry) return;
    const target = graphNodeSelection(entry);
    if (target.type === "fact") selectFact(target.id);
    else if (target.type === "task") selectTask(target.id);
    else selectTimelineNode(target.id);
    // Validation entries also live in the run console: surface the matching
    // console row so the operator sees both projections of the same event.
    if (entry.eventType.startsWith("validation_")) {
      globalThis.dispatchEvent(new CustomEvent("traceforge:jump-to-validation", { detail: { eventType: entry.eventType, detail: entry.detail } }));
    } else {
      // 其余实体节点走 refs 精确反查:console 里产出该实体的 tool 事件。
      // AgentPanel 侧有匹配才展开 dock 并定位,无匹配则静默。
      globalThis.dispatchEvent(new CustomEvent("traceforge:jump-to-event-ref", { detail: { refId: target.id } }));
    }
  };

  const onPaneClick = () => {
    if (!interactive) return;
    selectTimelineNode(null);
  };

  if (timeline.length === 0) {
    return <FeedbackState title="No events to replay" description="Start an Agent run to build and inspect its reasoning chain." />;
  }

  return (
    <div className="graph-wrapper">
      <div className="graph-canvas">
        <FlowCanvas
          nodes={nodes}
          edges={graph.edges}
          focusLatest={interactive && !selectedNodeId}
          focusNodeId={graph.focusNodeId}
          pinnedNodeId={interactive ? selectedNodeId : null}
          onNodeClick={onNodeClick}
          onPaneClick={onPaneClick}
        />
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
          {timelineWindow.truncated && <small>Showing latest {visible.length} events</small>}
        </div>
      </div>
    </div>
  );
}

export function GraphView({ interactive }: { interactive: boolean }) {
  return <ReactFlowProvider><GraphInner interactive={interactive} /></ReactFlowProvider>;
}
