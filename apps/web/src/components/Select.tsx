import { useState, useRef, useEffect } from "react";

export interface SelectOption {
  value: string;
  label: string;
}

export function Select({
  value, options, placeholder, onChange, minWidth = 160,
}: {
  value: string | null;
  options: SelectOption[];
  placeholder?: string;
  onChange: (value: string) => void;
  minWidth?: number;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const selected = options.find((o) => o.value === value);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onEsc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onEsc);
    return () => { document.removeEventListener("mousedown", onDoc); document.removeEventListener("keydown", onEsc); };
  }, [open]);

  return (
    <div className="tf-select" ref={ref} style={{ minWidth }}>
      <button type="button" className={`tf-select-trigger ${open ? "is-open" : ""}`} onClick={() => setOpen((v) => !v)}>
        <span className={selected ? "" : "tf-select-ph"}>{selected ? selected.label : placeholder ?? "选择…"}</span>
        <svg className="tf-select-caret" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6 6-6"/></svg>
      </button>
      {open && (
        <div className="tf-select-menu" role="listbox">
          {options.length === 0 && <div className="tf-select-empty">无可选项</div>}
          {options.map((o) => (
            <button
              key={o.value} type="button" role="option" aria-selected={o.value === value}
              className={`tf-select-opt ${o.value === value ? "is-sel" : ""}`}
              onClick={() => { onChange(o.value); setOpen(false); }}
            >
              <span>{o.label}</span>
              {o.value === value && (
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5"/></svg>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
