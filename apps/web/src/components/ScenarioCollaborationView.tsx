import { Brain, Cpu, Eye, Graph } from "@phosphor-icons/react";
import type {
  ObserverDecision,
  PlannerDecision,
  ScenarioCollaborationSnapshot,
  WorkerHealth,
} from "../api.js";

type CognitiveDecision = PlannerDecision | ObserverDecision;

export function cognitiveDecisionSummary(decision: CognitiveDecision): string {
  if ("rationale" in decision) return decision.rationale;
  return decision.reason;
}

export function formatHeartbeatAge(ageMs: number | null): string {
  if (ageMs === null) return "时间异常";
  if (ageMs < 1_000) return "刚刚";
  if (ageMs < 60_000) return `${Math.floor(ageMs / 1_000)}s 前`;
  return `${Math.floor(ageMs / 60_000)}m 前`;
}

const healthLabels: Record<WorkerHealth, string> = {
  healthy: "healthy",
  stale: "stale",
  draining: "draining",
  offline: "offline",
};

export function ScenarioCollaborationView({ snapshot }: { snapshot: ScenarioCollaborationSnapshot | null }) {
  if (!snapshot) {
    return (
      <section className="scenario-section scenario-collaboration-section">
        <header><Brain size={13} /><strong>Agent 协同</strong><span>loading</span></header>
        <p className="scenario-collaboration-empty">正在装配协同运行快照。</p>
      </section>
    );
  }
  const planner = snapshot.agents.planner;
  const observer = snapshot.agents.observer;
  const latestPlanner = planner.evaluations[0];
  const latestObserver = observer.evaluations[0];
  const linkedWorks = snapshot.workLinks.filter((link) => link.linkedNodeIds.length > 0).length;

  return (
    <section className="scenario-section scenario-collaboration-section">
      <header><Brain size={13} /><strong>Agent 协同</strong><span>graph r{snapshot.graphRevision}</span></header>

      <div className="scenario-cognitive-grid">
        <article className={`scenario-cognitive-agent is-${planner.status}`}>
          <div><Brain size={14} /><strong>Planner</strong><span>{planner.status}</span></div>
          {latestPlanner
            ? <><em>{latestPlanner.decision.action}</em><p>{cognitiveDecisionSummary(latestPlanner.decision)}</p><small>{planner.evaluationCount} 次评估 · Run r{latestPlanner.resultingRunRevision ?? latestPlanner.observedRunRevision}</small></>
            : <p>等待可规划的状态差分。</p>}
        </article>
        <article className={`scenario-cognitive-agent is-${observer.status}`}>
          <div><Eye size={14} /><strong>Observer</strong><span>{observer.status}</span></div>
          {latestObserver
            ? <><em>{latestObserver.decision.action}</em><p>{cognitiveDecisionSummary(latestObserver.decision)}</p><small>{observer.evaluationCount} 次评估 · Run r{latestObserver.resultingRunRevision ?? latestObserver.observedRunRevision}</small></>
            : <p>等待首个独立观察周期。</p>}
        </article>
      </div>

      <div className="scenario-collaboration-group">
        <div className="scenario-collaboration-label"><Cpu size={12} /><strong>Worker 平面</strong><span>{snapshot.workers.filter((worker) => worker.health === "healthy").length}/{snapshot.workers.length} healthy</span></div>
        <div className="scenario-pool-grid">
          {snapshot.workerPools.map((pool) => (
            <article key={pool.id} className="scenario-pool">
              <div><strong>{pool.role}</strong><span>{pool.activation}</span></div>
              <small>{pool.healthyCount}/{pool.registeredCount} healthy · {pool.activeLeases} lease</small>
              <p>{pool.queuedWork} queued · {pool.runningWork} running · max {pool.maximumInstances}</p>
            </article>
          ))}
        </div>
        <div className="scenario-worker-list">
          {snapshot.workers.length === 0 && <p>尚无已注册 Worker。</p>}
          {snapshot.workers.map((worker) => (
            <article key={worker.id} className={`scenario-worker is-${worker.health}`}>
              <div><strong>{worker.id}</strong><span>{healthLabels[worker.health]}</span></div>
              <small>{worker.roles.join(" / ")} · heartbeat {formatHeartbeatAge(worker.heartbeatAgeMs)}</small>
              <p>{worker.activeWork}/{worker.maxConcurrentWork} active · {worker.availableSlots} slots</p>
              {worker.runLeases.map((lease) => <em key={lease.leaseId}>{lease.workId} · {lease.expired ? "expired" : `${Math.max(0, Math.ceil(lease.expiresInMs / 1_000))}s lease`}</em>)}
            </article>
          ))}
        </div>
      </div>

      <div className="scenario-collaboration-group">
        <div className="scenario-collaboration-label"><Graph size={12} /><strong>知识与证据关联</strong><span>{snapshot.knowledge.totalNodes} nodes · {snapshot.knowledge.totalEdges} edges</span></div>
        <div className="scenario-knowledge-metrics">
          {Object.entries(snapshot.knowledge.countsByKind).sort(([left], [right]) => left.localeCompare(right)).map(([kind, count]) => <span key={kind}>{kind} <strong>{count}</strong></span>)}
        </div>
        <div className="scenario-knowledge-list">
          {snapshot.knowledge.nodes.slice(0, 8).map((node) => (
            <article key={node.id}><span>{node.kind}</span><strong>{node.title}</strong><em>{node.status} · {Math.round(node.confidence * 100)}%</em></article>
          ))}
        </div>
        <small className="scenario-link-coverage">{linkedWorks}/{snapshot.workLinks.length} Work 已连接图谱节点{snapshot.knowledge.truncated ? " · 当前为有界视图" : ""}</small>
      </div>
    </section>
  );
}
