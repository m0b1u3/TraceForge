import type { ScenarioDefinition, ScenarioWorkItem } from "./model.js";

export const WEB_BLACKBOX_CAPABILITIES = {
  scopeRead: "scope.read",
  evidenceWrite: "evidence.write",
  browserNavigate: "web.browser.navigate",
  trafficRead: "web.traffic.read",
  requestReplay: "web.request.replay",
  artifactAnalyze: "artifact.analyze",
  reportWrite: "report.write",
} as const;

export const WEB_BLACKBOX_ACTIONS = {
  scopeRead: WEB_BLACKBOX_CAPABILITIES.scopeRead,
  evidenceWrite: WEB_BLACKBOX_CAPABILITIES.evidenceWrite,
  browserNavigate: WEB_BLACKBOX_CAPABILITIES.browserNavigate,
  trafficRead: WEB_BLACKBOX_CAPABILITIES.trafficRead,
  requestReplay: WEB_BLACKBOX_CAPABILITIES.requestReplay,
  artifactAnalyze: WEB_BLACKBOX_CAPABILITIES.artifactAnalyze,
  reportWrite: WEB_BLACKBOX_CAPABILITIES.reportWrite,
} as const;

export const WEB_BLACKBOX_SCENARIO: ScenarioDefinition = {
  kind: "web_blackbox",
  version: 1,
  title: "Web black-box security investigation",
  authorizationActions: Object.values(WEB_BLACKBOX_ACTIONS),
  requiredCapabilities: [WEB_BLACKBOX_CAPABILITIES.scopeRead, WEB_BLACKBOX_CAPABILITIES.evidenceWrite],
  initialPhaseId: "scope_setup",
  agentTopology: {
    planner: {
      enabled: true,
      pollIntervalMs: 30_000,
      maximumGraphNodes: 200,
      maximumRecentEvents: 40,
      maximumRunItems: 100,
      maximumProposalsPerEvaluation: 4,
    },
    observer: { enabled: true, pollIntervalMs: 30_000, maximumGraphNodes: 200, maximumRecentEvents: 40, maximumRunItems: 100 },
    workerPools: [
      {
        id: "web-research",
        role: "researcher",
        activation: "resident",
        minimumInstances: 1,
        maximumInstances: 4,
        maxConcurrentWork: 1,
        capabilities: [
          WEB_BLACKBOX_CAPABILITIES.scopeRead, WEB_BLACKBOX_CAPABILITIES.evidenceWrite,
          WEB_BLACKBOX_CAPABILITIES.browserNavigate, WEB_BLACKBOX_CAPABILITIES.trafficRead,
          WEB_BLACKBOX_CAPABILITIES.requestReplay, "knowledge.graph.read", "knowledge.graph.write",
        ],
      },
      {
        id: "web-validation",
        role: "validator",
        activation: "on_demand",
        minimumInstances: 0,
        maximumInstances: 1,
        maxConcurrentWork: 1,
        capabilities: [
          WEB_BLACKBOX_CAPABILITIES.scopeRead, WEB_BLACKBOX_CAPABILITIES.evidenceWrite,
          WEB_BLACKBOX_CAPABILITIES.browserNavigate, WEB_BLACKBOX_CAPABILITIES.trafficRead,
          WEB_BLACKBOX_CAPABILITIES.requestReplay, "knowledge.graph.read", "knowledge.graph.write",
        ],
      },
      {
        id: "web-review",
        role: "reviewer",
        activation: "on_demand",
        minimumInstances: 0,
        maximumInstances: 1,
        maxConcurrentWork: 1,
        capabilities: [WEB_BLACKBOX_CAPABILITIES.evidenceWrite, WEB_BLACKBOX_CAPABILITIES.trafficRead, "knowledge.graph.read", "knowledge.graph.write"],
      },
      {
        id: "web-report",
        role: "reporter",
        activation: "on_demand",
        minimumInstances: 0,
        maximumInstances: 1,
        maxConcurrentWork: 1,
        capabilities: [WEB_BLACKBOX_CAPABILITIES.reportWrite, "knowledge.graph.read"],
      },
    ],
  },
  phases: [
    {
      id: "scope_setup",
      title: "Scope and execution setup",
      objective: "Bind the authorized target scope and record the capabilities and limitations available to this run.",
      allowedWorkKinds: ["research", "review"],
      maxParallelWork: 1,
      requiredCapabilities: [WEB_BLACKBOX_CAPABILITIES.scopeRead],
      transitions: [{
        to: "surface_mapping",
        allOf: [{ kind: "scope_snapshot" }, { kind: "capability_inventory" }],
      }],
    },
    {
      id: "surface_mapping",
      title: "Authorized surface mapping",
      objective: "Collect attributable observations and explicitly assess the coverage reached by available methods.",
      allowedWorkKinds: ["research", "review"],
      maxParallelWork: 4,
      requiredCapabilities: [WEB_BLACKBOX_CAPABILITIES.trafficRead],
      transitions: [{
        to: "hypothesis_planning",
        allOf: [{ kind: "surface_observation" }, { kind: "coverage_assessment" }],
      }],
    },
    {
      id: "hypothesis_planning",
      title: "Hypothesis planning",
      objective: "Preserve distinct candidates, rank their evidence gaps, and propose bounded validation work.",
      allowedWorkKinds: ["research", "review"],
      maxParallelWork: 3,
      requiredCapabilities: [WEB_BLACKBOX_CAPABILITIES.evidenceWrite],
      transitions: [
        { to: "validation", allOf: [{ kind: "hypothesis" }] },
        { to: "synthesis", allOf: [{ kind: "coverage_assessment" }], noneOf: [{ kind: "hypothesis" }] },
      ],
    },
    {
      id: "validation",
      title: "Causal validation",
      objective: "Execute one validation task at a time and record reproducible causal evidence, impact, refutation, or explicit limitations.",
      allowedWorkKinds: ["research", "validation", "review"],
      maxParallelWork: 3,
      requiredCapabilities: [WEB_BLACKBOX_CAPABILITIES.evidenceWrite],
      transitions: [{
        to: "synthesis",
        anyOf: [{ kind: "validation_conclusion" }, { kind: "limitation" }],
        noOutstandingWorkKinds: ["validation"],
      }],
    },
    {
      id: "synthesis",
      title: "Evidence and coverage review",
      objective: "Review attribution, conflicts, unresolved hypotheses, limitations, and whether conclusions are supported by complete evidence chains.",
      allowedWorkKinds: ["review"],
      maxParallelWork: 1,
      requiredCapabilities: [WEB_BLACKBOX_CAPABILITIES.evidenceWrite],
      transitions: [{ to: "reporting", allOf: [{ kind: "evidence_review" }] }],
    },
    {
      id: "reporting",
      title: "Report assembly",
      objective: "Produce a traceable report that separates verified findings, rejected candidates, unresolved work, scope, and limitations.",
      allowedWorkKinds: ["report"],
      maxParallelWork: 1,
      requiredCapabilities: [WEB_BLACKBOX_CAPABILITIES.reportWrite],
      transitions: [{ to: "complete", allOf: [{ kind: "report" }] }],
    },
  ],
};

export function rankQueuedWork(workItems: ScenarioWorkItem[]): ScenarioWorkItem[] {
  return workItems
    .filter((work) => work.status === "queued")
    .sort((left, right) => right.priority - left.priority || left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
}
