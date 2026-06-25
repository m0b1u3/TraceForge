import { useState, useEffect } from "react";
import { useStore } from "../store.js";
import { listCases, createCase } from "../api.js";

export function TopBar() {
  const { caseId, cases, setCases, enterCase, browserController, browserUrl } = useStore();
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
      <select className="tf-input" value={caseId ?? ""} onChange={(e) => enterCase(e.target.value)}>
        {!caseId && <option value="">选择 Case…</option>}
        {cases.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
      </select>
      <button className="tf-btn" onClick={() => setCreating((v) => !v)}>新建 Case</button>
      {creating && (
        <>
          <input
            className="tf-input" value={name} autoFocus
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") submitCreate(); if (e.key === "Escape") setCreating(false); }}
            placeholder="Case 名称"
          />
          <input
            className="tf-input" value={hosts}
            onChange={(e) => setHosts(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") submitCreate(); if (e.key === "Escape") setCreating(false); }}
            placeholder="授权范围 host（可选，逗号分隔）"
          />
          <button className="tf-btn tf-btn-accent" disabled={!name.trim()} onClick={submitCreate}>创建</button>
          <button className="tf-btn" onClick={() => { setCreating(false); setName(""); setHosts(""); }}>取消</button>
        </>
      )}
      <span className="tf-spacer" />
      {caseId && (
        <span className={`tf-pill ${controlClass}`}>
          控制权 {controlLabel}
          {browserUrl && <span style={{ color: "var(--tf-faint)" }}>· {browserUrl}</span>}
        </span>
      )}
    </div>
  );
}
