import {
  Background,
  BaseEdge,
  Controls,
  Edge,
  EdgeLabelRenderer,
  EdgeProps,
  Handle,
  MarkerType,
  Node,
  Position,
  ReactFlow,
  ReactFlowProvider,
  getBezierPath,
  useReactFlow,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import ELK from "elkjs/lib/elk.bundled.js";
import {
  Bot,
  ChevronRight,
  CircleDot,
  Database,
  Flag,
  Globe2,
  Lightbulb,
  LockKeyhole,
  Pause,
  Play,
  RotateCcw,
  Send,
  ShieldCheck,
  TerminalSquare,
  SquareMousePointer,
} from "lucide-react";
import { ReactNode, memo, useEffect, useMemo, useState } from "react";

type EventKind = "solver_started" | "idea_added" | "memory_added" | "flag_submitted";
type LaneId = "hub" | "1oid-all" | "kimi-security" | "1oid-merge-subagent" | "1oid-all-round";

type TimelineEvent = {
  id: string;
  time: string;
  lane: LaneId;
  solverId?: Exclude<LaneId, "hub">;
  kind: EventKind;
  title: string;
  summary: string;
  entityId?: string;
  refs?: string[];
  group?: "pending" | "testing" | "evidence" | "fact" | "hint" | "flag";
};

type FlowNodeData = { label: ReactNode; nodeClass?: string };
type FlowNode = Node<FlowNodeData>;
type RequestRecord = {
  id: string;
  time: string;
  method: "GET" | "POST" | "PUT";
  status: number;
  host: string;
  path: string;
  size: string;
  latency: string;
  risk: "low" | "watch" | "high";
};

const challengeTitle = "图片资源管理系统";
const challengeSummary =
  "1/1 flags · 公司新上线的图片资源管理系统，用于统一管理各部门的业务图片。系统支持图片上传、分类管理和 XML 格式批量导入配置。";

const events: TimelineEvent[] = [
  { id: "e01", time: "10:45:02", lane: "1oid-all", solverId: "1oid-all", kind: "solver_started", title: "Solver started", summary: "kimi-security · 14 events" },
  { id: "e02", time: "10:45:13", lane: "kimi-security", solverId: "kimi-security", kind: "solver_started", title: "Solver started", summary: "1oid-merge-subagent" },
  { id: "e03", time: "10:45:43", lane: "1oid-all", solverId: "1oid-all", kind: "idea_added", entityId: "idea-xxe", group: "pending", title: "Idea added", summary: "XXE via XML import for image upload" },
  { id: "e04", time: "10:46:43", lane: "1oid-all", solverId: "1oid-all", kind: "idea_added", entityId: "idea-admin", group: "testing", title: "Idea added", summary: "Explore admin action for privilege escalation" },
  { id: "e05", time: "10:45:43", lane: "kimi-security", solverId: "kimi-security", kind: "memory_added", entityId: "memory-apache", group: "evidence", title: "Memory added", summary: "图片资源管理系统使用 Apache/2.4.54" },
  { id: "e06", time: "10:46:27", lane: "1oid-all", solverId: "1oid-all", kind: "memory_added", entityId: "memory-upload", refs: ["idea-xxe"], group: "evidence", title: "Memory added", summary: "图片上传支持 XML 批量导入配置" },
  { id: "e07", time: "10:47:02", lane: "1oid-merge-subagent", solverId: "1oid-merge-subagent", kind: "solver_started", title: "Solver started", summary: "1oid-merge-subagent-masterprompt" },
  { id: "e08", time: "10:47:20", lane: "1oid-all", solverId: "1oid-all", kind: "idea_added", entityId: "idea-ssrf", refs: ["idea-admin"], group: "pending", title: "Idea updated", summary: "XXE -> SSRF via admin API key or debug function" },
  { id: "e09", time: "10:51:31", lane: "kimi-security", solverId: "kimi-security", kind: "memory_added", entityId: "memory-utf16", refs: ["idea-xxe", "memory-upload"], group: "evidence", title: "Memory added", summary: "已通过 XXE UTF-16 绕过 waf，读取 config.php" },
  { id: "e10", time: "10:53:04", lane: "1oid-merge-subagent", solverId: "1oid-merge-subagent", kind: "memory_added", entityId: "memory-config", refs: ["memory-utf16"], group: "fact", title: "Memory added", summary: "config.php 暴露 DB_USER 与内部管理 API key" },
  { id: "e11", time: "10:54:18", lane: "1oid-all", solverId: "1oid-all", kind: "idea_added", entityId: "idea-log-poison", refs: ["memory-apache"], group: "hint", title: "Idea added", summary: "Poison Apache access log then include through PHP endpoint" },
  { id: "e12", time: "10:55:03", lane: "kimi-security", solverId: "kimi-security", kind: "memory_added", entityId: "memory-debug", refs: ["idea-admin", "memory-config"], group: "evidence", title: "Memory added", summary: "admin debug 接口可从内网读取指定 URL" },
  { id: "e13", time: "10:56:11", lane: "1oid-all", solverId: "1oid-all", kind: "idea_added", entityId: "idea-ssrf-metadata", refs: ["idea-ssrf", "memory-debug"], group: "testing", title: "Idea updated", summary: "Use debug SSRF to query metadata and local file wrappers" },
  { id: "e14", time: "10:57:32", lane: "1oid-merge-subagent", solverId: "1oid-merge-subagent", kind: "memory_added", entityId: "memory-wrapper", refs: ["idea-ssrf-metadata"], group: "evidence", title: "Memory added", summary: "php://filter wrapper returned base64 encoded route source" },
  { id: "e15", time: "10:58:40", lane: "1oid-all", solverId: "1oid-all", kind: "idea_added", entityId: "idea-rce", refs: ["memory-wrapper", "idea-log-poison"], group: "pending", title: "Idea updated", summary: "RCE via PHP file write and include chain" },
  { id: "e16", time: "10:59:19", lane: "kimi-security", solverId: "kimi-security", kind: "memory_added", entityId: "memory-upload-path", refs: ["memory-upload"], group: "fact", title: "Memory added", summary: "上传文件落在 /var/www/html/uploads/yyyy/mm/uuid 路径" },
  { id: "e17", time: "11:00:25", lane: "1oid-all", solverId: "1oid-all", kind: "memory_added", entityId: "memory-write", refs: ["idea-rce", "memory-upload-path"], group: "evidence", title: "Memory added", summary: "XML import error message leaks written temp file absolute path" },
  { id: "e18", time: "11:01:02", lane: "1oid-merge-subagent", solverId: "1oid-merge-subagent", kind: "idea_added", entityId: "idea-session", refs: ["memory-config"], group: "hint", title: "Idea added", summary: "Forge admin session using leaked signing secret" },
  { id: "e19", time: "11:01:40", lane: "1oid-all", solverId: "1oid-all", kind: "memory_added", entityId: "memory-secret", refs: ["memory-config", "idea-session"], group: "evidence", title: "Memory added", summary: "JWT_SECRET confirmed from config and matches cookie signature" },
  { id: "e20", time: "11:02:05", lane: "kimi-security", solverId: "kimi-security", kind: "memory_added", entityId: "memory-shell", refs: ["memory-write", "idea-rce"], group: "evidence", title: "Memory added", summary: "包含上传 payload 后执行 whoami 返回 www-data" },
  { id: "e21", time: "11:02:31", lane: "1oid-all-round", solverId: "1oid-all-round", kind: "solver_started", title: "Solver started", summary: "1oid-all-round verification pass" },
  { id: "e22", time: "11:02:48", lane: "1oid-all-round", solverId: "1oid-all-round", kind: "memory_added", entityId: "memory-admin", refs: ["memory-secret", "memory-shell"], group: "fact", title: "Memory added", summary: "管理员用户凭据和 shell 输出互相验证，权限链闭合" },
  { id: "e23", time: "11:03:30", lane: "1oid-all-round", solverId: "1oid-all-round", kind: "flag_submitted", entityId: "flag", refs: ["memory-admin"], group: "flag", title: "Flag submitted", summary: "已提交并拿到管理员用户凭据" },
];

const traffic: RequestRecord[] = [
  { id: "r01", time: "10:45:40", method: "GET", status: 200, host: "img-admin.local", path: "/upload", size: "18.4 KB", latency: "42 ms", risk: "low" },
  { id: "r02", time: "10:45:43", method: "POST", status: 500, host: "img-admin.local", path: "/api/import/xml", size: "2.1 KB", latency: "318 ms", risk: "watch" },
  { id: "r03", time: "10:46:27", method: "POST", status: 200, host: "img-admin.local", path: "/api/import/xml?batch=1", size: "3.8 KB", latency: "284 ms", risk: "watch" },
  { id: "r04", time: "10:51:31", method: "POST", status: 200, host: "img-admin.local", path: "/api/import/xml;charset=utf-16", size: "6.7 KB", latency: "611 ms", risk: "high" },
  { id: "r05", time: "10:53:04", method: "GET", status: 200, host: "img-admin.local", path: "/download?file=config.php", size: "1.9 KB", latency: "92 ms", risk: "high" },
  { id: "r06", time: "10:55:03", method: "POST", status: 202, host: "admin.img.local", path: "/debug/fetch", size: "732 B", latency: "410 ms", risk: "watch" },
  { id: "r07", time: "10:57:32", method: "GET", status: 200, host: "127.0.0.1", path: "/index.php?view=php://filter", size: "8.2 KB", latency: "506 ms", risk: "high" },
  { id: "r08", time: "11:00:25", method: "POST", status: 200, host: "img-admin.local", path: "/api/import/xml", size: "4.4 KB", latency: "533 ms", risk: "high" },
  { id: "r09", time: "11:01:40", method: "GET", status: 302, host: "img-admin.local", path: "/admin/session/verify", size: "418 B", latency: "64 ms", risk: "watch" },
  { id: "r10", time: "11:02:05", method: "POST", status: 200, host: "img-admin.local", path: "/uploads/2026/04/payload.php", size: "96 B", latency: "147 ms", risk: "high" },
];

const elk = new ELK();

function clip(value: unknown, max = 90) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length <= max ? text : `${text.slice(0, max)}...`;
}

function eventColor(event?: TimelineEvent) {
  if (!event) return "#64748b";
  if (event.kind === "flag_submitted") return "#d97706";
  if (event.kind === "memory_added") return "#2563eb";
  if (event.kind === "idea_added") return "#b45309";
  if (event.kind === "solver_started") return "#059669";
  return "#64748b";
}

function EventEdge(props: EdgeProps) {
  const { id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, markerEnd, style, label } = props;
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
          strokeDasharray: active ? "9 7" : style?.strokeDasharray,
        }}
      >
        {active ? <animate attributeName="stroke-dashoffset" dur="1.2s" repeatCount="indefinite" values="0;-16" /> : null}
      </path>
      <BaseEdge id={id} path={path} style={{ stroke: "transparent", strokeWidth: 10 }} />
      {label ? (
        <EdgeLabelRenderer>
          <div className="edge-label" style={{ left: `${labelX}px`, top: `${labelY}px` }}>
            {clip(label, 28)}
          </div>
        </EdgeLabelRenderer>
      ) : null}
    </g>
  );
}

const edgeTypes = { event: EventEdge };

function BwNode({ data }: NodeProps<FlowNode>) {
  return (
    <div className={`flow-card ${data.nodeClass ?? ""}`}>
      <Handle className="flow-handle" position={Position.Top} type="target" />
      <Handle className="flow-handle" position={Position.Bottom} type="source" />
      <Handle className="flow-handle" position={Position.Left} type="target" />
      <Handle className="flow-handle" position={Position.Right} type="source" />
      {data.label}
    </div>
  );
}

const nodeTypes = { bw: BwNode };

function CardLabel({
  kind,
  title,
  body,
  meta,
}: {
  kind: "task" | "solver" | "idea" | "memory" | "flag";
  title: string;
  body: string;
  meta?: string;
}) {
  const Icon = kind === "task" ? ShieldCheck : kind === "solver" ? Bot : kind === "idea" ? Lightbulb : kind === "flag" ? Flag : Database;
  return (
    <div className="flow-card-content">
      <div className="flow-card-head">
        <span className="flow-icon">
          <Icon size={13} />
        </span>
        <div>
          <span>{kind === "task" ? "OBJECTIVE" : kind.toUpperCase()}</span>
          <strong>{clip(title, 52)}</strong>
        </div>
      </div>
      <p>{clip(body, 108)}</p>
      {meta ? <small>{meta}</small> : null}
    </div>
  );
}

async function layout(nodes: FlowNode[], edges: Edge[]) {
  const graph = {
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "DOWN",
      "elk.spacing.nodeNode": "88",
      "elk.layered.spacing.nodeNodeBetweenLayers": "138",
      "elk.edgeRouting": "ORTHOGONAL",
      "elk.layered.nodePlacement.strategy": "BRANDES_KOEPF",
      "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
      "elk.layered.layering.strategy": "NETWORK_SIMPLEX",
      "elk.padding": "[top=36,left=36,bottom=36,right=36]",
    },
    children: nodes.map((node) => ({ id: node.id, width: node.width ?? 240, height: node.height ?? 108 })),
    edges: edges.map((edge) => ({ id: edge.id, sources: [edge.source], targets: [edge.target] })),
  };
  const result = await elk.layout(graph);
  return nodes.map((node) => {
    const placed = result.children?.find((child) => child.id === node.id);
    return {
      ...node,
      position: { x: placed?.x ?? 0, y: placed?.y ?? 0 },
      sourcePosition: Position.Bottom,
      targetPosition: Position.Top,
    };
  });
}

function FitOnChange({ focusNodeId, nodes, version }: { focusNodeId?: string; nodes: FlowNode[]; version: number }) {
  const { fitView, setCenter } = useReactFlow();
  useEffect(() => {
    const frame = requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        if (nodes.length > 7 && focusNodeId) {
          const focus = nodes.find((node) => node.id === focusNodeId);
          if (focus) {
            void setCenter(focus.position.x + (focus.width ?? 230) / 2, focus.position.y + (focus.height ?? 108) / 2, { zoom: 0.38, duration: 180 });
            return;
          }
        }
        void fitView({ padding: 0.28, duration: 120 });
      }),
    );
    return () => cancelAnimationFrame(frame);
  }, [fitView, focusNodeId, nodes, setCenter, version]);
  return null;
}

function FlowCanvas({ focusNodeId, nodes, edges }: { focusNodeId?: string; nodes: FlowNode[]; edges: Edge[] }) {
  const [layouted, setLayouted] = useState({ nodes, edges });
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let active = true;
    void layout(nodes, edges).then((next) => {
      if (!active) return;
      setLayouted({ nodes: next, edges });
      setVersion((value) => value + 1);
    });
    return () => {
      active = false;
    };
  }, [edges, nodes]);

  return (
    <ReactFlow
      key={`knowledge-${nodes.length}`}
      nodes={layouted.nodes}
      edges={layouted.edges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      fitView
      nodesDraggable={false}
      nodesConnectable={false}
      zoomOnScroll={false}
      panOnScroll
      minZoom={0.12}
      maxZoom={1.25}
      defaultEdgeOptions={{
        type: "event",
        markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color: "#64748b" },
      }}
      proOptions={{ hideAttribution: true }}
    >
      <FitOnChange focusNodeId={focusNodeId} version={version} nodes={layouted.nodes} />
      <Background color="rgba(148,163,184,0.18)" gap={22} />
      <Controls position="bottom-right" showInteractive={false} />
    </ReactFlow>
  );
}

function buildKnowledgeGraph(visible: TimelineEvent[]) {
  const boardEvents = visible.filter((event) => event.entityId && event.kind !== "solver_started");
  const nodes: FlowNode[] = [
    {
      id: "task",
      type: "bw",
      position: { x: 0, y: 0 },
      width: 420,
      height: 138,
      data: { label: <CardLabel kind="task" title={challengeTitle} body={challengeSummary} />, nodeClass: "task" },
    },
  ];
  const edges: Edge[] = [];

  for (const event of boardEvents) {
    const isIdea = event.kind === "idea_added";
    const isFlag = event.kind === "flag_submitted";
    const nodeId = `k:${event.entityId}`;
    nodes.push({
      id: nodeId,
      type: "bw",
      position: { x: 0, y: 0 },
      width: 226,
      height: 104,
      data: {
        nodeClass: event.group ?? "",
        label: (
          <CardLabel
            kind={isFlag ? "flag" : isIdea ? "idea" : "memory"}
            title={isIdea ? event.summary : event.group === "fact" ? "Finding" : event.group === "hint" ? "Hint" : "Evidence"}
            body={event.summary}
            meta={event.group === "pending" ? "2 updates" : event.group === "evidence" ? "3 updates" : undefined}
          />
        ),
      },
    });
    const sources = event.refs?.length ? event.refs.map((ref) => `k:${ref}`) : ["task"];
    for (const candidateSource of sources) {
      const source = nodes.some((node) => node.id === candidateSource) ? candidateSource : "task";
      edges.push({
        id: `${source}-${nodeId}-${event.id}`,
        source,
        target: nodeId,
        type: "event",
        label: source === "task" ? (isFlag ? "result" : "source") : isFlag ? "verified" : "distilled",
        style: { stroke: eventColor(event), strokeDasharray: isFlag ? "7 6" : "5 6" },
        data: { active: visible[visible.length - 1]?.id === event.id },
      });
    }
  }

  const latestBoardEvent = boardEvents[boardEvents.length - 1];
  return { nodes, edges, focusNodeId: latestBoardEvent?.entityId ? `k:${latestBoardEvent.entityId}` : "task" };
}

function TrafficPanel({ activeIndex, browserOpen, onBrowserOpen }: { activeIndex: number; browserOpen: boolean; onBrowserOpen: () => void }) {
  return (
    <aside className="panel traffic-panel">
      <div className="panel-header">
        <div>
          <span className="section-kicker">Capture</span>
          <h2>Traffic</h2>
        </div>
        <button className={browserOpen ? "browser-button active" : "browser-button"} onClick={onBrowserOpen}>
          <SquareMousePointer size={15} />
          {browserOpen ? "Browser Active" : "Open Browser"}
        </button>
      </div>
      <div className="browser-strip">
        <Globe2 size={14} />
        <span>{browserOpen ? "img-admin.local/upload" : "No browser session attached"}</span>
        <i />
      </div>
      <div className="request-list">
        {traffic.map((record, index) => (
          <article className={`request-row ${record.risk} ${index === activeIndex ? "selected" : ""}`} key={record.id}>
            <div className="request-top">
              <span className={`method ${record.method.toLowerCase()}`}>{record.method}</span>
              <strong>{record.status}</strong>
              <small>{record.time}</small>
            </div>
            <p>{record.path}</p>
            <div className="request-meta">
              <span>{record.host}</span>
              <span>{record.size}</span>
              <span>{record.latency}</span>
            </div>
          </article>
        ))}
      </div>
    </aside>
  );
}

function ChatPanel({ current }: { current?: TimelineEvent }) {
  const [draft, setDraft] = useState("");
  const [messages, setMessages] = useState([
    { role: "operator", text: "对图片导入功能做一次受控验证，优先保留证据链，不要破坏数据。" },
    { role: "agent", text: "已接入浏览器会话和 HTTP 捕获。先枚举上传入口，再把可复现证据写入图谱。" },
    { role: "agent", text: "XML 批量导入返回异常栈，正在测试编码绕过与外部实体解析行为。" },
  ]);

  function submit() {
    const text = draft.trim();
    if (!text) return;
    setMessages((items) => [...items, { role: "operator", text }, { role: "agent", text: "收到。下一轮会把请求、证据和推理关系同步写入右侧图谱。" }]);
    setDraft("");
  }

  return (
    <main className="panel chat-panel">
      <div className="panel-header">
        <div>
          <span className="section-kicker">Agent</span>
          <h2>Run Console</h2>
        </div>
        <div className="session-state">
          <CircleDot size={14} />
          autonomous
        </div>
      </div>
      <section className="objective-block">
        <div>
          <LockKeyhole size={16} />
          <span>Authorized target</span>
        </div>
        <strong>{challengeTitle}</strong>
        <p>{challengeSummary}</p>
      </section>
      <section className="messages">
        {messages.map((message, index) => (
          <div className={`message ${message.role}`} key={`${message.role}-${index}`}>
            <span>{message.role === "agent" ? "Agent" : "Operator"}</span>
            <p>{message.text}</p>
          </div>
        ))}
        {current ? (
          <div className="message trace">
            <span>Live trace · {current.time}</span>
            <p>{current.summary}</p>
          </div>
        ) : null}
      </section>
      <div className="tool-strip">
        <button>Scope</button>
        <button>Trace</button>
        <button>Evidence</button>
        <button>Plan</button>
      </div>
      <div className="composer">
        <TerminalSquare size={17} />
        <input
          aria-label="Agent instruction"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") submit();
          }}
          placeholder="Ask the agent to validate, branch, or explain a finding"
          value={draft}
        />
        <button onClick={submit}>
          <Send size={15} />
        </button>
      </div>
    </main>
  );
}

const SpeedButton = memo(function SpeedButton({ value, speed, setSpeed }: { value: number; speed: number; setSpeed: (speed: number) => void }) {
  return (
    <button className={speed === value ? "active" : ""} onClick={() => setSpeed(value)}>
      {value}x
    </button>
  );
});

function GraphPanel({
  cursor,
  current,
  playing,
  setCursor,
  setPlaying,
  setSpeed,
  speed,
  visible,
}: {
  cursor: number;
  current?: TimelineEvent;
  playing: boolean;
  setCursor: (cursor: number) => void;
  setPlaying: (playing: boolean) => void;
  setSpeed: (speed: number) => void;
  speed: number;
  visible: TimelineEvent[];
}) {
  const knowledge = useMemo(() => buildKnowledgeGraph(visible), [visible]);

  return (
    <aside className="panel graph-panel">
      <div className="panel-header graph-header">
        <div>
          <span className="section-kicker">Attack graph</span>
          <h2>Reasoning Chain</h2>
        </div>
        <div className="graph-count">
          <strong>{knowledge.nodes.length}</strong>
          nodes
        </div>
      </div>
      <div className="graph-canvas">
        <ReactFlowProvider>
          <FlowCanvas focusNodeId={knowledge.focusNodeId} nodes={knowledge.nodes} edges={knowledge.edges} />
        </ReactFlowProvider>
      </div>
      <div className="graph-footer">
        <div className="replay-controls">
          <button
            onClick={() => {
              if (playing) setPlaying(false);
              else {
                if (cursor >= events.length) setCursor(0);
                setPlaying(true);
              }
            }}
          >
            {playing ? <Pause size={14} /> : <Play size={14} />}
            {playing ? "Pause" : "Replay"}
          </button>
          <button
            onClick={() => {
              setPlaying(false);
              setCursor(0);
            }}
          >
            <RotateCcw size={14} />
          </button>
          {[1, 2, 4].map((item) => (
            <SpeedButton key={item} value={item} speed={speed} setSpeed={setSpeed} />
          ))}
        </div>
        <input max={events.length} min={0} onChange={(event) => setCursor(Number(event.target.value))} type="range" value={cursor} />
        <div className="current-event">
          <span>{Math.round((cursor / events.length) * 1110)} / 1110</span>
          <strong>{current ? current.summary : "Ready"}</strong>
        </div>
      </div>
    </aside>
  );
}

function Workbench() {
  const [browserOpen, setBrowserOpen] = useState(false);
  const [cursor, setCursor] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(2);
  const visible = events.slice(0, cursor);
  const current = visible[visible.length - 1];
  const activeRequestIndex = Math.min(Math.max(cursor - 3, 0), traffic.length - 1);

  useEffect(() => {
    if (!playing) return;
    if (cursor >= events.length) {
      setPlaying(false);
      return;
    }
    const timer = window.setTimeout(() => setCursor((value) => Math.min(value + 1, events.length)), Math.max(70, 520 / speed));
    return () => window.clearTimeout(timer);
  }, [cursor, playing, speed]);

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span>
            <ShieldCheck size={16} />
          </span>
          <div>
            <strong>BreachWeave Lab</strong>
            <small>authorized agent workspace</small>
          </div>
        </div>
        <nav>
          <button className="active">Run</button>
          <button>Evidence</button>
          <button>Reports</button>
        </nav>
        <div className="run-id">
          <span>run</span>
          <strong>BW-0413-77A</strong>
          <ChevronRight size={14} />
        </div>
      </header>
      <section className="workspace">
        <TrafficPanel activeIndex={activeRequestIndex} browserOpen={browserOpen} onBrowserOpen={() => setBrowserOpen((value) => !value)} />
        <ChatPanel current={current} />
        <GraphPanel
          cursor={cursor}
          current={current}
          playing={playing}
          setCursor={setCursor}
          setPlaying={setPlaying}
          setSpeed={setSpeed}
          speed={speed}
          visible={visible}
        />
      </section>
    </div>
  );
}

export default function App() {
  return <Workbench />;
}
