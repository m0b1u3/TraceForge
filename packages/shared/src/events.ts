import type { Case, TrafficEntry, Fact, Task, TimelineEntry, CandidateFact, ActionCard, Decision } from "./schemas.js";

export type RuntimeEvent =
  | { type: "case_created"; case: Case }
  | { type: "request_captured"; entry: TrafficEntry }
  | { type: "response_captured"; entry: TrafficEntry }
  | { type: "scope_violation"; caseId: string; url: string; reason: string }
  | { type: "fact_created"; fact: Fact }
  | { type: "task_created"; task: Task }
  | { type: "task_updated"; task: Task }
  | { type: "timeline_appended"; entry: TimelineEntry }
  | { type: "candidates_extracted"; caseId: string; candidates: CandidateFact[] }
  | { type: "action_candidates_generated"; caseId: string; candidates: ActionCard[] }
  | { type: "action_approved"; action: ActionCard }
  | { type: "decision_recorded"; decision: Decision }
  | { type: "agent_started"; caseId: string; goal: string }
  | { type: "agent_text"; caseId: string; content: string }
  | { type: "agent_tool_call"; caseId: string; tool: string; input: string }
  | { type: "agent_tool_result"; caseId: string; tool: string; content: string }
  | { type: "agent_done"; caseId: string; content: string }
  | { type: "agent_error"; caseId: string; content: string }
  | { type: "approval_requested"; caseId: string; approvalId: string; tool: string; input: string }
  | { type: "approval_resolved"; caseId: string; approvalId: string; decision: "approved" | "rejected" }
  | { type: "action_recorded"; action: ActionCard }
  | { type: "scope_expansion_proposed"; caseId: string; host: string; reason: string };
