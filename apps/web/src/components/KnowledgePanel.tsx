import { useStore } from "../store.js";
import { FactsTab } from "./knowledge/FactsTab.js";
import { TasksTab } from "./knowledge/TasksTab.js";
import { TimelineTab } from "./knowledge/TimelineTab.js";
import { McpTab } from "./knowledge/McpTab.js";
import { ObserverTab } from "./knowledge/ObserverTab.js";
import { ReportsTab } from "./knowledge/ReportsTab.js";
import { HypothesesTab } from "./knowledge/HypothesesTab.js";
import { Database } from "@phosphor-icons/react";
import { TrafficInspector } from "./inspector/TrafficInspector.js";
import { FindingInspector, ToolEventInspector } from "./inspector/EvidenceInspector.js";
import { TaskInspector, TimelineEventInspector } from "./inspector/GraphInspectors.js";
import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from "@/components/ui/tabs";
import { useShallow } from "zustand/react/shallow";

const TABS = [
  { key: "facts", label: "Facts" },
  { key: "hypotheses", label: "Ideas" },
  { key: "tasks", label: "Tasks" },
  { key: "timeline", label: "Timeline" },
  { key: "mcp", label: "MCP" },
  { key: "observer", label: "Observer" },
  { key: "reports", label: "Reports" },
] as const;

type TabKey = (typeof TABS)[number]["key"];

const TAB_TITLE: Record<TabKey, string> = {
  facts: "Facts",
  hypotheses: "Hypotheses",
  tasks: "Tasks",
  timeline: "Timeline",
  mcp: "MCP",
  observer: "Observer",
  reports: "Reports",
};

function TabPanel({ tab }: { tab: TabKey }) {
  if (tab === "facts") return <FactsTab />;
  if (tab === "hypotheses") return <HypothesesTab />;
  if (tab === "tasks") return <TasksTab />;
  if (tab === "timeline") return <TimelineTab />;
  if (tab === "mcp") return <McpTab />;
  if (tab === "reports") return <ReportsTab />;
  return <ObserverTab />;
}

function KnowledgeInspector() {
  const { selectedTraffic, selectedFact, selectedTask, selectedTimelineEntry, selectedAgentEvent, knowledgeTarget, clearKnowledgeTarget } = useStore(useShallow((state) => ({
    selectedTraffic: state.selectedTrafficId
      ? state.traffic.find((entry) => entry.id === state.selectedTrafficId)
        ?? (state.selectedTrafficSnapshot?.id === state.selectedTrafficId ? state.selectedTrafficSnapshot : null)
      : null,
    selectedFact: state.selectedFactId
      ? state.facts.find((fact) => fact.id === state.selectedFactId) ?? null
      : null,
    selectedTask: state.selectedTaskId
      ? state.tasks.find((task) => task.id === state.selectedTaskId) ?? null
      : null,
    selectedTimelineEntry: state.selectedTimelineNodeId
      ? state.timeline.find((entry) => entry.id === state.selectedTimelineNodeId) ?? null
      : null,
    selectedAgentEvent: state.selectedAgentEvent,
    knowledgeTarget: state.knowledgeTarget,
    clearKnowledgeTarget: state.clearKnowledgeTarget,
  })));
  if (selectedTraffic) return <TrafficInspector entry={selectedTraffic} />;
  if (selectedFact) return <FindingInspector fact={selectedFact} targetRequestId={knowledgeTarget?.kind === "finding" && knowledgeTarget.id === selectedFact.id ? knowledgeTarget.requestId : null} onTargetHandled={clearKnowledgeTarget} />;
  if (selectedTask) return <TaskInspector task={selectedTask} />;
  if (selectedTimelineEntry) return <TimelineEventInspector entry={selectedTimelineEntry} />;
  if (selectedAgentEvent) return <ToolEventInspector event={selectedAgentEvent} />;
  return null;
}

function KnowledgeTabCounts() {
  const counts = useStore(useShallow((state) => ({
    facts: state.facts.length,
    hypotheses: state.hypotheses.length,
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
  const { activeTab, setActiveTab } = useStore(useShallow((state) => ({
    activeTab: state.activeTab,
    setActiveTab: state.setActiveTab,
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
  const inspectorOpen = useStore((state) => Boolean(state.selectedTrafficId || state.selectedFactId || state.selectedTaskId || state.selectedTimelineNodeId || state.selectedAgentEvent));
  return (
    <aside className="panel knowledge-panel">
      {inspectorOpen ? <KnowledgeInspector /> : <KnowledgeOverview />}
    </aside>
  );
}
