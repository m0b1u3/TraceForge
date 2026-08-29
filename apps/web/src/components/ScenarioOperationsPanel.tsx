import { useEffect, useMemo, useState } from "react";
import { ArrowClockwise, Check, Clock, Pause, Play, ShieldCheck, Stop, Warning, X } from "@phosphor-icons/react";
import { useShallow } from "zustand/react/shallow";
import type { ScenarioAuthorization, ScenarioRunState } from "../api.js";
import { useStore } from "../store.js";
import { ScenarioCollaborationView } from "./ScenarioCollaborationView.js";

export function authorizationIsUsable(authorization: ScenarioAuthorization, now = Date.now()): boolean {
  return authorization.status === "active" && Date.parse(authorization.expiresAt) > now;
}

export function scenarioRunProgress(run: ScenarioRunState): { completed: number; active: number; waiting: number; total: number } {
  return {
    completed: run.workItems.filter((work) => work.status === "completed").length,
    active: run.workItems.filter((work) => work.status === "running" || work.status === "queued").length,
    waiting: run.workItems.filter((work) => work.status === "waiting_approval" || work.status === "blocked").length,
    total: run.workItems.length,
  };
}

export function normalizeAuthorizationTarget(value: string): string | null {
  const candidate = value.trim();
  if (!candidate || /\s/.test(candidate)) return null;
  try {
    const url = new URL(candidate.includes("://") ? candidate : `https://${candidate}`);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href.replace(/\/$/, "") : null;
  } catch { return null; }
}

function defaultExpiry(): string {
  const date = new Date(Date.now() + 8 * 60 * 60_000);
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

export function ScenarioOperationsPanel() {
  const {
    caseId, cases, definitions, authorizations, runs, run, collaboration, recovery, approvals, status,
    refresh, refreshCollaboration, createAuthorization, revokeAuthorization, startRun, pauseRun, resumeRun, cancelRun, resolveApproval, showToast,
  } = useStore(useShallow((state) => ({
    caseId: state.caseId,
    cases: state.cases,
    definitions: state.scenarioDefinitions,
    authorizations: state.scenarioAuthorizations,
    runs: state.scenarioRuns,
    run: state.activeScenarioRun,
    collaboration: state.scenarioCollaboration,
    recovery: state.scenarioRecovery,
    approvals: state.scenarioApprovals,
    status: state.scenarioOperationsStatus,
    refresh: state.refreshScenarioOperations,
    refreshCollaboration: state.refreshScenarioCollaboration,
    createAuthorization: state.createScenarioAuthorization,
    revokeAuthorization: state.revokeScenarioAuthorization,
    startRun: state.startScenarioRun,
    pauseRun: state.pauseScenarioRun,
    resumeRun: state.resumeScenarioRun,
    cancelRun: state.cancelScenarioRun,
    resolveApproval: state.resolveScenarioApproval,
    showToast: state.showToast,
  })));
  const definition = definitions.find((candidate) => candidate.kind === "web_blackbox");
  const currentCase = cases.find((candidate) => candidate.id === caseId);
  const defaultTarget = currentCase?.scopeRules.flatMap((rule) => rule.allowHosts)[0] ?? "";
  const [target, setTarget] = useState("");
  const [approvedBy, setApprovedBy] = useState("local-operator");
  const [expiresAt, setExpiresAt] = useState(defaultExpiry);
  const [notes, setNotes] = useState("");
  const [allowedActions, setAllowedActions] = useState<string[]>([]);
  const [goal, setGoal] = useState("");
  const [authorizationId, setAuthorizationId] = useState("");
  const [approvalReasons, setApprovalReasons] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const activeAuthorizations = useMemo(
    () => authorizations.filter((authorization) => authorizationIsUsable(authorization)),
    [authorizations],
  );
  const progress = run ? scenarioRunProgress(run) : null;
  const unavailableRun = runs.find((candidate) => candidate.packageAvailability === "recovery_required");
  const phase = definition?.phases.find((candidate) => candidate.id === run?.activePhaseId);

  useEffect(() => {
    if (!target && defaultTarget) setTarget(`https://${defaultTarget}`);
  }, [defaultTarget, target]);
  useEffect(() => {
    if (definition && allowedActions.length === 0) setAllowedActions(definition.authorizationActions);
  }, [definition, allowedActions.length]);
  useEffect(() => {
    if (!activeAuthorizations.some((authorization) => authorization.id === authorizationId)) {
      setAuthorizationId(activeAuthorizations[0]?.id ?? "");
    }
  }, [activeAuthorizations, authorizationId]);

  const perform = async (key: string, action: () => Promise<void>, success: string) => {
    setBusy(key);
    try {
      await action();
      showToast(success, "success");
    } catch (error) { showToast((error as Error).message, "error"); }
    finally { setBusy(null); }
  };

  const normalizedTarget = normalizeAuthorizationTarget(target);
  const expiryIso = expiresAt ? new Date(expiresAt).toISOString() : "";
  const canAuthorize = Boolean(definition && normalizedTarget && approvedBy.trim() && allowedActions.length && Date.parse(expiryIso) > Date.now());
  const runIsActive = run?.status === "running";
  const runIsPaused = run?.status === "paused";
  const runIsControllable = runIsActive || runIsPaused;
  useEffect(() => {
    if (!runIsControllable) return;
    const timer = setInterval(() => { void refreshCollaboration().catch(() => undefined); }, 5_000);
    return () => clearInterval(timer);
  }, [refreshCollaboration, runIsControllable]);

  return (
    <aside className="scenario-operations" aria-label="Scenario operations">
      <header className="scenario-operations-header">
        <div><strong>运行控制</strong><span>{definition ? `${definition.kind}@${definition.version}` : "正在加载 Profile"}</span></div>
        <button className="tf-btn tf-btn-ghost" type="button" aria-label="Refresh operations" onClick={() => void perform("refresh", refresh, "控制面已同步")} disabled={busy === "refresh" || status === "loading"}><ArrowClockwise size={13} /></button>
      </header>

      {status === "error" && <div className="scenario-operation-alert"><Warning size={14} /><span>控制面加载失败，请重新同步。</span></div>}

      <section className="scenario-section">
        <header><ShieldCheck size={13} /><strong>授权边界</strong><span>{activeAuthorizations.length} active</span></header>
        {activeAuthorizations.map((authorization) => (
          <article className="scenario-authorization" key={authorization.id}>
            <div><strong>{authorization.scope.targets.join(", ")}</strong><small>{authorization.approvedBy} · 到期 {new Date(authorization.expiresAt).toLocaleString()}</small></div>
            <button className="tf-btn tf-btn-ghost" type="button" disabled={Boolean(busy)} onClick={() => {
              if (!confirm("撤销授权会立即取消关联的运行，是否继续？")) return;
              void perform(`revoke:${authorization.id}`, () => revokeAuthorization(authorization.id), "授权已撤销");
            }}>撤销</button>
          </article>
        ))}
        <details className="scenario-create" open={activeAuthorizations.length === 0}>
          <summary>创建新授权</summary>
          <label><span>目标</span><input value={target} onChange={(event) => setTarget(event.target.value)} placeholder="https://app.example.com" /></label>
          <div className="scenario-form-grid">
            <label><span>授权人</span><input value={approvedBy} onChange={(event) => setApprovedBy(event.target.value)} /></label>
            <label><span>到期时间</span><input type="datetime-local" value={expiresAt} onChange={(event) => setExpiresAt(event.target.value)} /></label>
          </div>
          <label><span>备注</span><input value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="授权来源或限制" /></label>
          <fieldset>
            <legend>允许动作</legend>
            {definition?.authorizationActions.map((action) => (
              <label key={action}><input type="checkbox" checked={allowedActions.includes(action)} onChange={() => setAllowedActions((current) => current.includes(action) ? current.filter((value) => value !== action) : [...current, action])} /><span>{action}</span></label>
            ))}
          </fieldset>
          <button className="tf-btn tf-btn-primary" type="button" disabled={!canAuthorize || Boolean(busy)} onClick={() => void perform("authorize", async () => {
            if (!definition || !normalizedTarget) return;
            await createAuthorization({
              targets: [normalizedTarget], allowedActions,
              deniedActions: definition.authorizationActions.filter((action) => !allowedActions.includes(action)),
              approvedBy: approvedBy.trim(), expiresAt: expiryIso, notes: notes.trim() || undefined,
            });
          }, "授权已创建")}>创建授权</button>
        </details>
      </section>

      <section className="scenario-section">
        <header><Play size={13} /><strong>Scenario Run</strong>{run && <span className={`scenario-status is-${run.status}`}>{run.status}</span>}</header>
        {unavailableRun && (
          <div className="scenario-operation-alert">
            <Warning size={13} /><span>Run {unavailableRun.runId} 需要恢复：{unavailableRun.packageDiagnostic}</span>
          </div>
        )}
        {run && (
          <div className="scenario-run-summary">
            <div className="scenario-run-title"><strong>{phase?.title ?? run.activePhaseId}</strong><small>revision {run.revision}</small></div>
            <p>{run.goal}</p>
            <div className="scenario-run-metrics"><span>{progress?.completed ?? 0}/{progress?.total ?? 0} 完成</span><span>{progress?.active ?? 0} 活动</span><span>{progress?.waiting ?? 0} 等待</span></div>
            {run.blockedReason && <div className="scenario-operation-alert"><Warning size={13} /><span>{run.blockedReason}</span></div>}
            {run.suspension && <div className="scenario-operation-alert"><Pause size={13} /><span>{run.suspension.reason} · {new Date(run.suspension.pausedAt).toLocaleString()}</span></div>}
            {recovery && (
              <div className={`scenario-recovery ${recovery.projectionMatchesReplay ? "is-verified" : "is-warning"}`}>
                <strong>{recovery.projectionMatchesReplay ? "事件回放一致" : "恢复状态需检查"}</strong>
                <small>revision {recovery.runRevision} · {recovery.activeLeases.length} leases · {recovery.queuedCheckpointWorkIds.length} resumable · {recovery.pendingApprovalIds.length} approvals</small>
                {recovery.projectionIssues.map((issue) => <span key={issue}>{issue}</span>)}
              </div>
            )}
            {runIsControllable && <div className="scenario-run-actions">
              {runIsActive && <button className="tf-btn tf-btn-ghost" type="button" disabled={Boolean(busy)} onClick={() => void perform("pause", () => pauseRun("Operator paused the Scenario Run"), "运行已暂停")}><Pause size={12} weight="fill" />暂停</button>}
              {runIsPaused && <button className="tf-btn tf-btn-primary" type="button" disabled={Boolean(busy)} onClick={() => void perform("resume", () => resumeRun("Operator resumed the Scenario Run"), "运行已恢复")}><Play size={12} weight="fill" />恢复</button>}
              <button className="tf-btn tf-btn-danger" type="button" disabled={Boolean(busy)} onClick={() => {
                if (!confirm("取消后当前 Worker 租约和待审批动作都会终止，是否继续？")) return;
                void perform("cancel", () => cancelRun("Operator cancelled the Scenario Run"), "运行已取消");
              }}><Stop size={12} />取消运行</button>
            </div>}
          </div>
        )}
        {!runIsControllable && (
          <div className="scenario-run-launcher">
            <label><span>授权</span><select value={authorizationId} onChange={(event) => setAuthorizationId(event.target.value)}><option value="">选择有效授权</option>{activeAuthorizations.map((authorization) => <option key={authorization.id} value={authorization.id}>{authorization.scope.targets.join(", ")}</option>)}</select></label>
            <label><span>调查目标</span><textarea value={goal} onChange={(event) => setGoal(event.target.value)} placeholder="描述需要在授权范围内完成的安全调查目标" /></label>
            <button className="tf-btn tf-btn-primary" type="button" disabled={!definition || !authorizationId || !goal.trim() || Boolean(busy)} onClick={() => void perform("start", () => startRun(goal.trim(), authorizationId, definition!.version), "Scenario Run 已启动")}><Play size={12} weight="fill" />启动运行</button>
          </div>
        )}
      </section>

      {run && <ScenarioCollaborationView snapshot={collaboration} />}

      {run && (
        <section className="scenario-section scenario-work-section">
          <header><Clock size={13} /><strong>Work</strong><span>{run.workItems.length}</span></header>
          <div className="scenario-work-list">
            {run.workItems.length === 0 && <p>Planner 尚未生成 Work。</p>}
            {[...run.workItems].sort((left, right) => right.priority - left.priority).map((work) => (
              <article key={work.id} className={`scenario-work is-${work.status}`}>
                <div><span>{work.kind}</span><strong>{work.title}</strong><small>{work.workerId ?? work.allowedWorkerRoles.join(" / ")} · attempt {work.attempt}/{work.maxAttempts}</small></div>
                <em>{work.status}</em>
                {work.latestCheckpoint && <p>{work.latestCheckpoint.progressSummary}{work.resumeFromCheckpoint ? " · 等待从检查点恢复" : ""}</p>}
                {(work.error || work.resultSummary) && <p>{work.error ?? work.resultSummary}</p>}
              </article>
            ))}
          </div>
        </section>
      )}

      {approvals.length > 0 && (
        <section className="scenario-section scenario-approval-section">
          <header><Warning size={13} /><strong>待审批</strong><span>{approvals.length}</span></header>
          {approvals.map((approval) => (
            <article className="scenario-approval" key={approval.id}>
              <div className="scenario-approval-title"><strong>{approval.toolName}</strong><span>{approval.risk}</span></div>
              <p>{approval.rationale}</p>
              <small>Work {approval.workId} · Worker {approval.requestedByWorkerId}</small>
              <textarea value={approvalReasons[approval.id] ?? ""} onChange={(event) => setApprovalReasons((current) => ({ ...current, [approval.id]: event.target.value }))} placeholder="审批决定原因（必填）" />
              <div><button className="tf-btn tf-btn-primary" type="button" disabled={!approvalReasons[approval.id]?.trim() || Boolean(busy)} onClick={() => void perform(`approve:${approval.id}`, () => resolveApproval(approval.id, true, approvalReasons[approval.id].trim()), "动作已批准")}><Check size={12} />批准</button><button className="tf-btn tf-btn-danger" type="button" disabled={!approvalReasons[approval.id]?.trim() || Boolean(busy)} onClick={() => void perform(`reject:${approval.id}`, () => resolveApproval(approval.id, false, approvalReasons[approval.id].trim()), "动作已拒绝")}><X size={12} />拒绝</button></div>
            </article>
          ))}
        </section>
      )}
    </aside>
  );
}
