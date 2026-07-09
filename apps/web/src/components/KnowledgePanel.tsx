import { useStore } from "../store.js";
import { FactsTab } from "./knowledge/FactsTab.js";
import { TasksTab } from "./knowledge/TasksTab.js";
import { TimelineTab } from "./knowledge/TimelineTab.js";
import { McpTab } from "./knowledge/McpTab.js";
import { GraphTab } from "./knowledge/GraphTab.js";
import { ObserverTab } from "./knowledge/ObserverTab.js";
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
  const { activeTab, setActiveTab, setGraphModalOpen } = useStore();
  const isGraph = activeTab === "graph";
  return (
    <aside className="panel">
      <div className="panel-header">
        <div>
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
              Expand
            </Button>
          </div>
        )}
      </div>
      <Tabs
        value={activeTab}
        onValueChange={(v) => setActiveTab(v as TabKey)}
        className="flex min-h-0 flex-1 flex-col"
      >
        <TabsList className="m-3 mb-0 w-auto justify-start">
          {TABS.map((t) => (
            <TabsTrigger key={t.key} value={t.key}>
              {t.label}
            </TabsTrigger>
          ))}
        </TabsList>
        <div className="panel-body">
          {TABS.map((t) => (
            <TabsContent
              key={t.key}
              value={t.key}
              className="min-h-0 flex-1 data-[state=inactive]:hidden"
            >
              <TabPanel tab={t.key} />
            </TabsContent>
          ))}
        </div>
      </Tabs>
    </aside>
  );
}
