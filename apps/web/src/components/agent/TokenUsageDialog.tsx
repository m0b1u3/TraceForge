import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { useStore } from "../../store.js";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../ui/dialog.js";

function formatUsageCost(micros: number, currency: string): string {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  }).format(micros / 1_000_000);
}

export function TokenUsageDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { tokenUsage, tokenUsageHistory } = useStore(useShallow((state) => ({
    tokenUsage: state.tokenUsage,
    tokenUsageHistory: state.tokenUsageHistory,
  })));
  const summary = useMemo(() => {
    const pricedUsage = tokenUsageHistory.filter((entry) => entry.currency && entry.totalCostMicros !== null);
    const currency = pricedUsage.length === tokenUsageHistory.length ? (pricedUsage[0]?.currency ?? null) : null;
    const totalCostMicros = currency && pricedUsage.every((entry) => entry.currency === currency)
      ? pricedUsage.reduce((sum, entry) => sum + (entry.totalCostMicros ?? 0), 0)
      : null;
    return { currency, totalCostMicros };
  }, [tokenUsageHistory]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="usage-dialog">
        <DialogHeader>
          <DialogTitle>Run token usage</DialogTitle>
          <DialogDescription>Provider-reported token counts persisted for each LLM turn in the latest run.</DialogDescription>
        </DialogHeader>
        <div className="usage-summary" aria-label="Cumulative token usage">
          <span><strong>{tokenUsage.promptTokens.toLocaleString()}</strong> input</span>
          <span><strong>{tokenUsage.completionTokens.toLocaleString()}</strong> output</span>
          <span><strong>{tokenUsage.totalTokens.toLocaleString()}</strong> total</span>
          <span><strong>{summary.currency && summary.totalCostMicros !== null ? formatUsageCost(summary.totalCostMicros, summary.currency) : "Not configured"}</strong> cost</span>
        </div>
        {tokenUsageHistory.length > 0 ? (
          <div className="usage-table-wrap">
            <table className="usage-table">
              <thead><tr><th>Turn</th><th>Input</th><th>Output</th><th>Total</th><th>Cost</th></tr></thead>
              <tbody>
                {tokenUsageHistory.map((entry) => (
                  <tr key={entry.id}>
                    <td>{entry.turn}</td>
                    <td>{entry.promptTokens.toLocaleString()}</td>
                    <td>{entry.completionTokens.toLocaleString()}</td>
                    <td>{entry.totalTokens.toLocaleString()}</td>
                    <td>{entry.currency && entry.totalCostMicros !== null ? formatUsageCost(entry.totalCostMicros, entry.currency) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <p className="usage-empty">No provider usage has been recorded for this run.</p>}
      </DialogContent>
    </Dialog>
  );
}
