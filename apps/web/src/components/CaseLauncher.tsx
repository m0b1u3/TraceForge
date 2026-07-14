import { useState, useEffect } from "react";
import { CircleNotch, DotsThree, Plus, Trash } from "@phosphor-icons/react";
import { useStore } from "../store.js";
import { listCases, createCase } from "../api.js";
import { Select } from "./Select.js";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "./ui/dropdown-menu.js";

export function CaseLauncher({ variant = "hero" }: { variant?: "hero" | "bar" }) {
  const { caseId, cases, setCases, enterCase, deleteCase, showToast } = useStore();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [loadingCases, setLoadingCases] = useState(true);
  const [enteringCase, setEnteringCase] = useState(false);
  const [creatingCase, setCreatingCase] = useState(false);
  const [deletingCase, setDeletingCase] = useState(false);

  useEffect(() => {
    let active = true;
    void listCases()
      .then((list) => { if (active) setCases(list); })
      .catch(() => { if (active) showToast("Failed to load cases"); })
      .finally(() => { if (active) setLoadingCases(false); });
    return () => { active = false; };
  }, [setCases, showToast]);

  // Scope is not set during creation: test boundaries are analyzed and proposed by the Agent in conversation, then approved by you (see propose_scope_expansion).
  const selectCase = async (id: string) => {
    if (enteringCase || id === caseId) return;
    setEnteringCase(true);
    try {
      await enterCase(id);
    } catch (e) {
      showToast((e as Error).message);
    } finally {
      setEnteringCase(false);
    }
  };

  const submit = async () => {
    if (!name.trim() || creatingCase) return;
    setCreatingCase(true);
    try {
      const c = await createCase(name.trim(), []);
      setCases([...useStore.getState().cases, c]);
      await enterCase(c.id);
      setCreating(false);
      setName("");
    } catch (e) {
      showToast((e as Error).message);
    } finally {
      setCreatingCase(false);
    }
  };

  const onDelete = async () => {
    if (!caseId || deletingCase) return;
    const selected = cases.find((c) => c.id === caseId);
    if (!selected) return;
    if (!window.confirm(`Delete case "${selected.name}" and all its data? This cannot be undone.`)) return;
    setDeletingCase(true);
    try {
      await deleteCase(caseId);
    } catch (e) {
      showToast((e as Error).message);
    } finally {
      setDeletingCase(false);
    }
  };

  if (variant === "bar") {
    return (
      <div className="tf-case-bar">
        <Select className="tf-case-select" value={caseId} placeholder={loadingCases ? "Loading cases..." : enteringCase ? "Opening case..." : "Select case"} options={cases.map((c) => ({ value: c.id, label: c.name }))} onChange={(v) => void selectCase(v)} minWidth={150} disabled={loadingCases || enteringCase || creatingCase || deletingCase} />
        <button className="tf-btn tf-btn-icon" disabled={creatingCase || deletingCase} onClick={() => setCreating((v) => !v)}><Plus size={14} /> New</button>
        {caseId && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button className="tf-btn tf-btn-icon tf-case-more" disabled={deletingCase || creatingCase} title="Case actions" aria-label="Case actions">
                {deletingCase ? <CircleNotch size={14} className="tf-spin" /> : <DotsThree size={16} weight="bold" />}
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem className="text-destructive focus:text-destructive" onSelect={() => void onDelete()}>
                <Trash size={14} /> Delete case
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        {creating && (
          <div className="tf-create-pop">
            <input className="tf-input case-launcher-input" value={name} autoFocus onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") submit(); if (e.key === "Escape") setCreating(false); }}
              placeholder="Case name" />
            <button className="tf-btn tf-btn-primary" disabled={!name.trim() || creatingCase} onClick={submit}>{creatingCase && <CircleNotch size={13} className="tf-spin" />}Create</button>
            <button className="tf-btn" disabled={creatingCase} onClick={() => { setCreating(false); setName(""); }}>Cancel</button>
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
              <Select value={caseId} placeholder={loadingCases ? "Loading cases..." : enteringCase ? "Opening case..." : "Choose a case"} options={cases.map((c) => ({ value: c.id, label: c.name }))} onChange={(v) => void selectCase(v)} minWidth={0} disabled={loadingCases || enteringCase || creatingCase} />
              <div className="tf-launcher-or"><span>or</span></div>
            </>
          )}
          <button className="tf-btn tf-btn-primary tf-btn-block tf-btn-icon" disabled={loadingCases} onClick={() => setCreating(true)}>
            <Plus size={15} /> Create new case
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
            <button className="tf-btn tf-btn-primary" disabled={!name.trim() || creatingCase} onClick={submit}>{creatingCase && <CircleNotch size={13} className="tf-spin" />}Create and enter</button>
            <button className="tf-btn" disabled={creatingCase} onClick={() => { setCreating(false); setName(""); }}>Cancel</button>
          </div>
        </>
      )}
    </div>
  );
}
