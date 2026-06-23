import type { Case, TrafficEntry, Fact, Task, TimelineEntry, CandidateFact } from "./schemas.js";

export type RuntimeEvent =
  | { type: "case_created"; case: Case }
  | { type: "request_captured"; entry: TrafficEntry }
  | { type: "response_captured"; entry: TrafficEntry }
  | { type: "scope_violation"; caseId: string; url: string; reason: string }
  | { type: "fact_created"; fact: Fact }
  | { type: "task_created"; task: Task }
  | { type: "task_updated"; task: Task }
  | { type: "timeline_appended"; entry: TimelineEntry }
  | { type: "candidates_extracted"; caseId: string; candidates: CandidateFact[] };
