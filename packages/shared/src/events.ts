import type { Case, TrafficEntry, Fact, Task, TimelineEntry, CandidateFact, ActionCard, Decision, ObserverWarning, AgentRun, IdentityContext, AttackPath } from "./schemas.js";

export type RuntimeEvent =
  | { type: "case_created"; case: Case }
  | { type: "case_deleted"; caseId: string }
  | { type: "identity_created"; identity: IdentityContext }
  | { type: "identity_updated"; identity: IdentityContext }
  | { type: "attack_path_created"; attackPath: AttackPath }
  | { type: "attack_path_updated"; attackPath: AttackPath }
  | { type: "request_captured"; entry: TrafficEntry }
  | { type: "response_captured"; entry: TrafficEntry }
  | { type: "traffic_cleared"; caseId: string }
  | { type: "scope_violation"; caseId: string; url: string; reason: string }
  | { type: "fact_created"; fact: Fact }
  | { type: "fact_updated"; fact: Fact }
  | { type: "task_created"; task: Task }
  | { type: "task_updated"; task: Task }
  | { type: "timeline_appended"; entry: TimelineEntry }
  | { type: "candidates_extracted"; caseId: string; candidates: CandidateFact[] }
  | { type: "action_candidates_generated"; caseId: string; candidates: ActionCard[] }
  | { type: "action_approved"; action: ActionCard }
  | { type: "decision_recorded"; decision: Decision }
  | { type: "agent_started"; caseId: string; goal: string }
  | { type: "agent_text"; caseId: string; content: string }
  | { type: "agent_reasoning"; caseId: string; content: string }
  | { type: "agent_tool_call"; caseId: string; tool: string; input: string }
  | { type: "agent_tool_result"; caseId: string; tool: string; content: string }
  | { type: "agent_tool_blocked"; caseId: string; runId: string; tool: string; input: string; reason: string }
  | { type: "agent_done"; caseId: string; content: string }
  | { type: "agent_error"; caseId: string; content: string }
  | { type: "agent_run_started"; run: AgentRun }
  | { type: "agent_stream_start"; caseId: string; runId: string; messageId: string }
  | { type: "agent_stream_delta"; caseId: string; runId: string; messageId: string; delta: string }
  | { type: "agent_stream_end"; caseId: string; runId: string; messageId: string; content: string }
  | { type: "agent_retrying"; caseId: string; runId: string; attempt: number; maxAttempts: number; reason: string }
  | { type: "agent_steering_added"; caseId: string; runId: string; content: string }
  | { type: "agent_run_interrupted"; run: AgentRun }
  | { type: "agent_run_needs_confirmation"; caseId: string; runId: string; warning: ObserverWarning }
  | { type: "agent_run_needs_continuation"; run: AgentRun; reason: string }
  | { type: "agent_run_completed"; run: AgentRun; content: string }
  | { type: "agent_run_failed"; run: AgentRun; error: string }
  | { type: "agent_usage"; caseId: string; runId: string; usageId: string; turn: number; source: "agent" | "observer"; createdAt: string; promptTokens: number; completionTokens: number; totalTokens: number; currency: string | null; inputCostMicros: number | null; outputCostMicros: number | null; totalCostMicros: number | null; cumulativePromptTokens: number; cumulativeCompletionTokens: number; cumulativeTotalTokens: number }
  | { type: "approval_requested"; caseId: string; approvalId: string; tool: string; input: string }
  | { type: "approval_resolved"; caseId: string; approvalId: string; tool: string; decision: "approved" | "rejected" }
  | { type: "action_recorded"; action: ActionCard }
  | { type: "scope_expansion_proposed"; caseId: string; host: string; reason: string }
  | { type: "scope_expansion_rejected"; caseId: string; host: string }
  | { type: "browser_started"; caseId: string }
  | { type: "browser_stopped"; caseId: string }
  | { type: "browser_control_changed"; caseId: string; controller: "llm" | "human" }
  | { type: "browser_navigated"; caseId: string; url: string }
  | { type: "observer_warning"; warning: ObserverWarning }
  | { type: "observer_warning_updated"; warning: ObserverWarning }
  | {
      type: "observer_review_completed";
      caseId: string;
      runId: string;
      trigger: "interval" | "final" | "repeated_failure" | "high_risk" | "evidence_conflict" | "finding_verification";
      warningCount: number;
      correctionCount: number;
      durationMs: number;
      totalTokens: number;
    }
  | { type: "observer_review_failed"; caseId: string; runId: string | null; error: string }
  | { type: "scope_updated"; caseId: string; allowHosts: string[] };
