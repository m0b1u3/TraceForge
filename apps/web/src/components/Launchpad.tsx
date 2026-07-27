import { useEffect, useMemo, useState } from "react";
import type { CaseSummary } from "@traceforge/shared";
import {
  Archive, Browser, CaretRight, Circle, CircleNotch, DotsThree, FunnelSimple,
  Gear, MagnifyingGlass, Moon, Pause, Play, Plus, Robot, Sun, Wrench,
} from "@phosphor-icons/react";
import { useShallow } from "zustand/react/shallow";
import { createCase, getLlmConfig, listCases, listCaseSummaries, listMcpTools, startBrowser, updateCase } from "../api.js";
import { useAppTheme } from "../hooks/useAppTheme.js";
import { useStore } from "../store.js";
import { Button } from "./ui/button.js";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "./ui/dropdown-menu.js";

const statusPriority: Record<CaseSummary["runStatus"], number> = { waiting: 0, running: 1, failed: 2, idle: 3, completed: 4 };

export function sortCaseSummaries(items: CaseSummary[]): CaseSummary[] {
  return [...items].sort((a, b) => {
    const aPriority = a.status === "paused" ? 2 : statusPriority[a.runStatus];
    const bPriority = b.status === "paused" ? 2 : statusPriority[b.runStatus];
    const status = aPriority - bPriority;
    return status || b.lastActivityAt.localeCompare(a.lastActivityAt);
  });
}

export function filterCaseSummaries(items: CaseSummary[], query: string): CaseSummary[] {
  const normalizedQuery = query.trim().toLowerCase();
  return sortCaseSummaries(items).filter((item) => item.status !== "archived" && (!normalizedQuery || `${item.name} ${item.target ?? ""}`.toLowerCase().includes(normalizedQuery)));
}

export function normalizeTarget(input: string): string | null {
  const value = input.trim();
  if (!value || /\s/.test(value)) return null;
  try {
    return new URL(value.includes("://") ? value : `https://${value}`).host || null;
  } catch {
    return null;
  }
}

function formatRelativeTime(value: string): string {
  const elapsed = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(elapsed) || elapsed < 0) return "just now";
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return days < 30 ? `${days}d ago` : new Date(value).toLocaleDateString();
}

function BrandMark() {
  return <svg className="launchpad-mark" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 3h18v5H9v13H3V3Z" /><path d="M11 10h10v5h-5v6h-5V10Z" /></svg>;
}

function RunStatus({ summary }: { summary: CaseSummary }) {
  const label = summary.pendingApproval ? "Waiting approval" : summary.runStatus === "running" ? "In progress" : summary.runStatus === "failed" ? "Needs attention" : summary.status === "paused" ? "Paused" : summary.runStatus === "completed" ? "Completed" : "Idle";
  return <span className="launchpad-status" data-status={summary.pendingApproval ? "waiting" : summary.status === "paused" ? "paused" : summary.runStatus}><Circle size={7} weight="fill" />{label}</span>;
}

function FindingSummary({ summary }: { summary: CaseSummary }) {
  const entries = (["critical", "high", "medium", "low"] as const).filter((severity) => summary.severityCounts[severity] > 0);
  if (!entries.length) return <span className="launchpad-zero">{summary.findingCount} findings</span>;
  return <span className="launchpad-findings" aria-label={`${summary.findingCount} findings`}>{entries.map((severity) => <span key={severity} data-severity={severity}><i />{summary.severityCounts[severity]}</span>)}</span>;
}

export function Launchpad() {
  const { enterCase, setCases, deleteCase, showToast, setSettingsModalOpen, setActiveTab } = useStore(useShallow((state) => ({ enterCase: state.enterCase, setCases: state.setCases, deleteCase: state.deleteCase, showToast: state.showToast, setSettingsModalOpen: state.setSettingsModalOpen, setActiveTab: state.setActiveTab })));
  const [summaries, setSummaries] = useState<CaseSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [target, setTarget] = useState("");
  const [emptyName, setEmptyName] = useState("");
  const [showEmpty, setShowEmpty] = useState(false);
  const [creating, setCreating] = useState(false);
  const { theme, toggleTheme } = useAppTheme();
  const [readiness, setReadiness] = useState({ llm: false, mcp: 0 });

  const load = async () => {
    const [summaryList, caseList] = await Promise.all([listCaseSummaries(), listCases()]);
    setSummaries(summaryList);
    setCases(caseList);
  };

  useEffect(() => {
    let active = true;
    void Promise.all([listCaseSummaries(), listCases(), getLlmConfig().catch(() => null), listMcpTools().catch(() => [])])
      .then(([summaryList, caseList, config, tools]) => {
        if (!active) return;
        setSummaries(summaryList);
        setCases(caseList);
        setReadiness({ llm: Boolean(config?.model && config.apiKeyMasked), mcp: tools.length });
      })
      .catch((error) => { if (active) showToast((error as Error).message, "error"); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [setCases, showToast]);

  const visible = useMemo(() => filterCaseSummaries(summaries, query), [query, summaries]);
  const last = sortCaseSummaries(summaries.filter((item) => item.status !== "archived"))[0];
  const validTarget = normalizeTarget(target);

  const openCase = async (id: string) => {
    if (busyId) return;
    setBusyId(id);
    try { await enterCase(id); } catch (error) { showToast((error as Error).message, "error"); setBusyId(null); }
  };

  const create = async (name: string, hosts: string[]) => {
    if (creating) return;
    setCreating(true);
    try {
      const created = await createCase(name, hosts);
      await load();
      await enterCase(created.id);
    } catch (error) {
      showToast((error as Error).message, "error");
      setCreating(false);
    }
  };

  const mutate = async (summary: CaseSummary, patch: { name?: string; status?: "active" | "paused" | "archived" }) => {
    setBusyId(summary.id);
    try { await updateCase(summary.id, patch); await load(); showToast("Case updated", "success"); } catch (error) { showToast((error as Error).message, "error"); } finally { setBusyId(null); }
  };

  const remove = async (summary: CaseSummary) => {
    if (!window.confirm(`Delete case "${summary.name}" and all captured evidence? This cannot be undone.`)) return;
    setBusyId(summary.id);
    try { await deleteCase(summary.id); await load(); } catch (error) { showToast((error as Error).message, "error"); } finally { setBusyId(null); }
  };

  const openBrowser = async () => {
    if (!last || busyId) { showToast("Create an investigation before launching the shared browser", "info"); return; }
    setBusyId(last.id);
    try { await enterCase(last.id); await startBrowser(last.id); } catch (error) { showToast((error as Error).message, "error"); setBusyId(null); }
  };
  const openMcp = async () => {
    if (!last || busyId) { showToast("Create an investigation to inspect MCP tools", "info"); return; }
    setActiveTab("mcp");
    await openCase(last.id);
  };

  return <div className="launchpad-shell">
    <header className="launchpad-topbar">
      <div className="launchpad-brand"><BrandMark /><span><strong>TraceForge</strong><small>red-team workbench</small></span></div>
      <div className="launchpad-top-actions"><span className="launchpad-agent"><Circle size={7} weight="fill" />Agent idle</span><Button variant="ghost" size="icon-sm" aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`} onClick={toggleTheme}>{theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}</Button><Button variant="ghost" size="icon-sm" aria-label="Open settings" onClick={() => setSettingsModalOpen(true)}><Gear size={16} /></Button></div>
    </header>
    <main className="launchpad-main">
      <section className="launchpad-engagements" aria-labelledby="engagements-heading">
        <header className="launchpad-section-head"><div><h1 id="engagements-heading">Recent engagements</h1><p>Resume an investigation or review captured evidence.</p></div><div className="launchpad-tools"><label><MagnifyingGlass size={15} /><span className="sr-only">Search engagements</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search" /></label><Button variant="outline" size="icon-sm" aria-label="Filter engagements" disabled><FunnelSimple size={15} /></Button></div></header>
        <div className="launchpad-list" role="list" aria-label="Recent engagements">
          {loading && <div className="launchpad-loading" role="status"><CircleNotch className="tf-spin" size={18} />Loading engagements…</div>}
          {!loading && visible.length === 0 && <div className="launchpad-empty"><strong>{query ? "No matching engagements" : "No engagements yet"}</strong><span>{query ? "Try a different case name or target." : "Start with a target to create the first investigation."}</span></div>}
          {visible.map((summary, index) => <div className="launchpad-row" role="listitem" data-selected={index === 0 || undefined} key={summary.id}>
            <button className="launchpad-row-main" type="button" onClick={() => void openCase(summary.id)} disabled={Boolean(busyId)}>
              <span className="launchpad-case-name"><strong>{summary.name}</strong>{summary.target && summary.target !== summary.name ? <small>{summary.target}</small> : null}</span>
              <span className="launchpad-row-meta"><RunStatus summary={summary} /><i aria-hidden="true" /><span className="launchpad-number">{summary.trafficCount.toLocaleString()} requests</span><i aria-hidden="true" /><FindingSummary summary={summary} /><i aria-hidden="true" /><span className="launchpad-time">{formatRelativeTime(summary.lastActivityAt)}</span></span>
            </button>
            <span className="launchpad-row-actions">{busyId === summary.id ? <CircleNotch className="tf-spin" size={15} /> : <DropdownMenu><DropdownMenuTrigger asChild><button type="button" aria-label={`Actions for ${summary.name}`}><DotsThree size={17} weight="bold" /></button></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuItem onSelect={() => { const name = window.prompt("Rename case", summary.name); if (name?.trim()) void mutate(summary, { name }); }}>Rename</DropdownMenuItem><DropdownMenuItem onSelect={() => void mutate(summary, { status: summary.status === "paused" ? "active" : "paused" })}>{summary.status === "paused" ? <Play size={14} /> : <Pause size={14} />}{summary.status === "paused" ? "Resume" : "Pause"}</DropdownMenuItem><DropdownMenuItem onSelect={() => void mutate(summary, { status: "archived" })}><Archive size={14} />Archive</DropdownMenuItem><DropdownMenuItem className="text-destructive focus:text-destructive" onSelect={() => void remove(summary)}>Delete case</DropdownMenuItem></DropdownMenuContent></DropdownMenu>}</span>
            <CaretRight size={15} className="launchpad-row-caret" aria-hidden="true" />
          </div>)}
        </div>
        {!loading && visible.length > 0 && <footer className="launchpad-count">{visible.length} engagement{visible.length === 1 ? "" : "s"}</footer>}
      </section>
      <aside className="launchpad-start" aria-labelledby="new-investigation-heading">
        <section className="launchpad-create"><h2 id="new-investigation-heading">Start with a target</h2><p>Set the initial authorized host. You review scope before the Agent runs.</p><label className="launchpad-target"><span>Target</span><input value={target} onChange={(event) => setTarget(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && validTarget) void create(validTarget, [validTarget]); }} placeholder="domain, IP, or application URL" aria-invalid={Boolean(target && !validTarget)} /></label><Button className="launchpad-create-primary" disabled={!validTarget || creating} onClick={() => validTarget && void create(validTarget, [validTarget])}>{creating ? <CircleNotch className="tf-spin" size={15} /> : <Plus size={15} weight="bold" />}Create investigation</Button>
          {!showEmpty ? <button className="launchpad-empty-action" type="button" onClick={() => setShowEmpty(true)}>Create empty case</button> : <div className="launchpad-empty-form"><input autoFocus value={emptyName} onChange={(event) => setEmptyName(event.target.value)} placeholder="Case name" onKeyDown={(event) => { if (event.key === "Escape") setShowEmpty(false); if (event.key === "Enter" && emptyName.trim()) void create(emptyName.trim(), []); }} /><Button size="sm" disabled={!emptyName.trim() || creating} onClick={() => void create(emptyName.trim(), [])}>Create</Button></div>}
        </section>
        <section className="launchpad-readiness"><h3>Environment</h3><button type="button" onClick={() => void openBrowser()}><Browser size={16} /><span><strong>Shared browser</strong><small>Available</small></span><i data-ready="true" /><CaretRight size={13} /></button><button type="button" onClick={() => setSettingsModalOpen(true)}><Robot size={16} /><span><strong>LLM provider</strong><small>{readiness.llm ? "Configured" : "Setup required"}</small></span><i data-ready={readiness.llm} /><CaretRight size={13} /></button><button type="button" onClick={() => void openMcp()}><Wrench size={16} /><span><strong>MCP tools</strong><small>{readiness.mcp} connected</small></span><i data-ready={readiness.mcp > 0} /><CaretRight size={13} /></button></section>
        {last && <button className="launchpad-resume" type="button" onClick={() => void openCase(last.id)} disabled={Boolean(busyId)}><span><small>Continue working</small><strong>{last.name}</strong><em>Last activity {formatRelativeTime(last.lastActivityAt)}</em></span><span>Resume <CaretRight size={13} /></span></button>}
      </aside>
    </main>
  </div>;
}
