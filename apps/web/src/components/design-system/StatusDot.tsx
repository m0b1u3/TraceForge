import { cn } from "@/components/ui/utils";

export type StatusDotTone = "idle" | "active" | "busy" | "danger";

export function StatusDot({ tone = "idle", className }: { tone?: StatusDotTone; className?: string }) {
  return <span className={cn("status-dot", tone !== "idle" && tone, className)} aria-hidden="true" />;
}
