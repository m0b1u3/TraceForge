import type { CapabilityReceipt, JsonObject, ToolResult } from "./contracts.mjs";
import { boundedInteger, canonicalHttpUrl, exact, plainObject, requiredBase64, requiredText, sha, shaBytes, succeeded, unique } from "./validation.mjs";

type Capability = (name: string, action: string, input: unknown, suffix: string) => Promise<CapabilityReceipt>;
type Dispatch = (input: JsonObject, suffix: string) => Promise<ToolResult>;
interface Observation { stage: string; status: number; bytes: number; digest: string; truncated: boolean; refs: string[] }
interface Candidate {
  registered: boolean; reviewRecorded: boolean;
  id: string; hypothesisId: string; statement: string; basisRefs: string[]; fingerprint: string | null;
  workId: string | null; scopeRef: string; pending: string | null; observations: Observation[];
  status: "queued" | "running" | "observed" | "stopped" | "reviewed";
  assessment: string | null; review: JsonObject | null;
}
interface State { version: 1; candidates: Candidate[]; active: string | null }
const key = "web.investigation.v1";

// Scenario-owned experiment ledger, not a Work scheduler. Work allocation stays in Core.
export async function investigation(action: string, input: JsonObject, context: JsonObject, capability: Capability, dispatch: Dispatch): Promise<ToolResult> {
  const write = action !== "report";
  await capability("traceforge.scenario.authorization@1", "require", { action: action === "report" ? "report.write" : "evidence.write" }, "workflow-permission");
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
    const existing = state.candidates.find(item => item.id === id);
    if (existing) {
      if (existing.statement !== statement || JSON.stringify(existing.basisRefs) !== JSON.stringify(basisRefs) || existing.scopeRef !== context.scopeRef) throw new Error("Candidate id already binds other material");
      if (!existing.registered) throw new Error("Hypothesis registration outcome is unconfirmed; inspect the graph before continuing");
      return candidateResult(existing);
    }
    if (state.candidates.length >= 16) throw new Error("Investigation candidate budget exhausted; report current coverage");
    const surfaceKey = input.surfaceSessionId === undefined ? "web.surface.v1" : `web.surface.v1:${sha(requiredText(input.surfaceSessionId, "Surface Session")).slice(0, 16)}`;
    const surface = await capability("traceforge.scenario.state@1", "read", { operation: "read", key: surfaceKey }, "workflow-surface");
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
      fingerprint: null, workId: null, scopeRef: requiredText(context.scopeRef, "Scope"), pending: null, observations: [], status: "queued", assessment: null, review: null };
    state.candidates.push(candidate); await save();
    await recordCandidate(candidate, capability);
    state.candidates.find(item => item.id === id)!.registered = true; await save();
    return candidateResult(state.candidates.find(item => item.id === id)!);
  }
  if (action === "report") {
    exact(input, []);
    const groups = { supportedCandidates: [] as JsonObject[], refutedCandidates: [] as JsonObject[], unresolved: [] as JsonObject[] };
    for (const candidate of state.candidates) {
      const row = { ...candidate, status: !candidate.registered ? "registration_unconfirmed" : candidate.pending !== null ? "interrupted"
        : candidate.review && !candidate.reviewRecorded ? "review_unconfirmed" : candidate.status, findingVerified: false };
      if (candidate.reviewRecorded && candidate.review?.outcome === "supported") groups.supportedCandidates.push(row);
      else if (candidate.reviewRecorded && candidate.review?.outcome === "refuted") groups.refutedCandidates.push(row);
      else groups.unresolved.push(row);
    }
    const surface = await capability("traceforge.scenario.state@1", "read", { operation: "read", key: "web.surface.v1" }, "report-surface");
    const snapshot = surface.output?.value;
    const reportRefs = unique(state.candidates.flatMap(candidate => [...(candidate.registered ? [`knowledge-node:${candidate.hypothesisId}`] : []), ...candidate.basisRefs,
      ...candidate.observations.flatMap(item => item.refs), ...(candidate.reviewRecorded ? [`knowledge-node:web-review:${sha(candidate.hypothesisId)}`] : [])]));
    return succeeded("Black-box investigation report assembled; no verified findings inferred", {
      outputKind: "report", schemaVersion: 1, ...groups, verifiedFindings: [], verifiedFindingCoverage: "not_loaded", activeCandidateId: state.active,
      referenceListTruncated: reportRefs.length > 512,
      coverage: { candidateCount: state.candidates.length, reviewedCount: state.candidates.filter(item => item.reviewRecorded).length,
        anonymousVisited: snapshot?.visited?.length ?? 0, anonymousQueued: snapshot?.queue?.length ?? 0, anonymousSkipped: snapshot?.skipped ?? [], anonymousPending: snapshot?.pending ?? null,
        complete: false },
      limitations: ["Bounded HTTP coverage only; authenticated surfaces are separate inventories. Counts are retained checkpoints, not exhaustive coverage.",
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
  const plan = parsePlan(input.plan), fingerprint = sha(JSON.stringify(plan));
  const budget = boundedInteger(input.maxRequests ?? 6, 1, 6, "Workflow request budget");
  const workId = requiredText(context.workId, "Validation Work id");
  if (candidate.fingerprint !== null && candidate.fingerprint !== fingerprint) throw new Error("Validation plan cannot change during continuation");
  if (candidate.workId !== null && candidate.workId !== workId) throw new Error("Resume using the original validation Work");
  if (state.active !== null && state.active !== candidate.id) throw new Error("Another validation candidate is active");
  if (candidate.pending !== null || ["observed", "stopped", "reviewed"].includes(candidate.status)) return candidateResult(candidate);
  // Validate all exact targets before a possibly mutating preparation, then recheck at each dispatch.
  for (const url of unique([...plan.prepare.map(step => step.request.url as string), plan.baseline.url as string, plan.candidate.url as string])) {
    await capability("traceforge.scenario.authorization@1", "authorize_resource", {
      action: "web.request.replay", resourceKind: "network.url", value: url,
    }, `workflow-preflight:${sha(url)}`);
  }
  candidate.fingerprint = fingerprint; candidate.workId = workId; candidate.status = "running"; state.active = candidate.id;
  await save(); candidate = state.candidates.find(item => item.id === candidateId)!;
  const sequence = [...plan.prepare.map((step, i) => ({ stage: `prepare:${i}`, ...step })),
    ...Array.from({ length: plan.rounds * 2 }, (_, i) => ({ stage: `${i % 2 === 0 ? "baseline" : "candidate"}:${Math.floor(i / 2)}`,
      request: i % 2 === 0 ? plan.baseline : plan.candidate, expectedStatuses: [] as number[] }))];
  for (let used = 0; used < budget && candidate.observations.length < sequence.length; used++) {
    const step = sequence[candidate.observations.length]!;
    await capability("traceforge.scenario.authorization@1", "authorize_resource", {
      action: "web.request.replay", resourceKind: "network.url", value: step.request.url,
    }, `workflow-authorize:${step.stage}`);
    candidate.pending = step.stage; await save(); candidate = state.candidates.find(item => item.id === candidateId)!;
    const response = await dispatch(step.request, `workflow:${candidate.hypothesisId}:${step.stage}`);
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
    } else if (candidate.observations.length === sequence.length) {
      candidate.status = "observed"; candidate.assessment = assess(candidate.observations.filter(item => !item.stage.startsWith("prepare:")));
    }
    await save(); candidate = state.candidates.find(item => item.id === candidateId)!;
    if (candidate.status !== "running") break;
  }
  return candidateResult(candidate);
}

function parsePlan(value: unknown) {
  const plan = plainObject(value, "Validation plan"); exact(plan, ["prepare", "baseline", "candidate", "rounds", "changedCondition"]);
  const changedCondition = requiredText(plan.changedCondition, "Controlled change rationale");
  if (!Array.isArray(plan.prepare) || plan.prepare.length > 4) throw new Error("At most four preconditions are supported");
  const prepare = plan.prepare.map(value => {
    const step = plainObject(value, "Precondition"); exact(step, ["request", "expectedStatuses"]);
    if (!Array.isArray(step.expectedStatuses) || step.expectedStatuses.length < 1 || step.expectedStatuses.length > 8) throw new Error("Preconditions need bounded expected statuses");
    return { request: parseRequest(step.request, true), purpose: requiredText(step.request.purpose, "Precondition purpose"), expectedStatuses: unique(step.expectedStatuses.map(status => boundedInteger(status, 100, 599, "Expected status"))) };
  });
  const baseline = parseRequest(plan.baseline, false), candidate = parseRequest(plan.candidate, false);
  const changed = ["url", "method", "sessionId", "headers"].filter(key => JSON.stringify(baseline[key]) !== JSON.stringify(candidate[key]));
  if (changed.length !== 1) throw new Error("Change exactly one comparison request dimension");
  return { prepare, baseline, candidate, rounds: boundedInteger(plan.rounds ?? 2, 2, 3, "Comparison rounds"), changedCondition };
}

function parseRequest(value: unknown, prepare: boolean): JsonObject {
  const request = plainObject(value, "Planned request");
  exact(request, ["url", "method", "sessionId", "headers", "bodyBase64", "secretBody", "captures", "purpose"]);
  const method = requiredText(request.method ?? "GET", "Method").toUpperCase();
  if (!(prepare ? ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] : ["GET", "HEAD"]).includes(method)) throw new Error("Unsupported workflow method");
  if (prepare) requiredText(request.purpose, "Precondition purpose and expected side effects");
  if (!prepare && ["bodyBase64", "secretBody", "captures", "purpose"].some(key => request[key] !== undefined)) throw new Error("Comparison requests cannot have preparation fields");
  const headers = request.headers === undefined ? {} : plainObject(request.headers, "Headers");
  if (Object.keys(headers).length > 16) throw new Error("Too many headers");
  const normalized: Record<string, string> = {};
  for (const name of Object.keys(headers).sort()) {
    const lower = name.toLowerCase();
    if (!/^[a-z0-9-]+$/.test(lower) || ["authorization", "proxy-authorization", "cookie", "set-cookie", "host"].includes(lower) || lower in normalized) throw new Error("Use Host Sessions for credentials; header is invalid");
    normalized[lower] = requiredText(headers[name], "Header value");
  }
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
  if (state.version !== 1 || !Array.isArray(state.candidates) || state.candidates.length > 16
    || (state.active !== null && !state.candidates.some(item => item.id === state.active))) throw new Error("Invalid investigation checkpoint");
  for (const candidate of state.candidates) {
    if (!Array.isArray(candidate.observations) || candidate.observations.length > 10
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
    ...candidate, status: candidate.pending === null ? candidate.status : "interrupted", findingVerified: false,
    outputKind: candidate.pending !== null || candidate.status === "stopped" ? "limitation" : candidate.status === "queued" ? "hypothesis"
      : candidate.reviewRecorded ? candidate.review?.outcome === "inconclusive" ? "limitation" : "validation_conclusion" : "surface_observation",
    limitations: ["No automatic Finding verification. Resume the same plan in the original validation Work; unknown effects require review and remain fenced."],
  }, unique([`knowledge-node:${candidate.hypothesisId}`, ...candidate.basisRefs, ...candidate.observations.flatMap(item => item.refs),
    ...(candidate.reviewRecorded ? [`knowledge-node:web-review:${sha(candidate.hypothesisId)}`] : [])]));
}
