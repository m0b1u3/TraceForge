import { useState, useRef, useEffect, useId } from "react";
import { CaretDown, Check } from "@phosphor-icons/react";

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
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const listboxId = useId();
  const selected = options.find((o) => o.value === value);
  const [activeIndex, setActiveIndex] = useState(() => Math.max(0, options.findIndex((option) => option.value === value)));

  const openAt = (index: number) => {
    if (disabled || options.length === 0) return;
    setActiveIndex(Math.max(0, Math.min(index, options.length - 1)));
    setOpen(true);
  };

  const moveFocus = (index: number) => {
    const next = (index + options.length) % options.length;
    setActiveIndex(next);
    optionRefs.current[next]?.focus();
  };

  const selectOption = (option: SelectOption) => {
    onChange(option.value);
    setOpen(false);
    ref.current?.querySelector<HTMLButtonElement>(".tf-select-trigger")?.focus();
  };

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onEsc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onEsc);
    return () => { document.removeEventListener("mousedown", onDoc); document.removeEventListener("keydown", onEsc); };
  }, [open]);

  useEffect(() => {
    if (open) optionRefs.current[activeIndex]?.focus();
  }, [activeIndex, open]);

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
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            const selectedIndex = options.findIndex((option) => option.value === value);
            openAt(selectedIndex >= 0 ? selectedIndex : event.key === "ArrowDown" ? 0 : options.length - 1);
          }
        }}
      >
        <span className={selected ? "" : "tf-select-ph"} title={selected?.label}>{selected ? selected.label : placeholder ?? "Select…"}</span>
        <CaretDown className="tf-select-caret" size={12} aria-hidden="true" />
      </button>
      {open && (
        <div className="tf-select-menu" id={listboxId} role="listbox">
          {options.length === 0 && <div className="tf-select-empty">No options</div>}
          {options.map((o) => (
            <button
              key={o.value} type="button" role="option" aria-selected={o.value === value}
              ref={(element) => { optionRefs.current[options.indexOf(o)] = element; }}
              tabIndex={options.indexOf(o) === activeIndex ? 0 : -1}
              className={`tf-select-opt ${o.value === value ? "is-sel" : ""}`}
              onClick={() => selectOption(o)}
              onKeyDown={(event) => {
                const index = options.indexOf(o);
                if (event.key === "ArrowDown") { event.preventDefault(); moveFocus(index + 1); }
                if (event.key === "ArrowUp") { event.preventDefault(); moveFocus(index - 1); }
                if (event.key === "Home") { event.preventDefault(); moveFocus(0); }
                if (event.key === "End") { event.preventDefault(); moveFocus(options.length - 1); }
                if (event.key === "Escape") { event.preventDefault(); setOpen(false); ref.current?.querySelector<HTMLButtonElement>(".tf-select-trigger")?.focus(); }
                if (event.key === "Enter" || event.key === " ") { event.preventDefault(); selectOption(o); }
              }}
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
