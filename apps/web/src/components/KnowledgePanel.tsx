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

export function KnowledgePanel() {
  const { activeTab, setActiveTab } = useStore();
  return (
    <div className="tf-panel" style={{ height: "100%" }}>
      <div className="tf-tabs">
        {TABS.map((t) => (
          <button key={t.key} className={`tf-tab ${activeTab === t.key ? "active" : ""}`} onClick={() => setActiveTab(t.key)}>{t.label}</button>
        ))}
      </div>
      <div className="tf-panel-body">
        {activeTab === "facts" && <FactsTab />}
        {activeTab === "tasks" && <TasksTab />}
        {activeTab === "timeline" && <TimelineTab />}
        {activeTab === "mcp" && <McpTab />}
        {activeTab === "graph" && <GraphTab />}
        {activeTab === "observer" && <ObserverTab />}
      </div>
    </div>
  );
}
