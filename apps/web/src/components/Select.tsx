import { useState, useRef, useEffect, useId } from "react";
import { Check, ChevronDown } from "lucide-react";

export interface SelectOption {
  value: string;
  label: string;
}

export function Select({
  value, options, placeholder, onChange, minWidth = 160, className, disabled = false,
}: {
  value: string | null;
  options: SelectOption[];
  placeholder?: string;
  onChange: (value: string) => void;
  minWidth?: number;
  className?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const listboxId = useId();
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
    <div className={`tf-select ${className ?? ""}`} ref={ref} style={{ minWidth }}>
      <button
        type="button"
        className={`tf-select-trigger ${open ? "is-open" : ""}`}
        aria-controls={listboxId}
        aria-expanded={open}
        aria-haspopup="listbox"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
      >
        <span className={selected ? "" : "tf-select-ph"} title={selected?.label}>{selected ? selected.label : placeholder ?? "Select…"}</span>
        <ChevronDown className="tf-select-caret" size={12} aria-hidden="true" />
      </button>
      {open && (
        <div className="tf-select-menu" id={listboxId} role="listbox">
          {options.length === 0 && <div className="tf-select-empty">No options</div>}
          {options.map((o) => (
            <button
              key={o.value} type="button" role="option" aria-selected={o.value === value}
              className={`tf-select-opt ${o.value === value ? "is-sel" : ""}`}
              onClick={() => { onChange(o.value); setOpen(false); }}
            >
              <span title={o.label}>{o.label}</span>
              {o.value === value && <Check size={13} aria-hidden="true" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
