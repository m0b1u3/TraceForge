import type { ReactNode } from "react";

export function FindingField({ label, children, code = false }: { label: string; children: ReactNode; code?: boolean }) {
  return (
    <div className="fact-value-row">
      <span>{label}</span>
      {code ? <code>{children}</code> : <span>{children}</span>}
    </div>
  );
}
