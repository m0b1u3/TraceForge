import { useState, useEffect } from "react";
import { Plus, Warning, ShieldCheck } from "@phosphor-icons/react";
import { useStore } from "../store.js";
import { listCases, createCase } from "../api.js";
import { Select } from "./Select.js";

export function TopBar() {
  const { caseId, cases, setCases, enterCase, browserController, browserUrl, facts, tasks, warnings } = useStore();
  const crit = warnings.filter((w) => w.level === "critical").length;
  const warnCls = crit > 0 ? "is-crit" : warnings.length > 0 ? "is-alert" : "";
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [hosts, setHosts] = useState("");

  const submitCreate = async () => {
    if (!name.trim()) return;
    const c = await createCase(name.trim(), hosts.split(",").map((h) => h.trim()).filter(Boolean));
    setCases([...cases, c]);
    await enterCase(c.id);
    setCreating(false);
    setName("");
    setHosts("");
  };

  useEffect(() => { listCases().then(setCases); }, [setCases]);

  const controlLabel = browserController === "human" ? "人" : browserController === "llm" ? "LLM" : "未启动";
  const controlClass = browserController === "human" ? "is-human" : browserController === "llm" ? "is-llm" : "";

  return (
    <div className="tf-topbar">
      <span className="tf-brand">TraceForge</span>
      <span className="tf-topbar-div" />
      <Select
        value={caseId}
        placeholder="选择 Case"
        options={cases.map((c) => ({ value: c.id, label: c.name }))}
        onChange={(v) => enterCase(v)}
        minWidth={150}
      />
      <button className="tf-btn tf-btn-icon" onClick={() => setCreating((v) => !v)}>
        <Plus size={14} weight="bold" /> 新建
      </button>
      {creating && (
        <div className="tf-create-pop">
          <input
            className="tf-input" value={name} autoFocus
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") submitCreate(); if (e.key === "Escape") setCreating(false); }}
            placeholder="Case 名称"
            style={{ width: 150 }}
          />
          <input
            className="tf-input" value={hosts}
            onChange={(e) => setHosts(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") submitCreate(); if (e.key === "Escape") setCreating(false); }}
            placeholder="授权范围（可选）"
            style={{ width: 170 }}
          />
          <button className="tf-btn tf-btn-accent" disabled={!name.trim()} onClick={submitCreate}>创建</button>
          <button className="tf-btn" onClick={() => { setCreating(false); setName(""); setHosts(""); }}>取消</button>
        </div>
      )}
      <span className="tf-spacer" />
      {caseId && (
        <>
          <span className="tf-stat">Facts <b>{facts.length}</b></span>
          <span className="tf-stat-sep" />
          <span className="tf-stat">Tasks <b>{tasks.length}</b></span>
          <span className="tf-stat-sep" />
          <span className={`tf-stat ${warnCls}`} title="Observer 监督提示"><Warning size={13} weight="fill" /> <b>{warnings.length}</b></span>
          <span className="tf-stat-sep" />
          <span className={`tf-pill ${controlClass}`}>
            <ShieldCheck size={13} weight="fill" style={{ opacity: 0.7 }} />
            {controlLabel}
            {browserUrl && <span style={{ color: "var(--tf-faint)" }}>· {browserUrl}</span>}
          </span>
        </>
      )}
    </div>
  );
}
