import type { CapabilityReceipt, JsonObject, ToolResult } from "./contracts.mjs";
import { boundedInteger, canonicalHttpUrl, exact, plainObject, requiredBase64, requiredText, sha, shaBytes, stableJson, succeeded, unique } from "./validation.mjs";
import { readInventories, surfaceKey } from "./surface-inventory.mjs";
import { budgets, BudgetExhausted } from "./budgets.mjs";
import {observationHighlights} from "./observations.mjs";
import {experimentFields,changedDimensions} from "./request-fields.mjs";

type Capability = (name: string, action: string, input: unknown, suffix: string) => Promise<CapabilityReceipt>;
type Dispatch = (input: JsonObject, suffix: string, timeoutMs: number) => Promise<ToolResult>;

// One call must finish inside the declared 125 s tool timeout: the loop stops
// dispatching after LOOP_BUDGET_MS and the last request may extend at most
// MAX_REQUEST_MS past it, leaving room for evidence and checkpoint writes.
const LOOP_BUDGET_MS = 90_000;
const MAX_REQUEST_MS = 15_000;
const MIN_REQUEST_MS = 1_000;
interface Observation { stage: string; status: number; bytes: number; digest: string; truncated: boolean; refs: string[] }
interface Candidate {
  variantAssessments?:Array<{variantIndex:number;assessment:string}>;
  registered: boolean; reviewRecorded: boolean;
  id: string; hypothesisId: string; statement: string; basisRefs: string[]; fingerprint: string | null;
  workId: string | null; scopeRef: string; surfaceKey?: string; pending: string | null; observations: Observation[];
  status: "queued" | "running" | "observed" | "stopped" | "reviewed";
  assessment: string | null; review: JsonObject | null;
}
interface State { version: 1; candidates: Candidate[]; active: string | null }
const key = "web.investigation.v1";

// Scenario-owned experiment ledger, not a Work scheduler. Work allocation stays in Core.
export async function investigation(action: string, input: JsonObject, context: JsonObject, capability: Capability, dispatch: Dispatch): Promise<ToolResult> {
  const limits=await budgets(capability);
  const write = !["report", "snapshot"].includes(action);
  await capability("traceforge.scenario.authorization@1", "require", { action: action === "report" ? "report.write" : action === "snapshot" ? "scope.read" : "evidence.write" }, "workflow-permission");
  const loaded = await capability("traceforge.scenario.state@1", "read", { operation: "read", key }, "workflow-read");
  let revision = loaded.output?.revision ?? 0;
  let state: State = loaded.output == null ? { version: 1, candidates: [], active: null } : restore(loaded.output.value);
  const save = async () => {
    if (!write) throw new Error("Report cannot change investigation state");
    const receipt = await capability("traceforge.scenario.state@1", "compare_and_set", {
      operation: "compare_and_set", key, commandId: `workflow:${revision}`, expectedRevision: revision, value: state,
    }, `workflow-save:${revision}`);
    revision = receipt.output.revision; state = restore(receipt.output.value);
  };
  if (action === "register") {
    exact(input, ["candidateId", "statement", "basisRefs", "surfaceSessionId"]);
    const id = requiredText(input.candidateId, "Candidate id"), statement = requiredText(input.statement, "Candidate statement");
    const basisRefs = refs(input.basisRefs);
    const inventoryKey = surfaceKey(input.surfaceSessionId === undefined ? null : requiredText(input.surfaceSessionId, "Surface Session"));
    const existing = state.candidates.find(item => item.id === id);
    if (existing) {
      if (existing.statement !== statement || JSON.stringify(existing.basisRefs) !== JSON.stringify(basisRefs) || existing.scopeRef !== context.scopeRef
        || (existing.surfaceKey ?? "web.surface.v1") !== inventoryKey) throw new Error("Candidate id already binds other material");
      if (!existing.registered) throw new Error("Hypothesis registration outcome is unconfirmed; inspect the graph before continuing");
      return candidateResult(existing);
    }
    if (state.candidates.length >= limits.hypotheses) throw new Error("Investigation candidate budget exhausted; request additional authorization or report current coverage");
    const surface = await capability("traceforge.scenario.state@1", "read", { operation: "read", key: inventoryKey }, "workflow-surface");
    const observations = surface.output?.value?.observations;
    if (!Array.isArray(observations)) throw new Error("Explore authorized surface before registering a hypothesis");
    const known = new Set(observations.flatMap(item => [item.networkReceipt, ...(item.evidenceRefs ?? [])]));
    if (!basisRefs.every(ref => known.has(ref))) throw new Error("Hypothesis basis must reference retained surface observations");
    for (const observation of observations.filter(item => [item.networkReceipt, ...(item.evidenceRefs ?? [])].some(ref => basisRefs.includes(ref)))) {
      await capability("traceforge.scenario.authorization@1", "authorize_resource", {
        action: "web.request.replay", resourceKind: "network.url", value: canonicalHttpUrl(observation.url, "Hypothesis source URL"),
      }, `workflow-basis:${sha(observation.url)}`);
    }
    const candidate: Candidate = { registered: false, reviewRecorded: false, id, hypothesisId: `web-hypothesis:${sha(`${context.caseId}:${context.runId}:${id}`)}`, statement, basisRefs,
      fingerprint: null, workId: null, scopeRef: requiredText(context.scopeRef, "Scope"), surfaceKey: inventoryKey, pending: null, observations: [], status: "queued", assessment: null, review: null };
    state.candidates.push(candidate); await save();
    await recordCandidate(candidate, capability);
    state.candidates.find(item => item.id === id)!.registered = true; await save();
    return candidateResult(state.candidates.find(item => item.id === id)!);
  }
  if (action === "report" || action === "snapshot") {
    exact(input, []);
    const groups = { supportedCandidates: [] as JsonObject[], refutedCandidates: [] as JsonObject[], unresolved: [] as JsonObject[] };
    for (const candidate of state.candidates) {
      const row = { ...candidate, status: !candidate.registered ? "registration_unconfirmed" : candidate.pending !== null ? "interrupted"
        : candidate.review && !candidate.reviewRecorded ? "review_unconfirmed" : candidate.status, findingVerified: false };
      if (candidate.reviewRecorded && candidate.review?.outcome === "supported") groups.supportedCandidates.push(row);
      else if (candidate.reviewRecorded && candidate.review?.outcome === "refuted") groups.refutedCandidates.push(row);
      else groups.unresolved.push(row);
    }
    const coverage = await readInventories(capability, state.candidates.flatMap(candidate => candidate.surfaceKey ? [candidate.surfaceKey] : []));
    const anonymous = coverage.inventories.find(item => item.mode === "anonymous");
    const reportRefs = unique([...state.candidates.flatMap(candidate => [...(candidate.registered ? [`knowledge-node:${candidate.hypothesisId}`] : []), ...candidate.basisRefs,
      ...candidate.observations.flatMap(item => item.refs), ...(candidate.reviewRecorded ? [`knowledge-node:web-review:${sha(candidate.hypothesisId)}`] : [])]),
      ...coverage.inventories.flatMap(item => item.observations.flatMap((observation: JsonObject) => [observation.networkReceipt, ...observation.evidenceRefs]))]);
    return succeeded(action === "report" ? "Black-box investigation report assembled; no verified findings inferred" : "Investigation handoff loaded without executing or scheduling work", {
      outputKind: action === "report" ? "report" : "coverage_assessment", schemaVersion: 1, ...groups, verifiedFindings: [], verifiedFindingCoverage: "not_loaded", activeCandidateId: state.active,
      handoff: handoff(state, coverage.inventories),
      referenceListTruncated: reportRefs.length > 512,
      coverage: { candidateCount: state.candidates.length, reviewedCount: state.candidates.filter(item => item.reviewRecorded).length,
        anonymousVisited: anonymous?.visitedCount ?? 0, anonymousQueued: anonymous?.queuedCount ?? 0, anonymousSkipped: anonymous?.skipped ?? [], anonymousPending: anonymous?.pending ?? null,
        inventories: coverage.inventories, catalogAvailable: coverage.catalogAvailable,
        complete: false },
      limitations: [...coverage.limitations, "Browser-only observations and manually issued HTTP requests are not enumerated by the surface ledger; reconcile their receipts separately.",
        "Supported/refuted labels are review assessments, not lifecycle-verified Findings. No difference is not a proof of safety.",
        "Queued, stopped, unreviewed and interrupted candidates remain explicit; report generation does not finish Work or advance phases."],
    }, reportRefs.slice(0, 512));
  }
  const candidateId = requiredText(input.candidateId, "Candidate id");
  let candidate = state.candidates.find(item => item.id === candidateId);
  if (!candidate) throw new Error("Register the candidate first");
  if (!candidate.registered) throw new Error("Hypothesis registration outcome is unconfirmed");
  if (candidate.scopeRef !== context.scopeRef) throw new Error("Candidate belongs to another authorization scope");
  if (action === "review") {
    exact(input, ["candidateId", "outcome", "causalMechanism", "expectedBoundary", "securityImpact", "alternatives", "refs"]);
    if (!["observed", "stopped", "reviewed"].includes(candidate.status) && candidate.pending === null) throw new Error("Collect observations before review");
    const outcome = requiredText(input.outcome, "Review outcome");
    if (!["supported", "refuted", "inconclusive"].includes(outcome)) throw new Error("Review outcome is invalid");
    if ((candidate.pending !== null || candidate.status === "stopped") && outcome !== "inconclusive") throw new Error("Interrupted or stopped experiments require an inconclusive review");
    if (outcome === "supported" && candidate.assessment !== "repeatable_difference") throw new Error("A supported comparison requires a repeatable difference");
    const references = refs(input.refs), known = new Set([...candidate.basisRefs, ...candidate.observations.flatMap(item => item.refs)]);
    if (!references.every(ref => known.has(ref))) throw new Error("Review contains unknown evidence references");
    if (outcome !== "inconclusive" && !candidate.observations.some(item => item.refs.some(ref => references.includes(ref)))) throw new Error("Review must cite experiment observations");
    if (outcome !== "inconclusive" && !["baseline:", "candidate:"].every(stage => candidate!.observations
      .some(item => item.stage.startsWith(stage) && item.refs.some(ref => references.includes(ref))))) {
      throw new Error("Review must cite both baseline and candidate observations");
    }
    const review = { outcome, causalMechanism: requiredText(input.causalMechanism, "Causal mechanism or missing link"),
      expectedBoundary: requiredText(input.expectedBoundary, "Expected boundary or missing rule"), securityImpact: requiredText(input.securityImpact, "Impact or missing evidence"),
      alternatives: requiredText(input.alternatives, "Alternative explanations"), refs: references };
    if (candidate.review && JSON.stringify(candidate.review) !== JSON.stringify(review)) throw new Error("Review is immutable; retain conflicting interpretations in the evidence graph");
    if (candidate.review) {
      if (!candidate.reviewRecorded) throw new Error("Review persistence outcome is unconfirmed; inspect the graph");
      return candidateResult(candidate);
    }
    candidate.review = review; await save(); candidate = state.candidates.find(item => item.id === candidateId)!;
    const receipt = await capability("traceforge.scenario.evidence@1", "record_node", { commandId: `review:${sha(candidate.hypothesisId).slice(0, 24)}`, node: {
      id: `web-review:${sha(candidate.hypothesisId)}`, kind: outcome === "inconclusive" ? "limitation" : "validation_conclusion",
      status: outcome === "inconclusive" ? "active" : "candidate", confidence: 0.5, title: "HTTP validation review",
      summary: `Review assessment: ${outcome}; not a verified finding`, properties: { hypothesisId: candidate.hypothesisId, ...review, findingVerified: false },
    } }, `review:${sha(candidate.hypothesisId).slice(0, 24)}`);
    candidate.reviewRecorded = true; candidate.status = "reviewed";
    // An inconclusive note cannot clear an unknown external effect fence.
    if (candidate.pending === null && state.active === candidate.id) state.active = null;
    await save();
    return succeeded("Validation review recorded", { outputKind: outcome === "inconclusive" ? "limitation" : "validation_conclusion", ...candidate, findingVerified: false }, [...references, ...receipt.refs]);
  }
  if (action !== "advance") throw new Error("Unknown investigation operation");
  exact(input, ["candidateId", "plan", "maxRequests"]);
  const plan = parsePlan(input.plan);
  // Plan identity binds the normalized plan content, not the input key order.
  const fingerprint = sha(stableJson({ prepare: plan.prepare, baseline: plan.baseline, candidates: plan.candidates,
    rounds: plan.rounds, changedCondition: plan.changedCondition, stopOn: plan.stopOn, expectedSignals: plan.expectedSignals }));
  if(plan.candidates.length>limits.variants)throw new Error("Authorized variant budget exceeded");
  const budget = boundedInteger(input.maxRequests ?? limits.requestsPerCall, 1, limits.requestsPerCall, "Workflow request budget");
  const workId = requiredText(context.workId, "Validation Work id");
  if (candidate.fingerprint !== null && candidate.fingerprint !== fingerprint) throw new Error("Validation plan cannot change during continuation");
  if (candidate.workId !== null && candidate.workId !== workId) throw new Error("Resume using the original validation Work");
  if (state.active !== null && state.active !== candidate.id) throw new Error("Another validation candidate is active");
  if (candidate.pending !== null || ["observed", "stopped", "reviewed"].includes(candidate.status)) return candidateResult(candidate);
  const inventoryState = await readInventories(capability, candidate.surfaceKey ? [candidate.surfaceKey] : []);
  if (inventoryState.inventories.some(item => item.pending !== null)) {
    throw new Error("A surface request outcome is unconfirmed; reconcile it before dispatching validation");
  }
  // Validate all exact targets before a possibly mutating preparation, then recheck at each dispatch.
  for (const url of unique([...plan.prepare.map(step => step.request.url as string), plan.baseline.url as string, ...plan.candidates.map(item=>item.url as string)])) {
    await capability("traceforge.scenario.authorization@1", "authorize_resource", {
      action: "web.request.replay", resourceKind: "network.url", value: url,
    }, `workflow-preflight:${sha(url)}`);
  }
  candidate.fingerprint = fingerprint; candidate.workId = workId; candidate.status = "running"; state.active = candidate.id;
  await save(); candidate = state.candidates.find(item => item.id === candidateId)!;
  const sequence = [...plan.prepare.map((step, i) => ({ stage: `prepare:${i}`, ...step })),
    ...plan.candidates.flatMap((variant,variantIndex)=>Array.from({ length: plan.rounds * 2 }, (_, i) => ({ stage: `${i % 2 === 0 ? "baseline" : "candidate"}:${Math.floor(i / 2)+variantIndex*plan.rounds}`,
      request: i % 2 === 0 ? plan.baseline : variant, expectedStatuses: [] as number[] })))];
  const deadline=Date.now()+LOOP_BUDGET_MS;
  for (let used = 0; used < budget && candidate.observations.length < sequence.length && Date.now()<deadline; used++) {
    const step = sequence[candidate.observations.length]!;
    const requestTimeoutMs = Math.min(MAX_REQUEST_MS, deadline + MAX_REQUEST_MS - Date.now());
    if (requestTimeoutMs < MIN_REQUEST_MS) break;
    await capability("traceforge.scenario.authorization@1", "authorize_resource", {
      action: "web.request.replay", resourceKind: "network.url", value: step.request.url,
    }, `workflow-authorize:${step.stage}`);
    candidate.pending = step.stage; await save(); candidate = state.candidates.find(item => item.id === candidateId)!;
    let response:ToolResult;
    try{response=await dispatch(step.request,`workflow:${candidate.hypothesisId}:${step.stage}`,requestTimeoutMs);}catch(error){if(error instanceof BudgetExhausted){candidate.pending=null;await save();}throw error;}
    const body = plainObject(JSON.parse(response.raw), "Workflow response"), bytes = Buffer.from(requiredBase64(body.bodyBase64), "base64");
    const observation: Observation = { stage: step.stage, status: boundedInteger(body.status, 100, 599, "HTTP status"),
      bytes: boundedInteger(body.responseBytes, 0, 1024 * 1024, "HTTP response bytes"), digest: shaBytes(bytes), truncated: body.bodyTruncated !== false,
      refs: [`network-receipt:${requiredText(body.receipt?.id, "Network receipt")}`] };
    const receipt = await capability("traceforge.scenario.evidence@1", "record_node", { commandId: `observation:${sha(`${candidate.hypothesisId}:${step.stage}`).slice(0, 24)}`, node: {
      id: `web-workflow:${sha(`${candidate.hypothesisId}:${step.stage}`)}`, kind: "fact", status: "active", confidence: 1,
      title: `HTTP workflow ${step.stage}`, summary: "Attributable HTTP observation; no security conclusion inferred",
      properties: { hypothesisId: candidate.hypothesisId, planFingerprint: fingerprint, ...observation },
    } }, `workflow-evidence:${step.stage}`);
    observation.refs = unique([...observation.refs, ...receipt.refs]); candidate.observations.push(observation); candidate.pending = null;
    if (step.expectedStatuses.length && !step.expectedStatuses.includes(observation.status)) {
      candidate.status = "stopped"; candidate.assessment = "precondition_failed";
    } else {
      const observations=candidate.observations.filter(item=>!item.stage.startsWith("prepare:"));
      candidate.variantAssessments=Array.from({length:Math.floor(observations.length/(plan.rounds*2))},(_,variantIndex)=>({variantIndex,assessment:assess(observations.slice(variantIndex*plan.rounds*2,(variantIndex+1)*plan.rounds*2))}));
      const latest=candidate.variantAssessments.at(-1),pair=observations.slice(-2),signalMatch=pair.length===2&&plan.expectedSignals.some(signal=>signal==="statusChanged"?pair[0]!.status!==pair[1]!.status:signal==="bytesChanged"?pair[0]!.bytes!==pair[1]!.bytes:pair[0]!.digest!==pair[1]!.digest);
      if(candidate.observations.length===sequence.length||(plan.stopOn==="repeatable_difference"&&observations.length%(plan.rounds*2)===0&&latest?.assessment==="repeatable_difference"&&signalMatch)){
        candidate.status="observed";candidate.assessment=candidate.variantAssessments.some(item=>item.assessment==="repeatable_difference")?"repeatable_difference":latest?.assessment??"insufficient_observations";
      }
    }
    await save(); candidate = state.candidates.find(item => item.id === candidateId)!;
    if (candidate.status !== "running") break;
  }
  return candidateResult(candidate);
}

function handoff(state: State, inventories: JsonObject[]) {
  const uncertain = state.candidates.filter(item => !item.registered || item.pending !== null || (item.review !== null && !item.reviewRecorded));
  const pendingInventories = inventories.filter(item => item.pending !== null).map(item => item.key);
  const active = state.candidates.find(item => item.id === state.active);
  const queued = state.candidates.filter(item => item.registered && item.status === "queued");
  const nextAction = uncertain.length || pendingInventories.length ? "reconcile_unknown_outcomes"
    : active?.status === "running" ? "continue_original_validation_work"
    : active ? "review_active_candidate"
    : queued.length ? "schedule_one_validation_work"
    : state.candidates.length ? "synthesize_evidence_and_limitations"
    : inventories.some(item => item.retainedObservationCount > 0) ? "assess_surface_and_register_hypotheses" : "map_authorized_surface";
  return { nextAction, advisoryOnly: true, candidateId: active?.id ?? queued[0]?.id ?? null, originalWorkId: active?.workId ?? null,
    queuedCandidateIds: queued.map(item => item.id), uncertainCandidateIds: uncertain.map(item => item.id), pendingInventories,
    requiresGraphReview: true, requiresOperatorOrHostReconciliation: uncertain.length > 0 || pendingInventories.length > 0,
    instruction: "This is a Scenario handoff, not a scheduling command or permission grant. Core owns Work and phase transitions; preserve every queued hypothesis." };
}

function parsePlan(value: unknown) {
  const plan = plainObject(value, "Validation plan"); exact(plan, ["prepare", "baseline", "candidate", "candidates", "rounds", "changedCondition", "stopOn", "expectedSignals"]);
  const changedCondition = requiredText(plan.changedCondition, "Controlled change rationale");
  if (!Array.isArray(plan.prepare) || plan.prepare.length > 4) throw new Error("At most four preconditions are supported");
  const prepare = plan.prepare.map(value => {
    const step = plainObject(value, "Precondition"); exact(step, ["request", "expectedStatuses"]);
    if (!Array.isArray(step.expectedStatuses) || step.expectedStatuses.length < 1 || step.expectedStatuses.length > 8) throw new Error("Preconditions need bounded expected statuses");
    return { request: parseRequest(step.request, true), purpose: requiredText(step.request.purpose, "Precondition purpose"), expectedStatuses: unique(step.expectedStatuses.map(status => boundedInteger(status, 100, 599, "Expected status"))) };
  });
  if(plan.candidate!==undefined&&plan.candidates!==undefined)throw new Error("Choose candidate or candidates");
  if(plan.candidate===undefined&&plan.candidates===undefined)throw new Error("Validation plan requires a candidate or candidates");
  const variants=plan.candidates??[plan.candidate];if(!Array.isArray(variants)||!variants.length||variants.length>16)throw new Error("Invalid variant matrix");
  const baseline = parseRequest(plan.baseline, false), candidates = variants.map(value=>parseRequest(value,false));
  const dimension=changedDimensions(baseline,candidates[0]!)[0];
  for(const candidate of candidates){const changed = changedDimensions(baseline,candidate);
    if (changed.length !== 1 || changed[0]!==dimension) throw new Error("All variants must change exactly the same comparison request dimension");}
  const stopOn=plan.stopOn??"never",expectedSignals=plan.expectedSignals??["statusChanged","bodyChanged","bytesChanged"];
  if(!["never","repeatable_difference"].includes(stopOn)||!Array.isArray(expectedSignals)||!expectedSignals.length||expectedSignals.length>3||expectedSignals.some(v=>!["statusChanged","bodyChanged","bytesChanged"].includes(v)))throw new Error("Invalid experiment signals or stop condition");
  return { prepare, baseline, candidates, rounds: boundedInteger(plan.rounds ?? 2, 2, 3, "Comparison rounds"), changedCondition,stopOn,expectedSignals };
}

function parseRequest(value: unknown, prepare: boolean): JsonObject {
  const request = plainObject(value, "Planned request");
  exact(request, ["url", "method", "sessionId", "headers", "bodyBase64", "secretBody", "captures", "purpose"]);
  const fields=experimentFields(request),method=fields.method;
  if (prepare) requiredText(request.purpose, "Precondition purpose and expected side effects");
  if (!prepare && ["secretBody", "captures", "purpose"].some(key => request[key] !== undefined)) throw new Error("Comparison requests cannot have preparation fields");
  const normalized=fields.headers;
  if (request.bodyBase64 !== undefined && (requiredBase64(request.bodyBase64).length > 87384 || request.secretBody !== undefined)) throw new Error("Invalid or oversized precondition body");
  if ((request.secretBody !== undefined || request.captures !== undefined) && request.sessionId === undefined) throw new Error("Secret templates and captures require a Host Session");
  if (["GET", "HEAD"].includes(method) && (request.secretBody !== undefined || request.bodyBase64)) throw new Error("GET/HEAD preparations cannot carry a body");
  if (request.secretBody !== undefined) {
    const body = plainObject(request.secretBody, "Secret template"); exact(body, ["format", "fields"]);
    if (!["form", "json"].includes(body.format)) throw new Error("Unsupported secret template format");
    const fields = plainObject(body.fields, "Secret fields");
    if (Object.keys(fields).length > 64) throw new Error("Too many secret template fields");
    for (const [name, value] of Object.entries(fields)) {
      if (!name || Buffer.byteLength(name) > 256) throw new Error("Invalid template field name");
      const selector = plainObject(value, "Template selector"); exact(selector, ["literal", "secret"]);
      if (Object.keys(selector).length !== 1) throw new Error("Choose one template selector");
      if ("secret" in selector) requiredText(selector.secret, "Secret handle");
      else if (typeof selector.literal !== "string" || Buffer.byteLength(selector.literal) > 8192 || /(?:password|passwd|token|secret|api.?key)/i.test(name)) throw new Error("Sensitive fields require a secret handle");
    }
  }
  if (request.captures !== undefined) {
    if (!Array.isArray(request.captures) || request.captures.length > 16) throw new Error("Invalid capture list");
    for (const value of request.captures) {
      const capture = plainObject(value, "Capture"); exact(capture, ["name", "start", "end", "maximumBytes"]);
      if (!/^[a-zA-Z][a-zA-Z0-9_.:-]{0,127}$/.test(requiredText(capture.name, "Capture name"))) throw new Error("Invalid capture name");
      for (const delimiter of [capture.start, capture.end]) if (Buffer.byteLength(requiredText(delimiter, "Capture delimiter")) > 256) throw new Error("Capture delimiter too large");
      boundedInteger(capture.maximumBytes, 1, 8192, "Capture size");
    }
  }
  return { url: canonicalHttpUrl(request.url, "Workflow URL"), method, headers: normalized,
    ...(request.sessionId === undefined ? {} : { sessionId: requiredText(request.sessionId, "Session id") }),
    ...(request.bodyBase64 === undefined ? {} : { bodyBase64: request.bodyBase64 }),
    ...(request.secretBody === undefined ? {} : { secretBody: request.secretBody }), ...(request.captures === undefined ? {} : { captures: request.captures }) };
}

function assess(observations: Observation[]): string {
  if (observations.some(item => item.truncated)) return "truncated_observations";
  const signature = (item: Observation) => JSON.stringify([item.status, item.bytes, item.digest]);
  const baseline = observations.filter(item => item.stage.startsWith("baseline:"));
  const candidate = observations.filter(item => item.stage.startsWith("candidate:"));
  if (new Set(baseline.map(signature)).size !== 1 || new Set(candidate.map(signature)).size !== 1) return "unstable_observations";
  return signature(baseline[0]!) === signature(candidate[0]!) ? "no_observed_difference" : "repeatable_difference";
}
function refs(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 32) throw new Error("Evidence references are required and bounded");
  return unique(value.map(item => requiredText(item, "Evidence reference"))).sort();
}
function restore(value: unknown): State {
  const state = plainObject(value, "Investigation state");
  if (state.version !== 1 || !Array.isArray(state.candidates) || state.candidates.length > 128
    || (state.active !== null && !state.candidates.some(item => item.id === state.active))) throw new Error("Invalid investigation checkpoint");
  for (const candidate of state.candidates) {
    if (!Array.isArray(candidate.observations) || candidate.observations.length > 100
      || !["queued", "running", "observed", "stopped", "reviewed"].includes(candidate.status)) throw new Error("Invalid candidate checkpoint");
  }
  return structuredClone(state) as State;
}
async function recordCandidate(candidate: Candidate, capability: Capability) {
  // Stable node IDs are the graph identity; no network actions occur on registration retry.
  return capability("traceforge.scenario.evidence@1", "record_node", { commandId: `hypothesis:${sha(candidate.hypothesisId).slice(0, 24)}`, node: {
    id: candidate.hypothesisId, kind: "hypothesis", status: "candidate", confidence: 0.5, title: candidate.statement, summary: candidate.statement,
    properties: { basisRefs: candidate.basisRefs, scopeRef: candidate.scopeRef },
  } }, `hypothesis:${sha(candidate.hypothesisId).slice(0, 24)}`);
}
function candidateResult(candidate: Candidate) {
  return succeeded(`Candidate ${candidate.id}: ${candidate.pending === null ? candidate.status : "interrupted"}`, {
    contextHighlights:observationHighlights(candidate.observations),
    ...candidate, status: candidate.pending === null ? candidate.status : "interrupted", findingVerified: false,
    outputKind: candidate.pending !== null || candidate.status === "stopped" ? "limitation" : candidate.status === "queued" ? "hypothesis"
      : candidate.reviewRecorded ? candidate.review?.outcome === "inconclusive" ? "limitation" : "validation_conclusion" : "surface_observation",
    limitations: ["No automatic Finding verification. Resume the same plan in the original validation Work; unknown effects require review and remain fenced."],
  }, unique([`knowledge-node:${candidate.hypothesisId}`, ...candidate.basisRefs, ...candidate.observations.flatMap(item => item.refs),
    ...(candidate.reviewRecorded ? [`knowledge-node:web-review:${sha(candidate.hypothesisId)}`] : [])]));
}
