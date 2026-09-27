import { BudgetExhausted } from "./budgets.mjs";
import { canonicalHttpUrl, exact, plainObject, requiredText } from "./validation.mjs";
import { experimentFields } from "./request-fields.mjs";
export function parseExperimentRequest(value, format, allowPreparationFields = false) {
    const request = plainObject(value, format === "comparison" ? "Comparison request" : "Planned request");
    exact(request, allowPreparationFields && format === "workflow"
        ? ["url", "method", "sessionId", "headers", "bodyBase64", "secretBody", "captures", "purpose"]
        : ["url", "method", "sessionId", "headers", "bodyBase64"]);
    const fields = experimentFields(request);
    const url = canonicalHttpUrl(request.url, format === "comparison" ? "Comparison URL" : "Workflow URL");
    if (format === "comparison") {
        return {
            url, method: fields.method,
            sessionId: request.sessionId == null ? null : requiredText(request.sessionId, "Comparison Session"),
            ...(Object.keys(fields.headers).length ? { headers: fields.headers } : {}),
            ...(fields.bodyBase64 === undefined ? {} : { bodyBase64: fields.bodyBase64 }),
        };
    }
    return {
        url, method: fields.method, headers: fields.headers,
        ...(request.sessionId === undefined ? {} : { sessionId: requiredText(request.sessionId, "Session id") }),
        ...(fields.bodyBase64 === undefined ? {} : { bodyBase64: fields.bodyBase64 }),
    };
}
/** Adapt either persisted observation format to one internal experiment shape. */
export function toExperimentObservation(row) {
    const digest = "digest" in row && row.digest !== undefined ? row.digest : "bodySha256" in row ? row.bodySha256 : undefined;
    if (typeof digest !== "string")
        throw new Error("Experiment observation is missing its body digest");
    return { status: row.status, bytes: row.bytes, digest, truncated: row.truncated, refs: row.refs };
}
const signature = (row) => JSON.stringify([row.status, row.bytes, row.digest]);
function assessObservations(observations, groups, complete) {
    if (!complete)
        return "insufficient_observations";
    if (observations.some(row => row.truncated))
        return "truncated_observations";
    if (groups.some(group => !group.stable))
        return "unstable_observations";
    if (groups.some(group => group.complete && group.different))
        return "repeatable_difference";
    return "no_observed_difference";
}
/** Observations are alternating baseline/candidate requests in variant-sized blocks. */
export function evaluateExperiment(observations, rounds, variantCount, complete) {
    if (observations.length > rounds * 2 * variantCount)
        throw new Error("Experiment observations exceed the planned matrix");
    const baselines = observations.filter((_, index) => index % 2 === 0);
    const candidates = observations.filter((_, index) => index % 2 === 1);
    const stable = (rows) => new Set(rows.map(signature)).size === 1;
    const pairs = candidates.map((item, index) => ({
        round: index % rounds + 1,
        variantIndex: Math.floor(index / rounds),
        statusChanged: item.status !== baselines[index].status,
        bodyChanged: item.digest !== baselines[index].digest,
        bytesChanged: item.bytes !== baselines[index].bytes,
        refs: [...baselines[index].refs, ...item.refs],
    }));
    const groups = Array.from({ length: Math.ceil(candidates.length / rounds) }, (_, index) => {
        const baseline = baselines.slice(index * rounds, (index + 1) * rounds);
        const candidate = candidates.slice(index * rounds, (index + 1) * rounds);
        return {
            variantIndex: index,
            complete: candidate.length === rounds,
            stable: stable(baseline) && stable(candidate),
            different: candidate.length > 0 && signature(baseline[0]) !== signature(candidate[0]),
            pairs: pairs.slice(index * rounds, (index + 1) * rounds),
        };
    });
    const variantAssessments = groups.filter(group => group.complete).map(group => ({
        variantIndex: group.variantIndex,
        assessment: assessObservations(observations.slice(group.variantIndex * rounds * 2, (group.variantIndex + 1) * rounds * 2), [group], true),
    }));
    const assessment = assessObservations(observations, groups, complete);
    return { assessment, variantAssessments, pairs, groups };
}
// The 90 s dispatch window plus a final request of at most 15 s leaves room
// inside the tool's 125 s timeout for evidence and checkpoint writes.
const LOOP_BUDGET_MS = 90_000;
const MAX_REQUEST_MS = 15_000;
const MIN_REQUEST_MS = 1_000;
/** Keep authorization, durable intent, dispatch and evidence in one fenced order. */
export async function runFencedExperiment(operation) {
    const deadline = Date.now() + LOOP_BUDGET_MS;
    for (let used = 0; used < operation.maxRequests && operation.completedRequests() < operation.steps.length && Date.now() < deadline; used++) {
        const index = operation.completedRequests();
        const step = operation.steps[index];
        const timeoutMs = Math.min(MAX_REQUEST_MS, deadline + MAX_REQUEST_MS - Date.now());
        if (timeoutMs < MIN_REQUEST_MS)
            break;
        await operation.authorize(step, index);
        await operation.persistPending(step, index);
        let response;
        try {
            response = await operation.dispatch(step, index, timeoutMs);
        }
        catch (error) {
            if (error instanceof BudgetExhausted)
                await operation.clearPendingOnBudgetExhaustion(step, index);
            throw error;
        }
        await operation.record(step, index, response);
        if (operation.shouldStop())
            break;
    }
}
