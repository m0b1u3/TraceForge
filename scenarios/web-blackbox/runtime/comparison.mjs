import { boundedInteger, exact, plainObject, requiredBase64, requiredText, sha, shaBytes, stableJson, succeeded } from "./validation.mjs";
import { budgets } from "./budgets.mjs";
import { observationHighlights } from "./observations.mjs";
import { changedDimensions } from "./request-fields.mjs";
import { evaluateExperiment, parseExperimentRequest, runFencedExperiment, toExperimentObservation } from "./experiment.mjs";
// This is Web experiment policy. Core only supplies authorization, CAS state and evidence ports.
export async function compareHttp(input, capability, request) {
    exact(input, ["experimentId", "hypothesisId", "baseline", "candidate", "candidates", "rounds", "maxRequests", "expectedSignals", "stopOn"]);
    const limits = await budgets(capability);
    const experimentId = requiredText(input.experimentId, "Experiment id");
    const hypothesisId = requiredText(input.hypothesisId, "Hypothesis id");
    if (input.candidate !== undefined && input.candidates !== undefined) {
        throw new Error("Choose candidate or candidates, not both");
    }
    if (input.candidate === undefined && input.candidates === undefined) {
        throw new Error("Comparison requires a candidate or candidates");
    }
    const variants = input.candidates ?? [input.candidate];
    if (!Array.isArray(variants) || variants.length < 1 || variants.length > limits.variants) {
        throw new Error(`Variant budget exceeded (1–${limits.variants})`);
    }
    const baseline = parseExperimentRequest(input.baseline, "comparison");
    const candidates = variants.map(value => parseExperimentRequest(value, "comparison"));
    const candidate = candidates[0];
    for (const item of candidates) {
        if (changedDimensions(baseline, item).length !== 1)
            throw new Error("Comparison requires exactly one changed request dimension per variant");
    }
    const dimensions = changedDimensions(baseline, candidate);
    if (dimensions.length !== 1)
        throw new Error("Comparison requires exactly one changed request dimension");
    if (candidates.some(item => changedDimensions(baseline, item)[0] !== dimensions[0])) {
        throw new Error("All variants must vary the same request dimension");
    }
    const rounds = boundedInteger(input.rounds ?? 2, 2, 3, "Comparison rounds");
    const maxRequests = boundedInteger(input.maxRequests ?? Math.min(rounds * 2 * candidates.length, limits.requestsPerCall), 1, limits.requestsPerCall, "Comparison request budget");
    const expectedSignals = (input.expectedSignals ?? ["statusChanged", "bodyChanged", "bytesChanged"]);
    const stopOn = input.stopOn ?? "never";
    if (!Array.isArray(expectedSignals) || !expectedSignals.length || expectedSignals.length > 3
        || expectedSignals.some(value => !["statusChanged", "bodyChanged", "bytesChanged"].includes(value))
        || !["never", "repeatable_difference"].includes(stopOn)) {
        throw new Error("Invalid experiment signals or stop condition");
    }
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
    const steps = Array.from({ length: planned }, (_, step) => step % 2 === 0 ? baseline : candidates[Math.floor(step / (rounds * 2))]);
    await runFencedExperiment({
        maxRequests,
        steps,
        completedRequests: () => state.observations.length,
        shouldStop: () => state.stopped === true,
        authorize: async (spec, step) => {
            // Recheck the exact target before intent is saved; dispatch rechecks it again.
            await capability("traceforge.scenario.authorization@1", "authorize_resource", {
                action: "web.request.replay", resourceKind: "network.url", value: spec.url,
            }, `comparison-authorize:${step}`);
        },
        persistPending: async (_, step) => {
            state.pending = step;
            await save(); // An unknown response after this point must never repeat the request automatically.
        },
        dispatch: (spec, step, timeoutMs) => request(spec, step, timeoutMs),
        clearPendingOnBudgetExhaustion: async () => {
            state.pending = null;
            await save();
        },
        record: async (_, step, response) => {
            const body = plainObject(response.output, "Comparison response");
            const bytes = Buffer.from(requiredBase64(body.bodyBase64), "base64");
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
                const group = state.observations.slice(-rounds * 2).map(toExperimentObservation);
                const evaluated = evaluateExperiment(group, rounds, 1, true);
                if (evaluated.assessment === "repeatable_difference"
                    && evaluated.pairs.every(pair => expectedSignals.some(signal => pair[signal] === true))) {
                    state.stopped = true;
                }
            }
            await save();
        },
    });
    return output(state.stopped || state.observations.length === planned ? "complete" : "in_progress");
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
    const { assessment, pairs, groups } = evaluateExperiment(state.observations.map(toExperimentObservation), rounds, variantCount, status === "complete");
    return succeeded(`HTTP comparison ${status}: ${assessment}`, {
        contextHighlights: observationHighlights(state.observations),
        status, assessment, changedDimension: dimension, completedRequests: state.observations.length, plannedRequests: rounds * 2 * variantCount,
        observations: state.observations, pairs, groups, expectedSignals, stoppedEarly: state.stopped === true, findingVerified: false,
        limitations: ["Response comparison alone does not establish causality, authorization expectations or security impact.",
            ...(status === "interrupted" ? ["A prior request or evidence checkpoint is unconfirmed. Inspect existing receipts; do not automatically repeat it."] : [])],
    }, state.observations.flatMap(item => item.refs));
}
