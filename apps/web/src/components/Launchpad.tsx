import { useEffect, useMemo, useState } from "react";
import { Circle, CircleNotch, Gear, MagnifyingGlass, Plus, Trash } from "@phosphor-icons/react";
import type { CaseSummary } from "@traceforge/shared";
import { useShallow } from "zustand/react/shallow";
import { createCase, listCases, listCaseSummaries } from "../api.js";
import { useStore } from "../store.js";
import { Button } from "./ui/button.js";
import { BrandMark } from "./design-system/BrandMark.js";

export function normalizeTarget(input: string): string | null {
  const value = input.trim();
  if (!value || /\s/.test(value)) return null;
  try { return new URL(value.includes("://") ? value : `https://${value}`).host || null; }
  catch { return null; }
}

export function Launchpad() {
  const { setCases, enterCase, removeCase, showToast, openSettings } = useStore(useShallow((state) => ({
    setCases: state.setCases,
    enterCase: state.enterCase,
    removeCase: state.deleteCase,
    showToast: state.showToast,
    openSettings: () => state.setSettingsModalOpen(true),
  })));
  const [summaries, setSummaries] = useState<CaseSummary[]>([]);
  const [query, setQuery] = useState("");
  const [target, setTarget] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  const load = async () => {
    const [summaryList, caseList] = await Promise.all([listCaseSummaries(), listCases()]);
    setSummaries(summaryList);
    setCases(caseList);
  };
  useEffect(() => { void load().catch((error) => showToast((error as Error).message, "error")).finally(() => setLoading(false)); }, []);
  const visible = useMemo(() => summaries.filter((entry) => entry.status !== "archived" && `${entry.name} ${entry.target ?? ""}`.toLowerCase().includes(query.trim().toLowerCase())), [query, summaries]);
  const normalizedTarget = normalizeTarget(target);

  const create = async () => {
    if (!normalizedTarget) return;
    setBusy("create");
    try {
      const created = await createCase(normalizedTarget, [normalizedTarget]);
      await load();
      await enterCase(created.id);
    } catch (error) { showToast((error as Error).message, "error"); }
    finally { setBusy(null); }
  };

  return (
    <div className="launchpad-shell">
      <header className="launchpad-topbar"><div className="launchpad-brand"><BrandMark size="lg" /><span><strong>TraceForge</strong><small>security-agent foundation</small></span></div><Button variant="ghost" size="icon-sm" onClick={openSettings} aria-label="Open settings"><Gear size={16} /></Button></header>
      <main className="launchpad-main">
        <section className="launchpad-engagements">
          <header className="launchpad-section-head"><div><h1>安全任务</h1><p>每个任务由 Scenario Profile、授权边界和统一事件协议驱动。</p></div><label><MagnifyingGlass size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索" /></label></header>
          <div className="launchpad-list">
            {loading && <div className="launchpad-empty"><CircleNotch className="tf-spin" size={20} />正在加载</div>}
            {!loading && visible.map((entry) => (
              <article className="launchpad-row" key={entry.id}>
                <button type="button" onClick={() => void enterCase(entry.id)}><span className="launchpad-target-icon"><Circle size={10} weight="fill" /></span><span className="launchpad-row-main"><strong>{entry.name}</strong><small>{entry.target ?? "未配置目标"}</small></span><span className="launchpad-status" data-status={entry.runStatus}>{entry.runStatus}</span></button>
                <button type="button" className="tf-btn tf-btn-ghost" aria-label={`Delete ${entry.name}`} onClick={async () => { if (!confirm(`删除 ${entry.name}？`)) return; await removeCase(entry.id); await load(); }}><Trash size={13} /></button>
              </article>
            ))}
            {!loading && visible.length === 0 && <div className="launchpad-empty">没有匹配的安全任务</div>}
          </div>
        </section>
        <section className="launchpad-quickstart"><div><h2>创建授权任务</h2><p>这里只创建 Case 和初始目标；Scenario Run 必须通过新的授权控制面启动。</p></div><div className="launchpad-target-entry"><input value={target} onChange={(event) => setTarget(event.target.value)} placeholder="https://app.example.com" onKeyDown={(event) => { if (event.key === "Enter") void create(); }} /><Button disabled={!normalizedTarget || Boolean(busy)} onClick={() => void create()}>{busy ? <CircleNotch className="tf-spin" /> : <Plus />}创建</Button></div></section>
      </main>
    </div>
  );
}
