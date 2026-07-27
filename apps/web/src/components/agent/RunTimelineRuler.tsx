import { useMemo } from "react";
import type { Fact } from "@traceforge/shared";
import { useStore, type AgentUiEvent } from "../../store.js";

export type RulerTick = {
  key: string;
  kind: "tool" | "finding" | "approval";
  position: number;
  label: string;
  eventIndex: number | null;
  factId?: string;
};

type PendingApproval = { approvalId: string; tool: string; input: string };
type PendingScope = { host: string; reason: string };

export function rulerToolName(text: string): string {
  const match = /^\s*([A-Za-z0-9_:-]+)\s*[({→]/.exec(text);
  if (match) return match[1];
  return text.trim().split(/\s+/)[0] || "tool";
}

function eventTime(event: AgentUiEvent): number | null {
  if (!event.createdAt) return null;
  const time = Date.parse(event.createdAt);
  return Number.isFinite(time) ? time : null;
}

export function buildRulerTicks({
  events,
  facts,
  pendingApproval = null,
  pendingScope = null,
}: {
  events: AgentUiEvent[];
  facts: Fact[];
  pendingApproval?: PendingApproval | null;
  pendingScope?: PendingScope | null;
}): RulerTick[] {
  const ticks: RulerTick[] = [];
  const times = events.map(eventTime);
  const validTimes = times.filter((time): time is number => time !== null);
  const t0 = validTimes.length > 0 ? Math.min(...validTimes) : null;
  const t1 = validTimes.length > 0 ? Math.max(...validTimes) : null;
  const span = t0 !== null && t1 !== null && t1 > t0 ? t1 - t0 : null;

  const eventPosition = (index: number): number => {
    const time = times[index];
    if (span !== null && time !== null) return Math.min(1, Math.max(0, (time - t0!) / span));
    if (events.length <= 1) return 1;
    return index / (events.length - 1);
  };
  const timePosition = (iso: string): number => {
    const time = Date.parse(iso);
    if (span === null || !Number.isFinite(time)) return 1;
    return Math.min(1, Math.max(0, (time - t0!) / span));
  };

  events.forEach((event, index) => {
    if (event.kind !== "tool_call") return;
    ticks.push({
      key: `tool-${index}`,
      kind: "tool",
      position: eventPosition(index),
      label: rulerToolName(event.text),
      eventIndex: index,
    });
  });

  for (const fact of facts) {
    ticks.push({
      key: `finding-${fact.id}`,
      kind: "finding",
      position: timePosition(fact.createdAt),
      label: fact.title,
      eventIndex: null,
      factId: fact.id,
    });
  }

  if (pendingApproval) {
    ticks.push({ key: `approval-${pendingApproval.approvalId}`, kind: "approval", position: 1, label: pendingApproval.tool, eventIndex: null });
  }
  if (pendingScope) {
    ticks.push({ key: `scope-${pendingScope.host}`, kind: "approval", position: 1, label: `scope: ${pendingScope.host}`, eventIndex: null });
  }

  return ticks;
}

export function RunTimelineRuler({
  events,
  facts,
  pendingApproval,
  pendingScope,
  onJump,
}: {
  events: AgentUiEvent[];
  facts: Fact[];
  pendingApproval: PendingApproval | null;
  pendingScope: PendingScope | null;
  onJump: (eventIndex: number) => void;
}) {
  const selectFact = useStore((state) => state.selectFact);
  const ticks = useMemo(
    () => buildRulerTicks({ events, facts, pendingApproval, pendingScope }),
    [events, facts, pendingApproval, pendingScope],
  );
  if (ticks.length === 0) return null;
  return (
    <div className="run-ruler" aria-label="Run timeline">
      <div className="run-ruler-track">
        {ticks.map((tick) => (
          <button
            key={tick.key}
            type="button"
            className={`run-ruler-tick is-${tick.kind}`}
            style={{ left: `${tick.position * 100}%` }}
            title={tick.label}
            aria-label={tick.kind === "finding" ? `Finding: ${tick.label}` : tick.kind === "approval" ? `Pending approval: ${tick.label}` : `Tool call: ${tick.label}`}
            onClick={() => {
              if (tick.kind === "finding" && tick.factId) selectFact(tick.factId);
              else if (tick.eventIndex !== null) onJump(tick.eventIndex);
            }}
          />
        ))}
      </div>
    </div>
  );
}
