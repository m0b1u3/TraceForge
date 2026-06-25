import { useState, useEffect } from "react";
import { Plus } from "@phosphor-icons/react";
import { useStore } from "../store.js";
import { listCases, createCase } from "../api.js";
import { Select } from "./Select.js";

export function CaseLauncher({ variant = "hero" }: { variant?: "hero" | "bar" }) {
  const { caseId, cases, setCases, enterCase } = useStore();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [hosts, setHosts] = useState("");

  useEffect(() => { listCases().then(setCases); }, [setCases]);

  const submit = async () => {
    if (!name.trim()) return;
    const c = await createCase(name.trim(), hosts.split(",").map((h) => h.trim()).filter(Boolean));
    setCases([...cases, c]);
    await enterCase(c.id);
    setCreating(false);
    setName("");
    setHosts("");
  };

  if (variant === "bar") {
    return (
      <>
        <Select value={caseId} placeholder="选择 Case" options={cases.map((c) => ({ value: c.id, label: c.name }))} onChange={(v) => enterCase(v)} minWidth={150} />
        <button className="tf-btn tf-btn-icon" onClick={() => setCreating((v) => !v)}><Plus size={14} weight="bold" /> 新建</button>
        {creating && (
          <div className="tf-create-pop">
            <input className="tf-input" value={name} autoFocus onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") submit(); if (e.key === "Escape") setCreating(false); }}
              placeholder="Case 名称" style={{ width: 150 }} />
            <input className="tf-input" value={hosts} onChange={(e) => setHosts(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") submit(); if (e.key === "Escape") setCreating(false); }}
              placeholder="授权范围（可选）" style={{ width: 170 }} />
            <button className="tf-btn tf-btn-accent" disabled={!name.trim()} onClick={submit}>创建</button>
            <button className="tf-btn" onClick={() => { setCreating(false); setName(""); setHosts(""); }}>取消</button>
          </div>
        )}
      </>
    );
  }

  // hero 变体：首屏右卡
  return (
    <div className="tf-launcher">
      {!creating ? (
        <>
          <div className="tf-launcher-label">开始一个任务</div>
          {cases.length > 0 && (
            <>
              <Select value={caseId} placeholder="选择已有 Case" options={cases.map((c) => ({ value: c.id, label: c.name }))} onChange={(v) => enterCase(v)} minWidth={0} />
              <div className="tf-launcher-or"><span>或</span></div>
            </>
          )}
          <button className="tf-btn tf-btn-accent tf-btn-block tf-btn-icon" onClick={() => setCreating(true)}>
            <Plus size={15} weight="bold" /> 新建 Case
          </button>
        </>
      ) : (
        <>
          <div className="tf-launcher-label">新建 Case</div>
          <input className="tf-input tf-input-block" value={name} autoFocus onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") submit(); if (e.key === "Escape") setCreating(false); }}
            placeholder="给这次任务取个名字" />
          <input className="tf-input tf-input-block" value={hosts} onChange={(e) => setHosts(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") submit(); if (e.key === "Escape") setCreating(false); }}
            placeholder="授权范围 host（可选，稍后在对话中纳入）" />
          <div style={{ display: "flex", gap: 8, marginTop: 2 }}>
            <button className="tf-btn tf-btn-accent" style={{ flex: 1 }} disabled={!name.trim()} onClick={submit}>创建并进入</button>
            <button className="tf-btn" onClick={() => { setCreating(false); setName(""); setHosts(""); }}>取消</button>
          </div>
        </>
      )}
    </div>
  );
}
