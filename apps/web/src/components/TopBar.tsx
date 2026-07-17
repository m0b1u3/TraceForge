import { ArrowsClockwise, Circle, Coins, Gear, Moon, Play, Sun, WifiHigh, WifiSlash } from "@phosphor-icons/react";
import { useStore } from "../store.js";
import { useAppTheme } from "../hooks/useAppTheme.js";
import { CaseLauncher } from "./CaseLauncher.js";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/components/ui/utils";
import { useShallow } from "zustand/react/shallow";

export function getTopBarRunStatus(activeRun: { status: string } | null, agentBusy: boolean): string {
  return activeRun?.status ?? (agentBusy ? "running" : "idle");
}

export function formatTopBarTokenTotal(totalTokens: number): string {
  return `Tokens ${totalTokens.toLocaleString()}`;
}

export function TopBar() {
  const { caseId, activeRun, agentBusy, tokenUsage, connectionStatus, setCase, setSettingsModalOpen } = useStore(useShallow((state) => ({ caseId: state.caseId, activeRun: state.activeRun, agentBusy: state.agentBusy, tokenUsage: state.tokenUsage, connectionStatus: state.connectionStatus, setCase: state.setCase, setSettingsModalOpen: state.setSettingsModalOpen })));
  const runStatus = getTopBarRunStatus(activeRun, agentBusy);
  const openRunLauncher = () => globalThis.dispatchEvent(new CustomEvent("traceforge:new-run"));
  const { theme, toggleTheme } = useAppTheme();

  return (
    <header className="topbar">
      <button type="button" className="brand topbar-brand" onClick={() => setCase(null)} aria-label="Return to TraceForge home">
        <div>
          <strong>TraceForge</strong>
          <small>red-team workbench</small>
        </div>
      </button>
      <nav className="topbar-workspace">
        <button type="button" className="topbar-workspace-label" onClick={() => setCase(null)}>Engagements</button>
        <span className="topbar-workspace-separator" aria-hidden="true">/</span>
        <CaseLauncher variant="bar" />
      </nav>
      <div className="topbar-meta">
        {caseId && (
          <div className="topbar-runtime" aria-label="Runtime status">
            <span className={`runtime-connection is-${connectionStatus}`} role="status" title={`Live sync: ${connectionStatus}`}>
              {connectionStatus === "online" ? <WifiHigh size={13} aria-hidden="true" /> : connectionStatus === "reconnecting" ? <ArrowsClockwise size={13} aria-hidden="true" /> : <WifiSlash size={13} aria-hidden="true" />}
              <span>{connectionStatus === "online" ? "Online" : connectionStatus === "reconnecting" ? "Reconnecting" : "Offline"}</span>
            </span>
            <Badge variant="outline" className={cn("topbar-run-status", runStatus === "running" && "is-running")}>
              <Circle size={7} weight="fill" /> Agent {runStatus}
            </Badge>
            <button
              type="button"
              className="topbar-token-total"
              title="View token usage"
              aria-label="View token usage"
              onClick={() => globalThis.dispatchEvent(new CustomEvent("traceforge:open-token-usage"))}
            >
              <Coins size={14} aria-hidden="true" />
              {formatTopBarTokenTotal(tokenUsage.totalTokens)}
            </button>
          </div>
        )}
        {caseId && (
          <Button className="topbar-run-action" type="button" size="sm" onClick={runStatus === "running" ? () => document.querySelector<HTMLTextAreaElement>(".composer textarea")?.focus() : openRunLauncher}>
            <Play size={14} weight="fill" />
            <span>{runStatus === "running" ? "Steer agent" : "New run"}</span>
          </Button>
        )}
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="topbar-theme-toggle"
          aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
          title={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
          onClick={toggleTheme}
        >
          {theme === "dark" ? <Sun size={15} /> : <Moon size={15} />}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="topbar-settings"
          aria-label="Open settings"
          title="Settings"
          onClick={() => setSettingsModalOpen(true)}
        >
          <Gear size={15} />
        </Button>
      </div>
    </header>
  );
}
