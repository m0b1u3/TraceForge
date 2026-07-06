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
  facts: "Facts", tasks: "Tasks", timeline: "Timeline", mcp: "MCP", graph: "Graph", observer: "Observer",
};

export function KnowledgePanel() {
  const { activeTab, setActiveTab, setGraphModalOpen } = useStore();
  const isGraph = activeTab === "graph";
  const toggleExpand = () => setGraphModalOpen(true);
  return (
    <aside className="panel">
      <div className="panel-header">
        <div>
          <span className="section-kicker">Knowledge</span>
          <h2>{TAB_TITLE[activeTab]}</h2>
        </div>
        {isGraph && (
          <div className="panel-header-actions">
            <button className="tf-btn-ghost" onClick={toggleExpand}>Expand</button>
          </div>
        )}
      </div>
      <div className="tf-tabs">
        {TABS.map((t) => (
          <button key={t.key} className={`tf-tab ${activeTab === t.key ? "active" : ""}`} onClick={() => setActiveTab(t.key)}>{t.label}</button>
        ))}
      </div>
      <div className="panel-body">
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
