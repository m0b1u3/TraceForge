import { describe, expect, it } from "vitest";
import { evolve, ScenarioKernel } from "./kernel.js";
import type { ScenarioEvent, ScenarioOutputKind, ScenarioRunState, WorkKind } from "./model.js";
import { WEB_BLACKBOX_CAPABILITIES, WEB_BLACKBOX_SCENARIO } from "./web-blackbox.js";

const at = (step: number) => `2026-08-24T00:00:${String(step).padStart(2, "0")}.000Z`;
const capabilities = Object.values(WEB_BLACKBOX_CAPABILITIES);

function start(kernel = new ScenarioKernel(WEB_BLACKBOX_SCENARIO)): ScenarioRunState {
  return kernel.execute(undefined, {
    type: "start_run",
    runId: "scenario_run_1",
    caseId: "case_1",
    goal: "Assess the authorized web surface",
    scopeRef: "scope_1",
    availableCapabilities: capabilities,
    at: at(0),
  }).state;
}

function proposeClaimComplete(
  kernel: ScenarioKernel,
  state: ScenarioRunState,
  input: { id: string; kind: WorkKind; outputKinds: ScenarioOutputKind[]; hypothesisIds?: string[]; step: number },
): ScenarioRunState {
  let next = kernel.execute(state, {
    type: "propose_work",
    proposal: {
      id: input.id,
      kind: input.kind,
      title: `work ${input.id}`,
      objective: `objective ${input.id}`,
      idempotencyKey: `effect_${input.id}`,
      hypothesisIds: input.hypothesisIds,
    },
    at: at(input.step),
  }).state;
  next = kernel.execute(next, {
    type: "claim_work",
    workId: input.id,
    workerId: `worker_${input.id}`,
    workerRoles: input.kind === "validation" ? ["validator"] : input.kind === "review" ? ["reviewer"] : input.kind === "report" ? ["reporter"] : ["researcher"],
    workerCapabilities: capabilities,
    workerCurrentWork: 0,
    workerMaxConcurrentWork: 1,
    leaseId: `lease_${input.id}`,
    leaseExpiresAt: at(input.step + 9),
    at: at(input.step + 1),
  }).state;
  return kernel.execute(next, {
    type: "complete_work",
    workId: input.id,
    leaseId: `lease_${input.id}`,
    summary: `completed ${input.id}`,
    outputs: input.outputKinds.map((kind, index) => ({
      id: `output_${input.id}_${index}`,
      kind,
      summary: `${kind} from ${input.id}`,
      refs: [`ref_${input.id}_${index}`],
      createdAt: at(input.step + 2),
    })),
    at: at(input.step + 2),
  }).state;
}

function enterSurfaceMapping(kernel: ScenarioKernel, initial = start(kernel)): ScenarioRunState {
  const completed = proposeClaimComplete(kernel, initial, {
    id: "scope_work",
    kind: "research",
    outputKinds: ["scope_snapshot", "capability_inventory"],
    step: 1,
  });
  return kernel.execute(completed, { type: "advance_phase", to: "surface_mapping", at: at(4) }).state;
}

function enterHypothesisPlanning(kernel: ScenarioKernel): ScenarioRunState {
  const surface = proposeClaimComplete(kernel, enterSurfaceMapping(kernel), {
    id: "surface_work",
    kind: "research",
    outputKinds: ["surface_observation", "coverage_assessment"],
    step: 5,
  });
  return kernel.execute(surface, { type: "advance_phase", to: "hypothesis_planning", at: at(8) }).state;
}

describe("ScenarioKernel web black-box orchestration", () => {
  it("records Observer steering as an auditable Run directive", () => {
    const kernel = new ScenarioKernel(WEB_BLACKBOX_SCENARIO);
    let state = start(kernel);
    state = kernel.execute(state, {
      type: "propose_work",
      proposal: { id: "work_1", kind: "research", title: "Map", objective: "Map scope", idempotencyKey: "effect_1" },
      at: at(1),
    }).state;
    state = kernel.execute(state, {
      type: "issue_directive",
      directive: { id: "directive_1", kind: "steer", targetWorkId: "work_1", instruction: "Reassess coverage", rationale: "No state delta", issuedBy: "observer" },
      at: at(2),
    }).state;
    expect(state.directives).toEqual([expect.objectContaining({ id: "directive_1", targetWorkId: "work_1" })]);
  });

  it("fails before execution when the scenario lacks required capabilities", () => {
    const kernel = new ScenarioKernel(WEB_BLACKBOX_SCENARIO);
    expect(() => kernel.execute(undefined, {
      type: "start_run",
      runId: "run_missing",
      caseId: "case_1",
      goal: "Assess target",
      scopeRef: "scope_1",
      availableCapabilities: [WEB_BLACKBOX_CAPABILITIES.scopeRead],
      at: at(0),
    })).toThrow(/missing capabilities: evidence\.write/);
  });

  it("requires phase-local outputs before advancing", () => {
    const kernel = new ScenarioKernel(WEB_BLACKBOX_SCENARIO);
    const state = start(kernel);
    expect(() => kernel.execute(state, { type: "advance_phase", to: "surface_mapping", at: at(1) }))
      .toThrow(/requires 1 scope_snapshot.*requires 1 capability_inventory/);
    expect(enterSurfaceMapping(kernel).activePhaseId).toBe("surface_mapping");
  });

  it("replays emitted events into the same deterministic aggregate", () => {
    const kernel = new ScenarioKernel(WEB_BLACKBOX_SCENARIO);
    const started = kernel.execute(undefined, {
      type: "start_run",
      runId: "run_replay",
      caseId: "case_1",
      goal: "Assess target",
      scopeRef: "scope_1",
      availableCapabilities: capabilities,
      at: at(0),
    });
    const proposed = kernel.execute(started.state, {
      type: "propose_work",
      proposal: { id: "work_1", kind: "research", title: "Bind scope", objective: "Record setup", idempotencyKey: "effect_work_1" },
      at: at(1),
    });
    const events: ScenarioEvent[] = [...started.events, ...proposed.events];
    const replayed = events.reduce<ScenarioRunState | undefined>((state, event) => evolve(state, event), undefined);
    expect(replayed).toEqual(proposed.state);
  });

  it("permits parallel research up to the phase limit", () => {
    const kernel = new ScenarioKernel(WEB_BLACKBOX_SCENARIO);
    let state = enterSurfaceMapping(kernel);
    for (let index = 1; index <= 5; index += 1) {
      state = kernel.execute(state, {
        type: "propose_work",
        proposal: { id: `research_${index}`, kind: "research", title: `Research ${index}`, objective: `Map surface ${index}`, idempotencyKey: `effect_research_${index}` },
        at: at(10 + index),
      }).state;
    }
    for (let index = 1; index <= 4; index += 1) {
      state = kernel.execute(state, {
        type: "claim_work",
        workId: `research_${index}`,
        workerId: `worker_${index}`,
        workerRoles: ["researcher"],
        workerCapabilities: capabilities,
        workerCurrentWork: 0,
        workerMaxConcurrentWork: 1,
        leaseId: `lease_${index}`,
        leaseExpiresAt: at(40 + index),
        at: at(20 + index),
      }).state;
    }
    expect(() => kernel.execute(state, {
      type: "claim_work",
      workId: "research_5",
      workerId: "worker_5",
      workerRoles: ["researcher"],
      workerCapabilities: capabilities,
      workerCurrentWork: 0,
      workerMaxConcurrentWork: 1,
      leaseId: "lease_5",
      leaseExpiresAt: at(45),
      at: at(25),
    })).toThrow(/parallel work limit/);
  });

  it("preserves a no-candidate branch without inventing a vulnerability", () => {
    const kernel = new ScenarioKernel(WEB_BLACKBOX_SCENARIO);
    const planning = enterHypothesisPlanning(kernel);
    const reviewed = proposeClaimComplete(kernel, planning, {
      id: "candidate_review",
      kind: "review",
      outputKinds: ["coverage_assessment"],
      step: 10,
    });
    const next = kernel.execute(reviewed, { type: "advance_phase", to: "synthesis", at: at(13) }).state;
    expect(next.activePhaseId).toBe("synthesis");
    expect(next.outputs.some((output) => output.kind === "hypothesis")).toBe(false);
  });

  it("serializes validation and requires a conclusion or limitation", () => {
    const kernel = new ScenarioKernel(WEB_BLACKBOX_SCENARIO);
    let state = proposeClaimComplete(kernel, enterHypothesisPlanning(kernel), {
      id: "hypothesis_work",
      kind: "research",
      outputKinds: ["hypothesis"],
      step: 10,
    });
    state = kernel.execute(state, { type: "advance_phase", to: "validation", at: at(13) }).state;
    for (const id of ["validation_1", "validation_2"]) {
      state = kernel.execute(state, {
        type: "propose_work",
        proposal: { id, kind: "validation", title: id, objective: `Test ${id}`, hypothesisIds: [`hyp_${id}`], idempotencyKey: `effect_${id}` },
        at: at(14),
      }).state;
    }
    state = kernel.execute(state, {
      type: "claim_work", workId: "validation_1", workerId: "validator_1", workerRoles: ["validator"], workerCapabilities: capabilities, workerCurrentWork: 0, workerMaxConcurrentWork: 1, leaseId: "lease_1", leaseExpiresAt: at(25), at: at(15),
    }).state;
    expect(() => kernel.execute(state, {
      type: "claim_work", workId: "validation_2", workerId: "validator_2", workerRoles: ["validator"], workerCapabilities: capabilities, workerCurrentWork: 0, workerMaxConcurrentWork: 1, leaseId: "lease_2", leaseExpiresAt: at(26), at: at(16),
    })).toThrow(/already owns execution/);
    expect(() => kernel.execute(state, {
      type: "complete_work", workId: "validation_1", leaseId: "lease_1", summary: "done", outputs: [], at: at(17),
    })).toThrow(/must produce a validation conclusion or limitation/);
  });

  it("does not abandon queued work during a phase transition", () => {
    const kernel = new ScenarioKernel(WEB_BLACKBOX_SCENARIO);
    let state = enterHypothesisPlanning(kernel);
    state = proposeClaimComplete(kernel, state, {
      id: "planning_review",
      kind: "review",
      outputKinds: ["coverage_assessment"],
      step: 10,
    });
    state = kernel.execute(state, {
      type: "propose_work",
      proposal: { id: "unsettled", kind: "research", title: "Unsettled", objective: "Finish before transition", idempotencyKey: "effect_unsettled" },
      at: at(13),
    }).state;
    expect(() => kernel.execute(state, { type: "advance_phase", to: "synthesis", at: at(14) }))
      .toThrow(/unsettled work: unsettled/);
    state = kernel.execute(state, { type: "cancel_work", workId: "unsettled", reason: "superseded", at: at(15) }).state;
    expect(kernel.execute(state, { type: "advance_phase", to: "synthesis", at: at(16) }).state.activePhaseId).toBe("synthesis");
  });

  it("reprioritizes only queued work and records the reason as an event", () => {
    const kernel = new ScenarioKernel(WEB_BLACKBOX_SCENARIO);
    let state = start(kernel);
    state = kernel.execute(state, {
      type: "propose_work",
      proposal: { id: "work_1", kind: "research", title: "Record scope", objective: "Record authorized scope", priority: 10, idempotencyKey: "effect_1" },
      at: at(1),
    }).state;
    const reprioritized = kernel.execute(state, {
      type: "reprioritize_work",
      workId: "work_1",
      priority: 90,
      reason: "A prerequisite for the active phase",
      at: at(2),
    });
    expect(reprioritized.state.workItems[0].priority).toBe(90);
    expect(reprioritized.events).toEqual([
      expect.objectContaining({ type: "work_reprioritized", workId: "work_1", priority: 90, reason: "A prerequisite for the active phase" }),
    ]);

    state = kernel.execute(reprioritized.state, {
      type: "claim_work",
      workId: "work_1",
      workerId: "worker_1",
      workerRoles: ["researcher"],
      workerCapabilities: capabilities,
      workerCurrentWork: 0,
      workerMaxConcurrentWork: 1,
      leaseId: "lease_1",
      leaseExpiresAt: at(20),
      at: at(3),
    }).state;
    expect(() => kernel.execute(state, {
      type: "reprioritize_work",
      workId: "work_1",
      priority: 100,
      reason: "Too late to reorder an active task",
      at: at(4),
    })).toThrow(/Only queued work can be reprioritized/);
  });

  it("releases the lease while awaiting approval and requeues approved work with a durable grant", () => {
    const kernel = new ScenarioKernel(WEB_BLACKBOX_SCENARIO);
    let state = start(kernel);
    state = kernel.execute(state, {
      type: "propose_work",
      proposal: { id: "approval_work", kind: "research", title: "Bounded action", objective: "Perform an authorized action", idempotencyKey: "effect_approval" },
      at: at(1),
    }).state;
    state = kernel.execute(state, {
      type: "claim_work", workId: "approval_work", workerId: "worker_1", workerRoles: ["researcher"],
      workerCapabilities: capabilities, workerCurrentWork: 0, workerMaxConcurrentWork: 1,
      leaseId: "lease_approval", leaseExpiresAt: at(20), at: at(2),
    }).state;
    state = kernel.execute(state, {
      type: "checkpoint_work", workId: "approval_work", leaseId: "lease_approval", checkpointId: "checkpoint_approval",
      progressSummary: "Action prepared", payloadRef: "checkpoint://approval.json", at: at(3),
    }).state;
    state = kernel.execute(state, {
      type: "request_work_approval", workId: "approval_work", leaseId: "lease_approval", approvalId: "approval_1",
      actionKey: "effect_approval:call_1", toolName: "bounded.tool", risk: "privileged", rationale: "Required for validation",
      inputRef: "checkpoint://approval.json", at: at(4),
    }).state;
    expect(state.workItems[0]).toMatchObject({ status: "waiting_approval", workerId: null, leaseId: null });
    state = kernel.execute(state, {
      type: "resolve_work_approval", workId: "approval_work", approvalId: "approval_1", approved: true,
      reason: "Operator confirmed the bounded action", at: at(5),
    }).state;
    expect(state.workItems[0]).toMatchObject({ status: "queued", pendingApproval: null });
    expect(state.workItems[0].grantedActionKeys).toEqual(["effect_approval:call_1"]);
    expect(state.workItems[0].approvalHistory[0].status).toBe("approved");
  });

  it("cancels pending approvals and active work when the run is cancelled", () => {
    const kernel = new ScenarioKernel(WEB_BLACKBOX_SCENARIO);
    let state = start(kernel);
    state = kernel.execute(state, {
      type: "propose_work",
      proposal: { id: "approval_work", kind: "research", title: "Bounded action", objective: "Perform an authorized action", idempotencyKey: "effect_approval" },
      at: at(1),
    }).state;
    state = kernel.execute(state, {
      type: "claim_work", workId: "approval_work", workerId: "worker_1", workerRoles: ["researcher"],
      workerCapabilities: capabilities, workerCurrentWork: 0, workerMaxConcurrentWork: 1,
      leaseId: "lease_approval", leaseExpiresAt: at(20), at: at(2),
    }).state;
    state = kernel.execute(state, {
      type: "checkpoint_work", workId: "approval_work", leaseId: "lease_approval", checkpointId: "checkpoint_approval",
      progressSummary: "Action prepared", payloadRef: "checkpoint://approval.json", at: at(3),
    }).state;
    state = kernel.execute(state, {
      type: "request_work_approval", workId: "approval_work", leaseId: "lease_approval", approvalId: "approval_1",
      actionKey: "effect_approval:call_1", toolName: "bounded.tool", risk: "privileged", rationale: "Required for validation",
      inputRef: "checkpoint://approval.json", at: at(4),
    }).state;
    state = kernel.execute(state, { type: "cancel_run", reason: "Authorization withdrawn", at: at(5) }).state;

    expect(state.status).toBe("cancelled");
    expect(state.workItems[0]).toMatchObject({
      status: "cancelled",
      workerId: null,
      leaseId: null,
      pendingApproval: null,
    });
    expect(state.workItems[0].approvalHistory[0]).toMatchObject({
      id: "approval_1",
      status: "cancelled",
      resolutionReason: "Authorization withdrawn",
    });
  });

  it("pauses durably, releases execution, and resumes from a checkpoint without consuming an attempt", () => {
    const kernel = new ScenarioKernel(WEB_BLACKBOX_SCENARIO);
    const events: ScenarioEvent[] = [];
    let result = kernel.execute(undefined, {
      type: "start_run", runId: "run_pause", caseId: "case_1", goal: "Assess target",
      scopeRef: "scope_1", availableCapabilities: capabilities, at: at(0),
    });
    events.push(...result.events);
    result = kernel.execute(result.state, {
      type: "propose_work",
      proposal: { id: "work_1", kind: "research", title: "Collect", objective: "Collect observations", idempotencyKey: "effect_1" },
      at: at(1),
    });
    events.push(...result.events);
    result = kernel.execute(result.state, {
      type: "claim_work", workId: "work_1", workerId: "worker_1", workerRoles: ["researcher"],
      workerCapabilities: capabilities, workerCurrentWork: 0, workerMaxConcurrentWork: 1,
      leaseId: "lease_1", leaseExpiresAt: at(20), at: at(2),
    });
    events.push(...result.events);
    result = kernel.execute(result.state, {
      type: "checkpoint_work", workId: "work_1", leaseId: "lease_1", checkpointId: "checkpoint_1",
      progressSummary: "Durable progress", payloadRef: "checkpoint://work-1.json", at: at(3),
    });
    events.push(...result.events);
    result = kernel.execute(result.state, { type: "pause_run", reason: "Operator maintenance", requestedBy: "operator", at: at(4) });
    events.push(...result.events);

    expect(result.state).toMatchObject({ status: "paused", suspension: { reason: "Operator maintenance", requestedBy: "operator" } });
    expect(result.state.workItems[0]).toMatchObject({
      status: "queued", workerId: null, leaseId: null, attempt: 1, resumeFromCheckpoint: true,
      latestCheckpoint: { id: "checkpoint_1" },
    });
    expect(() => kernel.execute(result.state, {
      type: "propose_work",
      proposal: { id: "work_2", kind: "research", title: "More", objective: "More work", idempotencyKey: "effect_2" },
      at: at(5),
    })).toThrow(/paused/);

    result = kernel.execute(result.state, { type: "resume_run", reason: "Maintenance complete", requestedBy: "operator", at: at(6) });
    events.push(...result.events);
    result = kernel.execute(result.state, {
      type: "claim_work", workId: "work_1", workerId: "worker_2", workerRoles: ["researcher"],
      workerCapabilities: capabilities, workerCurrentWork: 0, workerMaxConcurrentWork: 1,
      leaseId: "lease_2", leaseExpiresAt: at(25), at: at(7),
    });
    events.push(...result.events);
    expect(result.state.workItems[0]).toMatchObject({ status: "running", attempt: 1, resumeFromCheckpoint: false, leaseId: "lease_2" });
    expect(events.reduce<ScenarioRunState | undefined>((state, event) => evolve(state, event), undefined)).toEqual(result.state);
  });

  it("preserves pending approvals while a Run is paused and resumed", () => {
    const kernel = new ScenarioKernel(WEB_BLACKBOX_SCENARIO);
    let state = start(kernel);
    state = kernel.execute(state, {
      type: "propose_work",
      proposal: { id: "approval_work", kind: "research", title: "Bounded action", objective: "Prepare action", idempotencyKey: "effect_approval" },
      at: at(1),
    }).state;
    state = kernel.execute(state, {
      type: "claim_work", workId: "approval_work", workerId: "worker_1", workerRoles: ["researcher"],
      workerCapabilities: capabilities, workerCurrentWork: 0, workerMaxConcurrentWork: 1,
      leaseId: "lease_1", leaseExpiresAt: at(20), at: at(2),
    }).state;
    state = kernel.execute(state, {
      type: "checkpoint_work", workId: "approval_work", leaseId: "lease_1", checkpointId: "checkpoint_1",
      progressSummary: "Action prepared", payloadRef: "artifact://input", at: at(3),
    }).state;
    state = kernel.execute(state, {
      type: "request_work_approval", workId: "approval_work", leaseId: "lease_1", approvalId: "approval_1",
      actionKey: "effect_approval:call_1", toolName: "bounded.tool", risk: "privileged", rationale: "Operator decision required",
      inputRef: "artifact://input", at: at(4),
    }).state;
    state = kernel.execute(state, { type: "pause_run", reason: "Operator review", requestedBy: "operator", at: at(5) }).state;
    expect(state.workItems[0]).toMatchObject({ status: "waiting_approval", pendingApproval: { id: "approval_1", status: "pending" } });
    state = kernel.execute(state, { type: "resume_run", reason: "Review complete", requestedBy: "operator", at: at(6) }).state;
    expect(state.workItems[0].pendingApproval).toMatchObject({ id: "approval_1", status: "pending" });
  });
});
