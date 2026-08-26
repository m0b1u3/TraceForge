import type { Case, TrafficEntry, Fact, Task, TimelineEntry, CandidateFact, ActionCard, Decision, ObserverWarning, ObserverStrategyAudit, IdentityContext, AttackPath, SecurityReport, Hypothesis, HypothesisTransition } from "./schemas.js";
import type { ValidationWorkflowSnapshot } from "./validation-workflow.js";
import type { ArtifactRecord } from "./artifact.js";
import type { ArtifactConsumption } from "./artifact-consumption.js";
import type { ArtifactAnalysisAttempt } from "./artifact-analysis-attempt.js";
import type { ArtifactLimitationDisposition } from "./artifact-limitation.js";
import type { ArtifactRetryAuthorization } from "./artifact-retry-authorization.js";
import type { ArtifactRecovery } from "./artifact-recovery.js";
import type { ScenarioAgentEvent } from "./scenario-agent-events.js";

export type RuntimeEvent =
  | { type: "scenario_agent_event"; event: ScenarioAgentEvent }
  | { type: "case_created"; case: Case }
  | { type: "case_deleted"; caseId: string }
  | { type: "identity_created"; identity: IdentityContext }
  | { type: "identity_updated"; identity: IdentityContext }
  | { type: "attack_path_created"; attackPath: AttackPath }
  | { type: "attack_path_updated"; attackPath: AttackPath }
  | { type: "security_report_created"; report: SecurityReport }
  | { type: "security_report_updated"; report: SecurityReport }
  | { type: "request_captured"; entry: TrafficEntry }
  | { type: "response_captured"; entry: TrafficEntry }
  | { type: "traffic_cleared"; caseId: string }
  | { type: "scope_violation"; caseId: string; url: string; reason: string }
  | { type: "fact_created"; fact: Fact }
  | { type: "fact_updated"; fact: Fact }
  | { type: "artifact_updated"; artifact: ArtifactRecord }
  | { type: "artifact_consumption_snapshot"; caseId: string; consumptions: ArtifactConsumption[] }
  | { type: "artifact_analysis_attempt_updated"; attempt: ArtifactAnalysisAttempt }
  | { type: "artifact_limitation_updated"; disposition: ArtifactLimitationDisposition }
  | { type: "artifact_retry_authorization_updated"; authorization: ArtifactRetryAuthorization }
  | { type: "artifact_recovery_updated"; recovery: ArtifactRecovery }
  | { type: "task_created"; task: Task }
  | { type: "task_updated"; task: Task }
  | { type: "hypothesis_created"; hypothesis: Hypothesis; transition: HypothesisTransition }
  | { type: "hypothesis_updated"; hypothesis: Hypothesis; transition: HypothesisTransition }
  | { type: "timeline_appended"; entry: TimelineEntry }
  | { type: "validation_workflow_updated"; snapshot: ValidationWorkflowSnapshot }
  | { type: "candidates_extracted"; caseId: string; candidates: CandidateFact[] }
  | { type: "action_candidates_generated"; caseId: string; candidates: ActionCard[] }
  | { type: "action_approved"; action: ActionCard }
  | { type: "decision_recorded"; decision: Decision }
  | { type: "approval_requested"; caseId: string; approvalId: string; tool: string; input: string }
  | { type: "approval_resolved"; caseId: string; approvalId: string; tool: string; decision: "approved" | "rejected" }
  | { type: "action_recorded"; action: ActionCard }
  | { type: "scope_expansion_proposed"; caseId: string; host: string; reason: string }
  | { type: "scope_expansion_rejected"; caseId: string; host: string }
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
      strategyAudit: ObserverStrategyAudit;
    }
  | { type: "observer_review_failed"; caseId: string; runId: string | null; error: string; strategyAudit?: ObserverStrategyAudit }
  | { type: "scope_updated"; caseId: string; allowHosts: string[] };
