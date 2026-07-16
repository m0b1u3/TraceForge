import { useStore } from "../store.js";
import { FactsTab } from "./knowledge/FactsTab.js";
import { TasksTab } from "./knowledge/TasksTab.js";
import { TimelineTab } from "./knowledge/TimelineTab.js";
import { McpTab } from "./knowledge/McpTab.js";
import { ObserverTab } from "./knowledge/ObserverTab.js";
import { ArrowsOut, Database } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { TrafficInspector } from "./inspector/TrafficInspector.js";
import { FindingInspector, ToolEventInspector } from "./inspector/EvidenceInspector.js";
import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from "@/components/ui/tabs";
import { useShallow } from "zustand/react/shallow";

const TABS = [
  { key: "facts", label: "Facts" },
  { key: "tasks", label: "Tasks" },
  { key: "timeline", label: "Timeline" },
  { key: "mcp", label: "MCP" },
  { key: "observer", label: "Observer" },
] as const;

type TabKey = (typeof TABS)[number]["key"];

const TAB_TITLE: Record<TabKey, string> = {
  facts: "Facts",
  tasks: "Tasks",
  timeline: "Timeline",
  mcp: "MCP",
  observer: "Observer",
};

function TabPanel({ tab }: { tab: TabKey }) {
  if (tab === "facts") return <FactsTab />;
  if (tab === "tasks") return <TasksTab />;
  if (tab === "timeline") return <TimelineTab />;
  if (tab === "mcp") return <McpTab />;
  return <ObserverTab />;
}

export function KnowledgePanel() {
  const { activeTab, setActiveTab, setGraphModalOpen, facts, tasks, timeline, mcpTools, warnings, traffic, selectedTrafficId, selectedFactId, selectedAgentEvent } = useStore(useShallow((state) => ({ activeTab: state.activeTab, setActiveTab: state.setActiveTab, setGraphModalOpen: state.setGraphModalOpen, facts: state.facts, tasks: state.tasks, timeline: state.timeline, mcpTools: state.mcpTools, warnings: state.warnings, traffic: state.traffic, selectedTrafficId: state.selectedTrafficId, selectedFactId: state.selectedFactId, selectedAgentEvent: state.selectedAgentEvent })));
  const selectedTraffic = selectedTrafficId ? traffic.find((entry) => entry.id === selectedTrafficId) ?? null : null;
  if (selectedTraffic) return <aside className="panel knowledge-panel"><TrafficInspector entry={selectedTraffic} /></aside>;
  const selectedFact = selectedFactId ? facts.find((fact) => fact.id === selectedFactId) ?? null : null;
  if (selectedFact) return <aside className="panel knowledge-panel"><FindingInspector fact={selectedFact} /></aside>;
  if (selectedAgentEvent) return <aside className="panel knowledge-panel"><ToolEventInspector event={selectedAgentEvent} /></aside>;
  const visibleTab = activeTab === "graph" ? "facts" : activeTab;
  const counts: Partial<Record<TabKey, number>> = {
    facts: facts.length,
    tasks: tasks.length,
    timeline: timeline.length,
    mcp: mcpTools.length,
    observer: warnings.filter((warning) => warning.status === "open").length,
  };
  return (
    <aside className="panel knowledge-panel">
      <div className="panel-header">
        <div className="panel-heading">
          <Database size={16} weight="duotone" aria-hidden="true" />
          <span className="section-kicker">Knowledge</span>
          <h2>{TAB_TITLE[visibleTab]}</h2>
        </div>
          <div className="panel-header-actions">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setGraphModalOpen(true)}
            >
              <ArrowsOut size={14} /> Graph
            </Button>
          </div>
      </div>
      <Tabs
        value={visibleTab}
        onValueChange={(v) => setActiveTab(v as TabKey)}
        className="knowledge-tabs"
      >
        <TabsList className="knowledge-tab-list" aria-label="Knowledge views">
          {TABS.map((t) => (
            <TabsTrigger key={t.key} value={t.key}>
              {t.label}
              {(counts[t.key] ?? 0) > 0 && <span className="knowledge-tab-count">{counts[t.key]}</span>}
            </TabsTrigger>
          ))}
        </TabsList>
        <div className="panel-body">
          {TABS.map((t) => (
            <TabsContent
              key={t.key}
              value={t.key}
              className={`knowledge-tab-content ${t.key === "graph" ? "is-graph" : ""}`}
            >
              <TabPanel tab={t.key} />
            </TabsContent>
          ))}
        </div>
      </Tabs>
    </aside>
  );
}
