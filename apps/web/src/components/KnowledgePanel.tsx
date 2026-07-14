import { useStore } from "../store.js";
import { FactsTab } from "./knowledge/FactsTab.js";
import { TasksTab } from "./knowledge/TasksTab.js";
import { TimelineTab } from "./knowledge/TimelineTab.js";
import { McpTab } from "./knowledge/McpTab.js";
import { GraphTab } from "./knowledge/GraphTab.js";
import { ObserverTab } from "./knowledge/ObserverTab.js";
import { ArrowsOut, Database } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from "@/components/ui/tabs";

const TABS = [
  { key: "facts", label: "Facts" },
  { key: "tasks", label: "Tasks" },
  { key: "timeline", label: "Timeline" },
  { key: "mcp", label: "MCP" },
  { key: "graph", label: "Graph" },
  { key: "observer", label: "Observer" },
] as const;

type TabKey = (typeof TABS)[number]["key"];

const TAB_TITLE: Record<TabKey, string> = {
  facts: "Facts",
  tasks: "Tasks",
  timeline: "Timeline",
  mcp: "MCP",
  graph: "Graph",
  observer: "Observer",
};

function TabPanel({ tab }: { tab: TabKey }) {
  if (tab === "facts") return <FactsTab />;
  if (tab === "tasks") return <TasksTab />;
  if (tab === "timeline") return <TimelineTab />;
  if (tab === "mcp") return <McpTab />;
  if (tab === "graph") return <GraphTab />;
  return <ObserverTab />;
}

export function KnowledgePanel() {
  const { activeTab, setActiveTab, setGraphModalOpen, facts, tasks, timeline, mcpTools, warnings } = useStore();
  const isGraph = activeTab === "graph";
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
          <h2>{TAB_TITLE[activeTab]}</h2>
        </div>
        {isGraph && (
          <div className="panel-header-actions">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setGraphModalOpen(true)}
            >
              <ArrowsOut size={14} /> Expand
            </Button>
          </div>
        )}
      </div>
      <Tabs
        value={activeTab}
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
