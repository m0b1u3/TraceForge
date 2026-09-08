import type { CapabilityReceipt, JsonObject, ToolResult } from "./contracts.mjs";
import { boundedInteger, canonicalHttpUrl, exact, plainObject, requiredBase64, requiredText, sha, shaBytes, succeeded } from "./validation.mjs";

type Capability = (name: string, action: string, input: unknown, suffix: string) => Promise<CapabilityReceipt>;
interface RequestSpec { url: string; method: "GET" | "HEAD"; sessionId: string | null }
interface Observation { step: number; side: "baseline" | "candidate"; status: number; bytes: number;
  bodySha256: string; truncated: boolean; receiptRef: string; refs: string[] }
interface ComparisonState { version: 1; fingerprint: string; pending: number | null; observations: Observation[] }

// This is Web experiment policy. Core only supplies authorization, CAS state and evidence ports.
export async function compareHttp(input: JsonObject, capability: Capability,
  request: (spec: RequestSpec, step: number) => Promise<ToolResult>): Promise<ToolResult> {
  exact(input, ["experimentId", "hypothesisId", "baseline", "candidate", "rounds", "maxRequests"]);
  const experimentId = requiredText(input.experimentId, "Experiment id");
  const hypothesisId = requiredText(input.hypothesisId, "Hypothesis id");
  const baseline = parseRequest(input.baseline), candidate = parseRequest(input.candidate);
  const dimensions = (["url", "method", "sessionId"] as const).filter(key => baseline[key] !== candidate[key]);
  if (dimensions.length !== 1) throw new Error("Comparison requires exactly one changed request dimension");
  const rounds = boundedInteger(input.rounds ?? 2, 2, 3, "Comparison rounds");
  const maxRequests = boundedInteger(input.maxRequests ?? 4, 1, 6, "Comparison request budget");
  const fingerprint = sha(JSON.stringify({ hypothesisId, baseline, candidate, rounds }));
  const stateKey = `web.comparison.v1:${sha(experimentId)}`;
  const loaded = await capability("traceforge.scenario.state@1", "read", { operation: "read", key: stateKey }, "comparison-read");
  let revision = loaded.output?.revision ?? 0;
  let state: ComparisonState = loaded.output == null
    ? { version: 1, fingerprint, pending: null, observations: [] }
    : restore(loaded.output.value, fingerprint, rounds * 2);
  if (state.pending !== null) return result("interrupted", state, rounds, dimensions[0]!);
  const save = async () => {
    const saved = await capability("traceforge.scenario.state@1", "compare_and_set", {
      operation: "compare_and_set", commandId: `${stateKey}:${revision}`, key: stateKey,
      expectedRevision: revision, value: state,
    }, `comparison-save:${revision}`);
    revision = saved.output.revision;
    state = restore(saved.output.value, fingerprint, rounds * 2);
  };
  for (let used = 0; used < maxRequests && state.observations.length < rounds * 2; used++) {
    const step = state.observations.length;
    const spec = step % 2 === 0 ? baseline : candidate;
    // Recheck the exact target before persisting intent; dispatch rechecks it again through the request tool.
    await capability("traceforge.scenario.authorization@1", "authorize_resource", {
      action: "web.request.replay", resourceKind: "network.url", value: spec.url,
    }, `comparison-authorize:${step}`);
    state.pending = step;
    await save(); // A crash or unknown response after this point must never automatically repeat the request.
    const response = await request(spec, step);
    const body = plainObject(JSON.parse(response.raw), "Comparison response");
    const encoded = requiredBase64(body.bodyBase64);
    const bytes = Buffer.from(encoded, "base64");
    const receiptRef = `network-receipt:${requiredText(body.receipt?.id, "Network receipt")}`;
    const observation: Observation = {
      step, side: step % 2 === 0 ? "baseline" : "candidate",
      status: boundedInteger(body.status, 100, 599, "HTTP status"),
      bytes: boundedInteger(body.responseBytes, 0, 1024 * 1024, "Response bytes"),
      bodySha256: shaBytes(bytes), truncated: body.bodyTruncated !== false,
      receiptRef, refs: [receiptRef],
    };
    const evidence = await capability("traceforge.scenario.evidence@1", "record_node", {
      commandId: `${stateKey}:${step}`, node: {
        id: `web-comparison:${sha(`${experimentId}:${fingerprint}:${step}`)}`, kind: "fact", status: "active", confidence: 1,
        title: `HTTP comparison ${observation.side} observation`, summary: "Recorded a controlled HTTP observation; no finding inferred.",
        properties: { hypothesisId, experimentFingerprint: fingerprint, ...observation },
      },
    }, `comparison-evidence:${step}`);
    observation.refs.push(...evidence.refs);
    state.observations.push(observation);
    state.pending = null;
    await save();
  }
  return result(state.observations.length === rounds * 2 ? "complete" : "in_progress", state, rounds, dimensions[0]!);
}

function parseRequest(value: unknown): RequestSpec {
  const request = plainObject(value, "Comparison request");
  exact(request, ["url", "method", "sessionId"]);
  const method = requiredText(request.method ?? "GET", "Comparison method").toUpperCase();
  if (method !== "GET" && method !== "HEAD") throw new Error("Comparison supports GET and HEAD only");
  return { url: canonicalHttpUrl(request.url, "Comparison URL"), method,
    sessionId: request.sessionId == null ? null : requiredText(request.sessionId, "Comparison Session") };
}

function restore(value: unknown, fingerprint: string, maximum: number): ComparisonState {
  const state = plainObject(value, "Comparison state");
  exact(state, ["version", "fingerprint", "pending", "observations"]);
  if (state.version !== 1 || state.fingerprint !== fingerprint) throw new Error("Experiment id already binds a different comparison");
  if (!Array.isArray(state.observations) || state.observations.length > maximum
    || (state.pending !== null && (state.pending !== state.observations.length || state.pending >= maximum))) {
    throw new Error("Comparison checkpoint is invalid");
  }
  for (const [step, item] of state.observations.entries()) {
    const row = plainObject(item, "Comparison observation");
    if (row.step !== step || row.side !== (step % 2 === 0 ? "baseline" : "candidate")
      || !/^[a-f0-9]{64}$/.test(row.bodySha256) || typeof row.truncated !== "boolean"
      || typeof row.receiptRef !== "string" || !row.receiptRef.startsWith("network-receipt:")
      || !Array.isArray(row.refs) || row.refs.length > 64 || row.refs.some((ref: unknown) => typeof ref !== "string")) {
      throw new Error("Comparison observation is invalid");
    }
    boundedInteger(row.status, 100, 599, "Saved HTTP status");
    boundedInteger(row.bytes, 0, 1024 * 1024, "Saved response bytes");
  }
  return structuredClone(state) as ComparisonState;
}

function result(status: "interrupted" | "complete" | "in_progress", state: ComparisonState, rounds: number, dimension: string): ToolResult {
  const signature = (observation: Observation) => JSON.stringify([observation.status, observation.bytes, observation.bodySha256]);
  const baselines = state.observations.filter(item => item.side === "baseline");
  const candidates = state.observations.filter(item => item.side === "candidate");
  const stable = (items: Observation[]) => new Set(items.map(signature)).size === 1;
  const pairs = candidates.map((item, i) => ({ round: i + 1,
    statusChanged: item.status !== baselines[i]!.status, bodyChanged: item.bodySha256 !== baselines[i]!.bodySha256,
    bytesChanged: item.bytes !== baselines[i]!.bytes, refs: [...baselines[i]!.refs, ...item.refs] }));
  const assessment = status !== "complete" ? "insufficient_observations"
    : state.observations.some(item => item.truncated) ? "truncated_observations"
    : !stable(baselines) || !stable(candidates) ? "unstable_observations"
    : signature(baselines[0]!) === signature(candidates[0]!) ? "no_observed_difference" : "repeatable_difference";
  return succeeded(`HTTP comparison ${status}: ${assessment}`, {
    status, assessment, changedDimension: dimension, completedRequests: state.observations.length, plannedRequests: rounds * 2,
    observations: state.observations, pairs, findingVerified: false,
    limitations: ["Response comparison alone does not establish causality, authorization expectations or security impact.",
      ...(status === "interrupted" ? ["A prior request or evidence checkpoint is unconfirmed. Inspect existing receipts; do not automatically repeat it."] : [])],
  }, state.observations.flatMap(item => item.refs));
}
