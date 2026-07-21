import type { Task } from "./schemas.js";

export interface ValidationWorkflowFeedback {
  toolBoundaries: number;
  evidenceProduced: number;
  consensusAdvances: number;
  attackPathAdvances: number;
  failures: number;
  noProgress: number;
  scoreAdjustment: number;
}

export interface ValidationWorkflowItem {
  findingId: string;
  findingTitle: string | null;
  findingStatus: string | null;
  consensusStatus: string;
  confidence: number;
  taskId: string | null;
  taskStatus: Task["status"] | null;
  priorityScore: number | null;
  priorityReasons: string[];
  completionReady: boolean;
  missingEvidence: string[];
  feedback: ValidationWorkflowFeedback | null;
}

export interface ValidationWorkflowSnapshot {
  caseId: string;
  runId: string | null;
  generatedAt: string;
  runningLease: string | null;
  leader: { taskId: string; score: number } | null;
  exploration: { consecutiveValidationShifts: number; explorationBoundariesRemaining: number };
  items: ValidationWorkflowItem[];
  auditIssues: Array<{ taskId: string; status: Task["status"]; issue: string }>;
}
