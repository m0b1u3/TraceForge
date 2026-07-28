import { ArrowsClockwise, Circle, Coins, DotsThree, Eye, FileText, Gear, GitBranch, Lightbulb, Moon, Play, Plugs, Sun, WifiHigh, WifiSlash } from "@phosphor-icons/react";
import { useStore } from "../store.js";
import { useAppTheme } from "../hooks/useAppTheme.js";
import { CaseLauncher } from "./CaseLauncher.js";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { cn } from "@/components/ui/utils";
import { useShallow } from "zustand/react/shallow";
import { BrandMark } from "./design-system/BrandMark.js";

export function getTopBarRunStatus(activeRun: { status: string } | null, agentBusy: boolean): string {
  return activeRun?.status ?? (agentBusy ? "running" : "idle");
}

export function formatTopBarTokenTotal(totalTokens: number): string {
  return `Tokens ${totalTokens.toLocaleString()}`;
}

const KNOWLEDGE_DIALOGS = [
  { key: "hypotheses", label: "Ideas", icon: Lightbulb },
  { key: "mcp", label: "MCP", icon: Plugs },
  { key: "observer", label: "Observer", icon: Eye },
  { key: "reports", label: "Reports", icon: FileText },
] as const;

export function TopBar() {
  const { caseId, activeRun, agentBusy, tokenUsage, connectionStatus, setCase, setSettingsModalOpen, setGraphModalOpen, knowledgeDialog, setKnowledgeDialog } = useStore(useShallow((state) => ({ caseId: state.caseId, activeRun: state.activeRun, agentBusy: state.agentBusy, tokenUsage: state.tokenUsage, connectionStatus: state.connectionStatus, setCase: state.setCase, setSettingsModalOpen: state.setSettingsModalOpen, setGraphModalOpen: state.setGraphModalOpen, knowledgeDialog: state.knowledgeDialog, setKnowledgeDialog: state.setKnowledgeDialog })));
  const runStatus = getTopBarRunStatus(activeRun, agentBusy);
  const openRunLauncher = () => globalThis.dispatchEvent(new CustomEvent("traceforge:new-run"));
  const { theme, toggleTheme } = useAppTheme();

  return (
    <header className="topbar">
      <button type="button" className="brand topbar-brand" onClick={() => setCase(null)} aria-label="Return to TraceForge home">
        <BrandMark size="sm" />
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
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="topbar-more"
                aria-label="More workspace views"
                title="Workspace views"
                data-active={knowledgeDialog ? "true" : undefined}
              >
                <DotsThree size={16} weight="bold" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => setGraphModalOpen(true)}>
                <GitBranch size={14} />
                <span>Attack paths</span>
              </DropdownMenuItem>
              {KNOWLEDGE_DIALOGS.map(({ key, label, icon: Icon }) => (
                <DropdownMenuItem key={key} onSelect={() => setKnowledgeDialog(knowledgeDialog === key ? null : key)}>
                  <Icon size={14} />
                  <span>{label}</span>
                  {knowledgeDialog === key ? <i className="topbar-more-active" aria-hidden="true" /> : null}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
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
