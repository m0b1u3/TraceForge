import { ShieldCheck } from "@phosphor-icons/react";
import { useStore } from "../store.js";
import { CaseLauncher } from "./CaseLauncher.js";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/components/ui/utils";

export function getTopBarRunStatus(activeRun: { status: string } | null, agentBusy: boolean): string {
  return activeRun?.status ?? (agentBusy ? "running" : "idle");
}

export function formatTopBarTokenTotal(totalTokens: number): string {
  return `Tokens ${totalTokens.toLocaleString()}`;
}

export function TopBar() {
  const { caseId, browserController, browserUrl, activeRun, agentBusy, tokenUsage, setSettingsModalOpen } = useStore();
  const controlLabel = browserController === "human" ? "human" : browserController === "llm" ? "llm" : "idle";
  const runStatus = getTopBarRunStatus(activeRun, agentBusy);

  return (
    <header className="topbar">
      <div className="flex items-center gap-2.5">
        <span className="grid h-7 w-7 place-items-center rounded-lg border bg-card text-foreground">
          <ShieldCheck size={16} />
        </span>
        <div className="flex flex-col">
          <strong className="text-sm font-bold text-foreground">TraceForge</strong>
          <small className="text-xs text-muted-foreground">red-team workbench</small>
        </div>
      </div>
      <nav>
        <CaseLauncher variant="bar" />
      </nav>
      <div className="topbar-meta">
        {caseId && (
          <>
            <Badge
              variant="outline"
              className={cn(
                "gap-1.5",
                browserController === "human" &&
                  "border-amber-500/30 bg-amber-500/10 text-amber-400 hover:bg-amber-500/20",
                browserController === "llm" &&
                  "border-cyan-500/30 bg-cyan-500/10 text-cyan-400 hover:bg-cyan-500/20"
              )}
            >
              <ShieldCheck size={13} weight="fill" />
              {controlLabel}
              {browserUrl && (
                <span className="browser-url text-muted-foreground">· {browserUrl}</span>
              )}
            </Badge>
            <Badge variant="outline" className="topbar-run-status">Run {runStatus}</Badge>
            <Badge variant="outline" className="topbar-token-total" title="Persisted cumulative LLM token usage">
              {formatTopBarTokenTotal(tokenUsage.totalTokens)}
            </Badge>
          </>
        )}
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setSettingsModalOpen(true)}
        >
          Settings
        </Button>
      </div>
    </header>
  );
}
