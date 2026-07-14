import { Circle, Coins, Gear, Moon, Play, Sun } from "@phosphor-icons/react";
import { useState } from "react";
import { useStore } from "../store.js";
import { getStoredTheme, persistTheme, type AppTheme } from "../lib/theme.js";
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
  const { caseId, activeRun, agentBusy, tokenUsage, setSettingsModalOpen } = useStore();
  const runStatus = getTopBarRunStatus(activeRun, agentBusy);
  const focusComposer = () => document.querySelector<HTMLTextAreaElement>(".composer textarea")?.focus();
  const [theme, setTheme] = useState<AppTheme>(() => getStoredTheme());
  const toggleTheme = () => {
    const nextTheme = theme === "dark" ? "light" : "dark";
    persistTheme(nextTheme);
    setTheme(nextTheme);
  };

  return (
    <header className="topbar">
      <div className="brand topbar-brand">
        <div>
          <strong>TraceForge</strong>
          <small>red-team workbench</small>
        </div>
      </div>
      <nav className="topbar-workspace">
        <span className="topbar-workspace-label">Engagements</span>
        <span className="topbar-workspace-separator" aria-hidden="true">/</span>
        <CaseLauncher variant="bar" />
      </nav>
      <div className="topbar-meta">
        {caseId && (
          <div className="topbar-runtime" aria-label="Runtime status">
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
          <Button className="topbar-run-action" type="button" size="sm" onClick={focusComposer}>
            <Play size={14} weight="fill" />
            <span>{runStatus === "running" ? "Steer agent" : "Run autonomous"}</span>
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
