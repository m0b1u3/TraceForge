import { boundedInteger, canonicalHttpUrl, exact, plainObject, requiredBase64, requiredText, sha, shaBytes, stableJson, succeeded } from "./validation.mjs";
import { budgets, BudgetExhausted } from "./budgets.mjs";
import { observationHighlights } from "./observations.mjs";
import { experimentFields, changedDimensions } from "./request-fields.mjs";
// One call must finish inside the declared 125 s tool timeout: the loop stops
// dispatching after LOOP_BUDGET_MS and the last request may extend at most
// MAX_REQUEST_MS past it, leaving room for evidence and checkpoint writes.
const LOOP_BUDGET_MS = 90_000;
const MAX_REQUEST_MS = 15_000;
const MIN_REQUEST_MS = 1_000;
// This is Web experiment policy. Core only supplies authorization, CAS state and evidence ports.
export async function compareHttp(input, capability, request) {
    exact(input, ["experimentId", "hypothesisId", "baseline", "candidate", "candidates", "rounds", "maxRequests", "expectedSignals", "stopOn"]);
    const limits = await budgets(capability);
    const experimentId = requiredText(input.experimentId, "Experiment id");
    const hypothesisId = requiredText(input.hypothesisId, "Hypothesis id");
    if (input.candidate !== undefined && input.candidates !== undefined)
        throw new Error("Choose candidate or candidates, not both");
    if (input.candidate === undefined && input.candidates === undefined)
        throw new Error("Comparison requires a candidate or candidates");
    const variants = input.candidates ?? [input.candidate];
    if (!Array.isArray(variants) || variants.length < 1 || variants.length > limits.variants)
        throw new Error(`Variant budget exceeded (1–${limits.variants})`);
    const baseline = parseRequest(input.baseline), candidates = variants.map(parseRequest), candidate = candidates[0];
    for (const item of candidates)
        if (changedDimensions(baseline, item).length !== 1)
            throw new Error("Comparison requires exactly one changed request dimension per variant");
    const dimensions = changedDimensions(baseline, candidate);
    if (dimensions.length !== 1)
        throw new Error("Comparison requires exactly one changed request dimension");
    if (candidates.some(item => changedDimensions(baseline, item)[0] !== dimensions[0]))
        throw new Error("All variants must vary the same request dimension");
    const rounds = boundedInteger(input.rounds ?? 2, 2, 3, "Comparison rounds");
    const maxRequests = boundedInteger(input.maxRequests ?? Math.min(rounds * 2 * candidates.length, limits.requestsPerCall), 1, limits.requestsPerCall, "Comparison request budget");
    const expectedSignals = input.expectedSignals ?? ["statusChanged", "bodyChanged", "bytesChanged"], stopOn = input.stopOn ?? "never";
    if (!Array.isArray(expectedSignals) || !expectedSignals.length || expectedSignals.length > 3 || expectedSignals.some(v => !["statusChanged", "bodyChanged", "bytesChanged"].includes(v)) || !["never", "repeatable_difference"].includes(stopOn))
        throw new Error("Invalid experiment signals or stop condition");
    // Experiment identity binds the normalized request matrix, not input key order.
    const fingerprint = sha(stableJson({ hypothesisId, baseline, candidates, rounds, expectedSignals, stopOn }));
    const planned = rounds * 2 * candidates.length;
    const stateKey = `web.comparison.v1:${sha(experimentId)}`;
    const loaded = await capability("traceforge.scenario.state@1", "read", { operation: "read", key: stateKey }, "comparison-read");
    let revision = loaded.output?.revision ?? 0;
    let state = loaded.output == null
        ? { version: 1, fingerprint, pending: null, observations: [] }
        : restore(loaded.output.value, fingerprint, planned);
    const output = (status) => result(status, state, rounds, dimensions[0], candidates.length, expectedSignals);
    if (state.pending !== null)
        return output("interrupted");
    if (state.stopped)
        return output("complete");
    const save = async () => {
        const saved = await capability("traceforge.scenario.state@1", "compare_and_set", {
            operation: "compare_and_set", commandId: `${stateKey}:${revision}`, key: stateKey,
            expectedRevision: revision, value: state,
        }, `comparison-save:${revision}`);
        revision = saved.output.revision;
        state = restore(saved.output.value, fingerprint, planned);
    };
    const deadline = Date.now() + LOOP_BUDGET_MS;
    for (let used = 0; used < maxRequests && state.observations.length < planned && Date.now() < deadline; used++) {
        const step = state.observations.length;
        const spec = step % 2 === 0 ? baseline : candidates[Math.floor(step / (rounds * 2))];
        const requestTimeoutMs = Math.min(MAX_REQUEST_MS, deadline + MAX_REQUEST_MS - Date.now());
        if (requestTimeoutMs < MIN_REQUEST_MS)
            break;
        // Recheck the exact target before persisting intent; dispatch rechecks it again through the request tool.
        await capability("traceforge.scenario.authorization@1", "authorize_resource", {
            action: "web.request.replay", resourceKind: "network.url", value: spec.url,
        }, `comparison-authorize:${step}`);
        state.pending = step;
        await save(); // A crash or unknown response after this point must never automatically repeat the request.
        let response;
        try {
            response = await request(spec, step, requestTimeoutMs);
        }
        catch (error) {
            if (error instanceof BudgetExhausted) {
                state.pending = null;
                await save();
            }
            throw error;
        }
        const body = plainObject(JSON.parse(response.raw), "Comparison response");
        const encoded = requiredBase64(body.bodyBase64);
        const bytes = Buffer.from(encoded, "base64");
        const receiptRef = `network-receipt:${requiredText(body.receipt?.id, "Network receipt")}`;
        const observation = {
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
        if (stopOn === "repeatable_difference" && state.observations.length % (rounds * 2) === 0) {
            const group = state.observations.slice(-rounds * 2);
            const assessed = result("complete", { ...state, observations: group }, rounds, dimensions[0], 1, expectedSignals);
            const value = JSON.parse(assessed.raw);
            if (value.assessment === "repeatable_difference" && value.pairs.every((pair) => expectedSignals.some(signal => pair[signal] === true)))
                state.stopped = true;
        }
        await save();
        if (state.stopped)
            break;
    }
    return output(state.stopped || state.observations.length === planned ? "complete" : "in_progress");
}
function parseRequest(value) {
    const request = plainObject(value, "Comparison request");
    exact(request, ["url", "method", "sessionId", "headers", "bodyBase64"]);
    const fields = experimentFields(request), method = fields.method;
    return { url: canonicalHttpUrl(request.url, "Comparison URL"), method,
        sessionId: request.sessionId == null ? null : requiredText(request.sessionId, "Comparison Session"),
        ...(Object.keys(fields.headers).length ? { headers: fields.headers } : {}), ...(fields.bodyBase64 === undefined ? {} : { bodyBase64: fields.bodyBase64 }) };
}
function restore(value, fingerprint, maximum) {
    const state = plainObject(value, "Comparison state");
    exact(state, ["version", "fingerprint", "pending", "observations", "stopped"]);
    if (state.version !== 1 || state.fingerprint !== fingerprint)
        throw new Error("Experiment id already binds a different comparison");
    if ((state.stopped !== undefined && typeof state.stopped !== "boolean") || !Array.isArray(state.observations) || state.observations.length > maximum
        || (state.pending !== null && (state.pending !== state.observations.length || state.pending >= maximum))) {
        throw new Error("Comparison checkpoint is invalid");
    }
    for (const [step, item] of state.observations.entries()) {
        const row = plainObject(item, "Comparison observation");
        if (row.step !== step || row.side !== (step % 2 === 0 ? "baseline" : "candidate")
            || !/^[a-f0-9]{64}$/.test(row.bodySha256) || typeof row.truncated !== "boolean"
            || typeof row.receiptRef !== "string" || !row.receiptRef.startsWith("network-receipt:")
            || !Array.isArray(row.refs) || row.refs.length > 64 || row.refs.some((ref) => typeof ref !== "string")) {
            throw new Error("Comparison observation is invalid");
        }
        boundedInteger(row.status, 100, 599, "Saved HTTP status");
        boundedInteger(row.bytes, 0, 1024 * 1024, "Saved response bytes");
    }
    return structuredClone(state);
}
function result(status, state, rounds, dimension, variantCount = 1, expectedSignals = []) {
    const signature = (observation) => JSON.stringify([observation.status, observation.bytes, observation.bodySha256]);
    const baselines = state.observations.filter(item => item.side === "baseline");
    const candidates = state.observations.filter(item => item.side === "candidate");
    const stable = (items) => new Set(items.map(signature)).size === 1;
    const pairs = candidates.map((item, i) => ({ round: i % rounds + 1, variantIndex: Math.floor(i / rounds),
        statusChanged: item.status !== baselines[i].status, bodyChanged: item.bodySha256 !== baselines[i].bodySha256,
        bytesChanged: item.bytes !== baselines[i].bytes, refs: [...baselines[i].refs, ...item.refs] }));
    const groups = Array.from({ length: Math.ceil(candidates.length / rounds) }, (_, index) => {
        const b = baselines.slice(index * rounds, (index + 1) * rounds), c = candidates.slice(index * rounds, (index + 1) * rounds);
        return { variantIndex: index, complete: c.length === rounds, stable: stable(b) && stable(c), different: !!c.length && signature(b[0]) !== signature(c[0]), pairs: pairs.slice(index * rounds, (index + 1) * rounds) };
    });
    const assessment = status !== "complete" ? "insufficient_observations"
        : state.observations.some(item => item.truncated) ? "truncated_observations"
            : groups.some(group => !group.stable) ? "unstable_observations"
                : groups.some(group => group.complete && group.different) ? "repeatable_difference" : "no_observed_difference";
    return succeeded(`HTTP comparison ${status}: ${assessment}`, {
        contextHighlights: observationHighlights(state.observations),
        status, assessment, changedDimension: dimension, completedRequests: state.observations.length, plannedRequests: rounds * 2 * variantCount,
        observations: state.observations, pairs, groups, expectedSignals, stoppedEarly: state.stopped === true, findingVerified: false,
        limitations: ["Response comparison alone does not establish causality, authorization expectations or security impact.",
            ...(status === "interrupted" ? ["A prior request or evidence checkpoint is unconfirmed. Inspect existing receipts; do not automatically repeat it."] : [])],
    }, state.observations.flatMap(item => item.refs));
}
