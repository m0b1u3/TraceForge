import type { Task, ValidationWorkflowSnapshot } from "@traceforge/shared";

export type ValidationSyncState = "live" | "recovering" | "stale";
export type ValidationTone = "danger" | "warning" | "active" | "quiet";
export type ValidationDiagnostic = { kind: "stale" | "recovering" | "lease_missing" | "leader_missing" | "audit"; label: string; detail: string; taskId?: string };

export function validationSyncLabel(status: ValidationSyncState): "Live" | "Recovering" | "Stale" {
  if (status === "live") return "Live";
  if (status === "recovering") return "Recovering";
  return "Stale";
}

export function deriveValidationPresentation(snapshot: ValidationWorkflowSnapshot, tasks: Task[], syncStatus: ValidationSyncState) {
  const leaseExists = !snapshot.runningLease || tasks.some((task) => task.id === snapshot.runningLease);
  const leaderExists = !snapshot.leader || tasks.some((task) => task.id === snapshot.leader?.taskId);
  const firstAudit = snapshot.auditIssues[0];
  const diagnostic: ValidationDiagnostic | null = syncStatus === "stale"
    ? { kind: "stale", label: "Snapshot stale", detail: "Refresh validation state" }
    : syncStatus === "recovering"
      ? { kind: "recovering", label: "Recovering", detail: "Synchronizing validation state" }
      : !leaseExists
        ? { kind: "lease_missing", label: "Lease missing", detail: snapshot.runningLease ?? "Unknown task" }
        : !leaderExists
          ? { kind: "leader_missing", label: "Leader missing", detail: snapshot.leader?.taskId ?? "Unknown task" }
          : firstAudit
            ? { kind: "audit", label: `${snapshot.auditIssues.length} audit issue${snapshot.auditIssues.length === 1 ? "" : "s"}`, detail: firstAudit.issue.replace("[Consistency audit]", "").trim(), taskId: firstAudit.taskId }
            : null;
  const evidence = {
    ready: snapshot.items.filter((item) => item.completionReady).length,
    total: snapshot.items.length,
    missing: snapshot.items.reduce((count, item) => count + item.missingEvidence.length, 0),
  };
  const tone: ValidationTone = diagnostic && ["audit", "lease_missing", "leader_missing"].includes(diagnostic.kind)
    ? "danger"
    : diagnostic || evidence.missing > 0
      ? "warning"
      : snapshot.runningLease
        ? "active"
        : "quiet";
  return { syncStatus, syncLabel: validationSyncLabel(syncStatus), diagnostic, evidence, tone, auditCount: snapshot.auditIssues.length };
}
