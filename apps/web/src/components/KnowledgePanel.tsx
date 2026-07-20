import { useStore } from "../store.js";
import { FactsTab } from "./knowledge/FactsTab.js";
import { TasksTab } from "./knowledge/TasksTab.js";
import { TimelineTab } from "./knowledge/TimelineTab.js";
import { McpTab } from "./knowledge/McpTab.js";
import { ObserverTab } from "./knowledge/ObserverTab.js";
import { ReportsTab } from "./knowledge/ReportsTab.js";
import { Database, GitBranch } from "@phosphor-icons/react";
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
  { key: "reports", label: "Reports" },
] as const;

type TabKey = (typeof TABS)[number]["key"];

const TAB_TITLE: Record<TabKey, string> = {
  facts: "Facts",
  tasks: "Tasks",
  timeline: "Timeline",
  mcp: "MCP",
  observer: "Observer",
  reports: "Reports",
};

function TabPanel({ tab }: { tab: TabKey }) {
  if (tab === "facts") return <FactsTab />;
  if (tab === "tasks") return <TasksTab />;
  if (tab === "timeline") return <TimelineTab />;
  if (tab === "mcp") return <McpTab />;
  if (tab === "reports") return <ReportsTab />;
  return <ObserverTab />;
}

function KnowledgeInspector() {
  const { selectedTraffic, selectedFact, selectedAgentEvent } = useStore(useShallow((state) => ({
    selectedTraffic: state.selectedTrafficId
      ? state.traffic.find((entry) => entry.id === state.selectedTrafficId)
        ?? (state.selectedTrafficSnapshot?.id === state.selectedTrafficId ? state.selectedTrafficSnapshot : null)
      : null,
    selectedFact: state.selectedFactId
      ? state.facts.find((fact) => fact.id === state.selectedFactId) ?? null
      : null,
    selectedAgentEvent: state.selectedAgentEvent,
  })));
  if (selectedTraffic) return <TrafficInspector entry={selectedTraffic} />;
  if (selectedFact) return <FindingInspector fact={selectedFact} />;
  if (selectedAgentEvent) return <ToolEventInspector event={selectedAgentEvent} />;
  return null;
}

function KnowledgeTabCounts() {
  const counts = useStore(useShallow((state) => ({
    facts: state.facts.length,
    tasks: state.tasks.length,
    timeline: state.timeline.length,
    mcp: state.mcpTools.length,
    observer: state.warnings.reduce((count, warning) => count + Number(warning.status === "open"), 0),
    reports: state.securityReports.length,
  } satisfies Record<TabKey, number>)));
  return TABS.map((tab) => (
    <TabsTrigger key={tab.key} value={tab.key}>
      {tab.label}
      {counts[tab.key] > 0 && <span className="knowledge-tab-count">{counts[tab.key]}</span>}
    </TabsTrigger>
  ));
}

function KnowledgeOverview() {
  const { activeTab, setActiveTab, setGraphModalOpen } = useStore(useShallow((state) => ({
    activeTab: state.activeTab,
    setActiveTab: state.setActiveTab,
    setGraphModalOpen: state.setGraphModalOpen,
  })));
  const visibleTab: TabKey = activeTab === "graph" ? "facts" : activeTab;
  return (
    <>
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
              <GitBranch size={14} /> Paths
            </Button>
          </div>
      </div>
      <Tabs
        value={visibleTab}
        onValueChange={(v) => setActiveTab(v as TabKey)}
        className="knowledge-tabs"
      >
        <TabsList className="knowledge-tab-list" aria-label="Knowledge views">
          <KnowledgeTabCounts />
        </TabsList>
        <div className="panel-body">
          <TabsContent value={visibleTab} className="knowledge-tab-content">
            <TabPanel tab={visibleTab} />
          </TabsContent>
        </div>
      </Tabs>
    </>
  );
}

export function KnowledgePanel() {
  const inspectorOpen = useStore((state) => Boolean(state.selectedTrafficId || state.selectedFactId || state.selectedAgentEvent));
  return (
    <aside className="panel knowledge-panel">
      {inspectorOpen ? <KnowledgeInspector /> : <KnowledgeOverview />}
    </aside>
  );
}
