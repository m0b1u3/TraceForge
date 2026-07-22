import { useEffect, useMemo, useState } from "react";
import { ArrowsClockwise, ArrowSquareOut, CaretDown, CheckCircle, Flask, ShieldCheck, WarningCircle } from "@phosphor-icons/react";
import { useShallow } from "zustand/react/shallow";
import type { ValidationWorkflowItem, ValidationWorkflowSnapshot } from "@traceforge/shared";
import { useStore } from "../../store.js";
import { deriveValidationPresentation, validationSyncLabel } from "../../lib/validation-presentation.js";

export type ValidationNavigationTarget = { kind: "finding" | "task"; id: string };

export function validationNavigationTarget(item: Pick<ValidationWorkflowItem, "findingId" | "taskId">, kind: "finding" | "task"): ValidationNavigationTarget | null {
  const id = kind === "finding" ? item.findingId : item.taskId;
  return id ? { kind, id } : null;
}

export type ValidationItemGroup = "running" | "leader" | "evidence" | "ready" | "monitoring";
const VALIDATION_GROUP_ORDER: ValidationItemGroup[] = ["running", "leader", "evidence", "ready", "monitoring"];
const VALIDATION_GROUP_LABEL: Record<ValidationItemGroup, string> = {
  running: "In progress",
  leader: "Priority",
  evidence: "Needs evidence",
  ready: "Completion ready",
  monitoring: "Monitoring",
};

export function validationItemGroup(item: ValidationWorkflowItem, runningLease: string | null, leaderTaskId?: string): ValidationItemGroup {
  if (item.taskId && (item.taskId === runningLease || item.taskStatus === "running")) return "running";
  if (item.taskId && item.taskId === leaderTaskId) return "leader";
  if (item.missingEvidence.length > 0) return "evidence";
  if (item.completionReady) return "ready";
  return "monitoring";
}

export function groupValidationWorkflowItems(items: ValidationWorkflowItem[], runningLease: string | null, leaderTaskId?: string) {
  const grouped = new Map<ValidationItemGroup, ValidationWorkflowItem[]>(VALIDATION_GROUP_ORDER.map((group) => [group, []]));
  for (const item of items) grouped.get(validationItemGroup(item, runningLease, leaderTaskId))?.push(item);
  return VALIDATION_GROUP_ORDER.flatMap((group) => {
    const groupItems = grouped.get(group) ?? [];
    groupItems.sort((left, right) => (right.priorityScore ?? -Infinity) - (left.priorityScore ?? -Infinity) || left.findingId.localeCompare(right.findingId));
    return groupItems.length ? [{ key: group, label: VALIDATION_GROUP_LABEL[group], items: groupItems }] : [];
  });
}

export const VALIDATION_GROUP_PAGE_SIZE = 4;

export function visibleValidationGroupItems(
  group: ValidationItemGroup,
  items: ValidationWorkflowItem[],
  options: { collapsed: boolean; limit: number; changedFindingIds: string[] },
): ValidationWorkflowItem[] {
  if (group === "running" || group === "leader") return items;
  const changed = new Set(options.changedFindingIds);
  if (options.collapsed) return items.filter((item) => changed.has(item.findingId));
  return items.filter((item, index) => index < options.limit || changed.has(item.findingId));
}

function ValidationItem({ item, leaderId, changed, onNavigate }: { item: ValidationWorkflowItem; leaderId?: string; changed: boolean; onNavigate: (target: ValidationNavigationTarget) => void }) {
  const isLeader = Boolean(item.taskId && item.taskId === leaderId);
  const findingTarget = validationNavigationTarget(item, "finding");
  const taskTarget = validationNavigationTarget(item, "task");
  return (
    <li className={`validation-item${isLeader ? " is-leader" : ""}${changed ? " is-changed" : ""}`}>
      <button type="button" className="validation-item-main" onClick={() => findingTarget && onNavigate(findingTarget)}>
        <span className={`validation-state-dot${item.completionReady ? " is-ready" : ""}`} aria-hidden="true" />
        <div>
          <strong>{item.findingTitle || item.findingId}</strong>
          <span>{item.consensusStatus.replaceAll("_", " ")} · {Math.round(item.confidence * 100)}% confidence</span>
        </div>
        <ArrowSquareOut size={12} aria-hidden="true" />
      </button>
      <button type="button" className="validation-item-score" disabled={!taskTarget} onClick={() => taskTarget && onNavigate(taskTarget)} aria-label={taskTarget ? `Locate task, priority ${item.priorityScore ?? "unscored"}` : "No validation task"}>
        {isLeader && <span>Lead</span>}{item.priorityScore ?? "—"}
      </button>
      {item.missingEvidence.length > 0 ? (
        <div className="validation-evidence-gap"><WarningCircle size={13} weight="fill" />{item.missingEvidence.join(" · ")}</div>
      ) : (
        <div className="validation-evidence-ready"><CheckCircle size={13} weight="fill" />Evidence gate satisfied</div>
      )}
    </li>
  );
}

export function ValidationWorkflow({ onNavigate }: { onNavigate: (target: ValidationNavigationTarget) => void }) {
  const { caseId, snapshot, tasks, delta, syncStatus, refreshValidationWorkflow } = useStore(useShallow((state) => ({
    caseId: state.caseId,
    snapshot: state.validationWorkflow,
    tasks: state.tasks,
    delta: state.validationWorkflowDelta,
    syncStatus: state.validationSyncStatus,
    refreshValidationWorkflow: state.refreshValidationWorkflow,
  })));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [collapsedGroups, setCollapsedGroups] = useState<Set<ValidationItemGroup>>(() => new Set(["monitoring"]));
  const [groupLimits, setGroupLimits] = useState<Partial<Record<ValidationItemGroup, number>>>({});

  useEffect(() => {
    setCollapsedGroups(new Set(["monitoring"]));
    setGroupLimits({});
  }, [caseId]);

  const load = async () => {
    if (!caseId) return;
    setLoading(true);
    setError("");
    try {
      await refreshValidationWorkflow();
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const presentation = useMemo(() => snapshot ? deriveValidationPresentation(snapshot, tasks, syncStatus) : null, [snapshot, syncStatus, tasks]);
  const tone = presentation?.tone ?? "quiet";
  const groups = useMemo(() => snapshot ? groupValidationWorkflowItems(snapshot.items, snapshot.runningLease, snapshot.leader?.taskId) : [], [snapshot]);
  if (!caseId) return null;

  return (
    <section className={`validation-workflow tone-${tone}`} aria-label="Validation workflow status" aria-busy={loading}>
      <div className="validation-workflow-head">
        <div className="validation-workflow-title">
          <ShieldCheck size={15} weight="duotone" />
          <div><span>Validation control</span><strong>{snapshot?.runningLease ? "Evidence work in progress" : snapshot?.items.length ? "Verification queue" : "No findings awaiting validation"}</strong></div>
        </div>
        <div className="validation-workflow-actions">
          <span className={`validation-sync is-${syncStatus}`} role="status" aria-live="polite" title={snapshot ? `Workflow revision ${snapshot.revision}` : "Workflow snapshot unavailable"}>
            <i aria-hidden="true" />{validationSyncLabel(syncStatus)}
          </span>
          <button type="button" className="tf-btn tf-btn-ghost tf-btn-icon" onClick={() => void load()} disabled={loading} aria-label="Refresh validation workflow" title="Refresh validation workflow">
            <ArrowsClockwise size={14} className={loading ? "tf-spin" : ""} />
          </button>
        </div>
      </div>
      {error && <div className="validation-workflow-error"><WarningCircle size={14} />{error}</div>}
      {snapshot && snapshot.items.length > 0 && (
        <>
          <div className="validation-metrics">
            <span><i className="validation-pulse" />{snapshot.runningLease ? "Lease active" : "Queue idle"}</span>
            <span><Flask size={13} />{snapshot.exploration.explorationBoundariesRemaining > 0 ? `${snapshot.exploration.explorationBoundariesRemaining} exploration steps` : "Evidence priority"}</span>
            <span className={presentation?.auditCount ? "is-danger" : ""}>{presentation?.auditCount ? `${presentation.auditCount} audit issue${presentation.auditCount === 1 ? "" : "s"}` : "Consistent"}</span>
          </div>
          {delta && delta.revision === snapshot.revision && delta.summary.length > 0 && (
            <div className="validation-change-feed" key={delta.revision} role="status" aria-live="polite">
              <i aria-hidden="true" /><span>{delta.summary.slice(0, 2).join(" · ")}</span>
              {delta.summary.length > 2 && <small>+{delta.summary.length - 2}</small>}
            </div>
          )}
          <div className="validation-list">
            {groups.map((group) => {
              const collapsed = collapsedGroups.has(group.key);
              const limit = groupLimits[group.key] ?? VALIDATION_GROUP_PAGE_SIZE;
              const changedFindingIds = delta?.revision === snapshot.revision ? delta.changedFindingIds : [];
              const visibleItems = visibleValidationGroupItems(group.key, group.items, { collapsed, limit, changedFindingIds });
              const hiddenCount = group.items.length - visibleItems.length;
              return <section className={`validation-group is-${group.key}`} key={group.key} aria-labelledby={`validation-group-${group.key}`}>
                {group.key === "running" || group.key === "leader" ? (
                  <h3 className="validation-group-static" id={`validation-group-${group.key}`}>{group.label}<span>{group.items.length}</span></h3>
                ) : (
                  <h3 id={`validation-group-${group.key}`}>
                    <button type="button" aria-expanded={!collapsed} aria-controls={`validation-items-${group.key}`} onClick={() => setCollapsedGroups((current) => {
                      const next = new Set(current);
                      if (next.has(group.key)) next.delete(group.key); else next.add(group.key);
                      return next;
                    })}>
                      <span>{group.label}<small>{group.items.length}</small></span><CaretDown size={12} className={collapsed ? "" : "is-open"} />
                    </button>
                  </h3>
                )}
                <ol id={`validation-items-${group.key}`}>
                  {visibleItems.map((item) => {
                    const changed = delta?.revision === snapshot.revision && delta.changedFindingIds.includes(item.findingId);
                    return <ValidationItem key={`${item.findingId}:${changed ? delta?.revision ?? 0 : 0}`} item={item} leaderId={snapshot.leader?.taskId} changed={Boolean(changed)} onNavigate={onNavigate} />;
                  })}
                </ol>
                {!collapsed && group.key !== "running" && group.key !== "leader" && hiddenCount > 0 && (
                  <button type="button" className="validation-show-more" onClick={() => setGroupLimits((current) => ({ ...current, [group.key]: (current[group.key] ?? VALIDATION_GROUP_PAGE_SIZE) + VALIDATION_GROUP_PAGE_SIZE }))}>
                    Show more <span>{Math.min(VALIDATION_GROUP_PAGE_SIZE, hiddenCount)}</span>
                  </button>
                )}
              </section>;
            })}
          </div>
          {snapshot.auditIssues.length > 0 && (
            <div className="validation-audit-list" aria-label="Consistency audit issues">
              {snapshot.auditIssues.map((issue) => (
                <button type="button" key={issue.taskId} onClick={() => onNavigate({ kind: "task", id: issue.taskId })}>
                  <WarningCircle size={13} weight="fill" /><span>{issue.issue.replace("[Consistency audit]", "").trim()}</span><ArrowSquareOut size={12} />
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}
