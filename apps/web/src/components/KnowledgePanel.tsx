import { useStore } from "../store.js";
import { FactsTab } from "./knowledge/FactsTab.js";
import { TasksTab } from "./knowledge/TasksTab.js";
import { TimelineTab } from "./knowledge/TimelineTab.js";
import { McpTab } from "./knowledge/McpTab.js";
import { GraphTab } from "./knowledge/GraphTab.js";
import { ObserverTab } from "./knowledge/ObserverTab.js";

const TABS = [
  { key: "facts", label: "Facts" }, { key: "tasks", label: "Tasks" },
  { key: "timeline", label: "Timeline" }, { key: "mcp", label: "MCP" },
  { key: "graph", label: "Graph" },
  { key: "observer", label: "Observer" },
] as const;

const TAB_TITLE: Record<string, string> = {
  facts: "Facts", tasks: "Tasks", timeline: "Timeline", mcp: "MCP 工具", graph: "证据图谱", observer: "Observer 监督",
};

export function KnowledgePanel() {
  const { activeTab, setActiveTab } = useStore();
  const isGraph = activeTab === "graph";
  return (
    <aside className="panel" style={{ display: "flex", flexDirection: "column" }}>
      <div className="panel-header"><div><span className="section-kicker">Knowledge</span><h2>{TAB_TITLE[activeTab]}</h2></div></div>
      <div className="tf-tabs">
        {TABS.map((t) => (
          <button key={t.key} className={`tf-tab ${activeTab === t.key ? "active" : ""}`} onClick={() => setActiveTab(t.key)}>{t.label}</button>
        ))}
      </div>
      <div className="graph-canvas" style={{ overflow: isGraph ? "hidden" : "auto", padding: isGraph ? 0 : "10px 14px" }}>
        {activeTab === "facts" && <FactsTab />}
        {activeTab === "tasks" && <TasksTab />}
        {activeTab === "timeline" && <TimelineTab />}
        {activeTab === "mcp" && <McpTab />}
        {isGraph && <GraphTab />}
        {activeTab === "observer" && <ObserverTab />}
      </div>
    </aside>
  );
}
