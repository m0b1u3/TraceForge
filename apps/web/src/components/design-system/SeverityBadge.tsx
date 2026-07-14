import { cn } from "@/components/ui/utils";

export type Severity = "critical" | "high" | "medium" | "low" | "info";

const labels: Record<Severity, string> = { critical: "Critical", high: "High", medium: "Medium", low: "Low", info: "Info" };

export function SeverityBadge({ severity, className }: { severity: Severity; className?: string }) {
  return <span className={cn("severity-badge", `is-${severity}`, className)}>{labels[severity]}</span>;
}
