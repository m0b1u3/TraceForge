import type { Case } from "./schemas.js";
import type { ScenarioAgentEvent } from "./scenario-agent-events.js";

export type RuntimeEvent =
  | { type: "scenario_agent_event"; event: ScenarioAgentEvent }
  | { type: "case_created"; case: Case }
  | { type: "case_deleted"; caseId: string };
