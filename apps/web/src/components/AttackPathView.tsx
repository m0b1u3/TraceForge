import { useEffect, useMemo, useState } from "react";
import {
  ArrowRight,
  CheckCircle,
  Circle,
  Database,
  Flag,
  GitBranch,
  Globe,
  LockKey,
  ShieldCheck,
  UserCircle,
  WarningCircle,
  XCircle,
} from "@phosphor-icons/react";
import type { AttackPath, AttackPathStep } from "@traceforge/shared";
import { useShallow } from "zustand/react/shallow";
import { useStore } from "../store.js";
import { FeedbackState } from "./ui/feedback-state.js";

const STATUS_LABEL: Record<AttackPath["status"], string> = {
  exploring: "Exploring",
  blocked: "Blocked",
  validated: "Validated",
  invalidated: "Invalidated",
};

const STEP_STATUS_ICON = {
  proposed: Circle,
  observed: Globe,
  verified: CheckCircle,
  blocked: WarningCircle,
  refuted: XCircle,
} satisfies Record<AttackPathStep["status"], typeof Circle>;

function shortId(value: string | null | undefined) {
  if (!value) return "—";
  return value.length <= 18 ? value : `${value.slice(0, 10)}…${value.slice(-5)}`;
}

function PathIndexItem({ path, selected, onSelect }: { path: AttackPath; selected: boolean; onSelect: () => void }) {
  const verified = path.steps.filter((step) => step.status === "verified").length;
  return (
    <button
      type="button"
      className="attack-path-index-item"
      data-selected={selected}
      onClick={onSelect}
      aria-pressed={selected}
    >
      <span className="attack-path-index-status" data-status={path.status}>{STATUS_LABEL[path.status]}</span>
      <strong>{path.title}</strong>
      <span className="attack-path-index-meta">
        <span>{verified}/{path.steps.length} verified</span>
        <span>v{path.version}</span>
      </span>
    </button>
  );
}

function StepRow({
  step,
  identityName,
  selected,
  onSelect,
  terminal,
}: {
  step: AttackPathStep;
  identityName: string | null;
  selected: boolean;
  onSelect: () => void;
  terminal: boolean;
}) {
  const Icon = STEP_STATUS_ICON[step.status];
  return (
    <button
      type="button"
      className="attack-path-step"
      data-status={step.status}
      data-selected={selected}
      onClick={onSelect}
      aria-pressed={selected}
    >
      <span className="attack-path-step-rail" aria-hidden="true">
        <span className="attack-path-step-node"><Icon size={15} weight={step.status === "verified" ? "fill" : "regular"} /></span>
        {!terminal && <span className="attack-path-step-line" />}
      </span>
      <span className="attack-path-step-copy">
        <span className="attack-path-step-head">
          <span className="attack-path-step-order">{String(step.order + 1).padStart(2, "0")}</span>
          <span className="attack-path-step-kind">{step.kind.replace("_", " ")}</span>
          <span className="attack-path-step-state">{step.status}</span>
        </span>
        <strong>{step.title}</strong>
        {step.description && <span className="attack-path-step-description">{step.description}</span>}
        <span className="attack-path-step-context">
          {identityName && <span><UserCircle size={13} />{identityName}</span>}
          {step.trafficId && <span><Globe size={13} />Request attached</span>}
          {step.factIds.length > 0 && <span><Database size={13} />{step.factIds.length} evidence</span>}
        </span>
      </span>
    </button>
  );
}

function EvidenceInspector({ path, step }: { path: AttackPath; step: AttackPathStep }) {
  const { facts, traffic, identities, tasks } = useStore(useShallow((state) => ({
    facts: state.facts,
    traffic: state.traffic,
    identities: state.identities,
    tasks: state.tasks,
  })));
  const identity = identities.find((item) => item.id === step.identityId);
  const request = traffic.find((item) => item.id === step.trafficId);
  const task = tasks.find((item) => item.id === step.taskId);
  const evidence = step.factIds.map((id) => facts.find((fact) => fact.id === id)).filter((fact) => fact !== undefined);

  return (
    <aside className="attack-path-evidence" aria-label="Selected path step evidence">
      <div className="attack-path-evidence-heading">
        <span className="section-kicker">Step evidence</span>
        <strong>{step.title}</strong>
        <code>{step.id}</code>
      </div>

      <dl className="attack-path-evidence-kv">
        <div><dt>Status</dt><dd data-status={step.status}>{step.status}</dd></div>
        <div><dt>Identity</dt><dd>{identity?.name ?? shortId(step.identityId)}</dd></div>
        <div><dt>Task</dt><dd>{task?.title ?? shortId(step.taskId)}</dd></div>
        <div><dt>Action</dt><dd>{shortId(step.actionId)}</dd></div>
      </dl>

      {request && (
        <section className="attack-path-request">
          <span className="attack-path-section-label"><Globe size={13} />Request</span>
          <strong><code>{request.method}</code> {request.url}</strong>
          <span><code>{request.responseStatus ?? "—"}</code> · {request.identityId ? "attributed" : "unattributed"}</span>
        </section>
      )}

      <section className="attack-path-evidence-list">
        <span className="attack-path-section-label"><Database size={13} />Evidence</span>
        {evidence.length > 0 ? evidence.map((fact) => (
          <div key={fact.id} className="attack-path-evidence-row">
            <span>{fact.type}</span>
            <strong>{fact.title}</strong>
            <code>{shortId(fact.id)}</code>
          </div>
        )) : <p>No evidence Fact is attached to this step.</p>}
      </section>

      <section className="attack-path-validation">
        <span className="attack-path-section-label"><ShieldCheck size={13} />Validation</span>
        <p>{step.validation || "This step has not been independently validated."}</p>
      </section>

      <footer className="attack-path-provenance">
        <div><span>Origin run</span><code>{shortId(path.sourceRunId)}</code></div>
        <ArrowRight size={13} />
        <div><span>Last advanced</span><code>{shortId(path.lastRunId)}</code></div>
      </footer>
    </aside>
  );
}

export function AttackPathView() {
  const { paths, identities, facts } = useStore(useShallow((state) => ({
    paths: state.attackPaths,
    identities: state.identities,
    facts: state.facts,
  })));
  const [selectedPathId, setSelectedPathId] = useState<string | null>(null);
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);
  const selectedPath = paths.find((path) => path.id === selectedPathId) ?? paths[0] ?? null;
  const orderedSteps = useMemo(() => selectedPath ? [...selectedPath.steps].sort((a, b) => a.order - b.order) : [], [selectedPath]);
  const selectedStep = orderedSteps.find((step) => step.id === selectedStepId) ?? orderedSteps[0] ?? null;
  const identityById = useMemo(() => new Map(identities.map((identity) => [identity.id, identity.name])), [identities]);
  const target = selectedPath?.targetAssetFactId ? facts.find((fact) => fact.id === selectedPath.targetAssetFactId) : null;

  useEffect(() => {
    if (!selectedPathId && paths[0]) setSelectedPathId(paths[0].id);
  }, [paths, selectedPathId]);

  useEffect(() => {
    if (selectedPath && !selectedPath.steps.some((step) => step.id === selectedStepId)) {
      setSelectedStepId([...selectedPath.steps].sort((a, b) => a.order - b.order)[0]?.id ?? null);
    }
  }, [selectedPath, selectedStepId]);

  if (!selectedPath || !selectedStep) {
    return (
      <div className="attack-path-empty">
        <GitBranch size={24} weight="duotone" aria-hidden="true" />
        <FeedbackState
          title="No attack path recorded"
          description="The Agent will create a path after it can connect a hypothesis to an identity, target, and evidence-backed step."
        />
        <div className="attack-path-empty-sequence" aria-label="Attack path evidence sequence">
          <span>Hypothesis</span><ArrowRight size={12} /><span>Identity</span><ArrowRight size={12} /><span>Evidence</span><ArrowRight size={12} /><span>Verified path</span>
        </div>
      </div>
    );
  }

  return (
    <div className="attack-path-workbench">
      <nav className="attack-path-index" aria-label="Attack paths">
        <div className="attack-path-index-heading">
          <GitBranch size={15} />
          <span>Paths</span>
          <strong>{paths.length}</strong>
        </div>
        <div className="attack-path-index-list">
          {paths.map((path) => (
            <PathIndexItem
              key={path.id}
              path={path}
              selected={path.id === selectedPath.id}
              onSelect={() => {
                setSelectedPathId(path.id);
                setSelectedStepId(null);
              }}
            />
          ))}
        </div>
      </nav>

      <main className="attack-path-chain">
        <header className="attack-path-chain-header">
          <div>
            <span className="section-kicker">Attack path · {STATUS_LABEL[selectedPath.status]}</span>
            <h3>{selectedPath.title}</h3>
            <p>{selectedPath.objective}</p>
          </div>
          <div className="attack-path-chain-metrics">
            <span><Target size={13} />{target?.title ?? "Target unresolved"}</span>
            <span><LockKey size={13} />{identityById.get(selectedPath.entryIdentityId ?? "") ?? "No entry identity"}</span>
            <span><Flag size={13} />{Math.round(selectedPath.confidence * 100)}% confidence</span>
          </div>
        </header>

        {selectedPath.breakpoint && (
          <div className="attack-path-breakpoint">
            <WarningCircle size={15} />
            <div><span>Current breakpoint</span><strong>{selectedPath.breakpoint}</strong></div>
          </div>
        )}

        <div className="attack-path-step-list">
          {orderedSteps.map((step, index) => (
            <StepRow
              key={step.id}
              step={step}
              identityName={identityById.get(step.identityId ?? "") ?? null}
              selected={step.id === selectedStep.id}
              onSelect={() => setSelectedStepId(step.id)}
              terminal={index === orderedSteps.length - 1}
            />
          ))}
        </div>
      </main>

      <EvidenceInspector path={selectedPath} step={selectedStep} />
    </div>
  );
}
