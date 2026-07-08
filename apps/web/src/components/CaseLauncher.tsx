import { useState, useEffect } from "react";
import { Plus, Trash } from "@phosphor-icons/react";
import { useStore } from "../store.js";
import { listCases, createCase } from "../api.js";
import { Select } from "./Select.js";

export function CaseLauncher({ variant = "hero" }: { variant?: "hero" | "bar" }) {
  const { caseId, cases, setCases, enterCase, deleteCase, showToast } = useStore();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");

  useEffect(() => { listCases().then(setCases).catch(() => showToast("Failed to load cases")); }, [setCases, showToast]);

  // Scope is not set during creation: test boundaries are analyzed and proposed by the Agent in conversation, then approved by you (see propose_scope_expansion).
  const submit = async () => {
    if (!name.trim()) return;
    try {
      const c = await createCase(name.trim(), []);
      setCases([...cases, c]);
      await enterCase(c.id);
      setCreating(false);
      setName("");
    } catch (e) {
      showToast((e as Error).message);
    }
  };

  const onDelete = async () => {
    if (!caseId) return;
    const selected = cases.find((c) => c.id === caseId);
    if (!selected) return;
    if (!window.confirm(`Delete case "${selected.name}" and all its data? This cannot be undone.`)) return;
    try {
      await deleteCase(caseId);
    } catch (e) {
      showToast((e as Error).message);
    }
  };

  if (variant === "bar") {
    return (
      <div className="tf-case-bar">
        <Select className="tf-case-select" value={caseId} placeholder="Select case" options={cases.map((c) => ({ value: c.id, label: c.name }))} onChange={(v) => enterCase(v)} minWidth={150} />
        <button className="tf-btn tf-btn-icon" onClick={() => setCreating((v) => !v)}><Plus size={14} weight="bold" /> New</button>
        {caseId && (
          <button className="tf-btn tf-btn-icon tf-btn-danger" onClick={onDelete} title="Delete case">
            <Trash size={14} weight="bold" />
          </button>
        )}
        {creating && (
          <div className="tf-create-pop">
            <input className="tf-input case-launcher-input" value={name} autoFocus onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") submit(); if (e.key === "Escape") setCreating(false); }}
              placeholder="Case name" />
            <button className="tf-btn tf-btn-primary" disabled={!name.trim()} onClick={submit}>Create</button>
            <button className="tf-btn" onClick={() => { setCreating(false); setName(""); }}>Cancel</button>
          </div>
        )}
      </div>
    );
  }

  // hero variant: right card on the landing screen
  return (
    <div className="tf-launcher">
      {!creating ? (
        <>
          <div className="tf-launcher-label">Start a session</div>
          {cases.length > 0 && (
            <>
              <Select value={caseId} placeholder="Choose a case" options={cases.map((c) => ({ value: c.id, label: c.name }))} onChange={(v) => enterCase(v)} minWidth={0} />
              <div className="tf-launcher-or"><span>or</span></div>
            </>
          )}
          <button className="tf-btn tf-btn-primary tf-btn-block tf-btn-icon" onClick={() => setCreating(true)}>
            <Plus size={15} weight="bold" /> Create new case
          </button>
        </>
      ) : (
        <>
          <div className="tf-launcher-label">Create new case</div>
          <input className="tf-input tf-input-block" value={name} autoFocus onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") submit(); if (e.key === "Escape") setCreating(false); }}
            placeholder="Name this session" />
          <div className="tf-launcher-hint">No need to set scope up front. After entering, tell the Agent what target to test in the chat. It will identify the host and propose adding it to the authorized scope for your approval.</div>
          <div className="case-launcher-actions">
            <button className="tf-btn tf-btn-primary" disabled={!name.trim()} onClick={submit}>Create and enter</button>
            <button className="tf-btn" onClick={() => { setCreating(false); setName(""); }}>Cancel</button>
          </div>
        </>
      )}
    </div>
  );
}
