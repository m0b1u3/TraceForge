import { boundedInteger, canonicalHttpUrl, exact, plainObject, requiredText, sha, shaBytes, stringRecord, succeeded, unique } from "./validation.mjs";
import { inspectDocument } from "./surface-document.mjs";
import { registerInventory, surfaceKey } from "./surface-inventory.mjs";
import { budgets, BudgetExhausted } from "./budgets.mjs";
import { observationHighlights, observationTerms } from "./observations.mjs";
export async function exploreSurface(input, capability) {
    const limits = await budgets(capability);
    exact(input, ["seeds", "headers", "maxRequests", "maxLinksPerPage", "responseLimitBytes", "sessionId", "interestTerms"]);
    const terms = observationTerms(input.interestTerms);
    if (!Array.isArray(input.seeds) || input.seeds.length > 16)
        throw new Error("Surface seeds are invalid");
    const seeds = input.seeds.map((item) => canonicalHttpUrl(item, "Surface seed"));
    const headers = input.headers === undefined ? {} : stringRecord(input.headers, "Surface headers");
    const maximum = boundedInteger(input.maxRequests ?? 4, 1, 8, "Surface request limit");
    const maximumLinks = boundedInteger(input.maxLinksPerPage ?? 24, 1, 64, "Surface link limit");
    const responseLimitBytes = boundedInteger(input.responseLimitBytes ?? 256 * 1024, 1024, 1024 * 1024, "Surface response limit");
    const sessionId = input.sessionId === undefined ? null : requiredText(input.sessionId, "Session id");
    const stateKey = surfaceKey(sessionId);
    await registerInventory(capability, sessionId);
    const loaded = await capability("traceforge.scenario.state@1", "read", { operation: "read", key: stateKey }, "surface-state-read");
    let state = restoreSurfaceState(loaded.output), revision = loaded.output?.revision ?? 0;
    if (state.pending !== null)
        return succeeded("Surface request outcome is unconfirmed; automatic replay is blocked", {
            status: "interrupted", pendingUrl: state.pending, observations: state.observations, contextHighlights: observationHighlights(state.observations, terms), queued: state.queue,
            limitations: ["Inspect attributed traffic and evidence before further discovery. Do not start another exploration to replay the unknown request."],
            resume: { stateKey, revision },
        }, state.observations.flatMap(item => [item.networkReceipt, ...(item.evidenceRefs ?? [])]));
    const origins = new Set([...state.seeds, ...seeds].map((value) => new URL(value).origin));
    const combinedSeeds = unique([...state.seeds, ...seeds]);
    if (combinedSeeds.length > 16)
        throw new Error("Surface seed capacity exhausted; preserve existing coverage and report the limit");
    state.seeds = combinedSeeds;
    const queue = unique([...state.queue, ...seeds]).filter((value) => !state.visited.includes(value));
    state.omissions.queuedUrls += Math.max(0, queue.length - 32);
    state.queue = queue.slice(0, 32);
    if (!state.queue.length && !state.visited.length)
        throw new Error("At least one Surface seed is required for a new exploration");
    const invocationObservations = [], refs = [];
    let step = 0;
    while (step < maximum && state.queue.length && state.visited.length < limits.urls) {
        const url = state.queue.shift();
        if (state.visited.includes(url))
            continue;
        const key = sha(url);
        let authorization;
        try {
            authorization = await capability("traceforge.scenario.authorization@1", "authorize_resource", { action: "web.request.replay", resourceKind: "network.url", value: url }, `surface-authorization:${key}`);
        }
        catch {
            state.visited.push(url);
            state.skipped.push({ url, reason: "authorization_not_confirmed" });
            state.omissions.skipped += Math.max(0, state.skipped.length - 16);
            state.skipped = state.skipped.slice(-16);
            ({ state, revision } = await saveSurface(capability, state, revision, step, stateKey));
            step += 1;
            continue;
        }
        state.pending = url;
        ({ state, revision } = await saveSurface(capability, state, revision, step, stateKey));
        const execution = await capability("traceforge.scenario.execution@1", sessionId ? "request_http_session" : "request_http", {
            authorizationAction: "web.request.replay", ...(sessionId ? { sessionAuthorizationAction: "web.session.use", sessionId } : {}),
            url: authorization.output.canonicalValue, method: "GET", headers, bodyBase64: "", timeoutMs: 10000, responseLimitBytes,
        }, `surface-http:${key}`).catch(async (error) => { if (error instanceof BudgetExhausted) {
            state.pending = null;
            state.queue.unshift(url);
            ({ state, revision } = await saveSurface(capability, state, revision, step, stateKey));
        } throw error; });
        const response = plainObject(execution.output, "Surface HTTP response"), body = decodeBody(response.bodyBase64), contentType = header(response.headers, "content-type");
        const links = isHtml(contentType) ? inspectDocument(body, url, origins, maximumLinks)
            : { sameOrigin: [], external: [], forms: [], hintsTruncated: false, parserLimitations: ["Non-HTML response; no static document extraction performed."] };
        const discovered = links.sameOrigin.filter((value) => !state.visited.includes(value) && !state.queue.includes(value));
        const admitted = discovered.slice(0, Math.max(0, 32 - state.queue.length));
        state.omissions.queuedUrls += discovered.length - admitted.length;
        state.omissions.documentHints += links.hintsTruncated ? 1 : 0;
        state.queue.push(...admitted);
        const bodyDigest = `sha256:${shaBytes(Buffer.from(response.bodyBase64, "base64"))}`;
        const receiptId = requiredText(response.receipt?.id, "Network receipt id");
        const observation = { url, status: boundedInteger(response.status, 100, 599, "HTTP status"), contentType: contentType.slice(0, 256),
            responseBytes: boundedInteger(response.responseBytes, 0, 1024 * 1024, "HTTP response bytes"), bodyTruncated: Boolean(response.bodyTruncated), bodyDigest,
            snippet: textSnippet(body, 1024), discoveredUrls: links.sameOrigin.slice(0, 8).map((value) => value.slice(0, 512)),
            forms: links.forms, hintsTruncated: links.hintsTruncated, parserLimitations: links.parserLimitations,
            externalOrigins: unique(links.external.map((value) => new URL(value).origin)).slice(0, 8).map((value) => value.slice(0, 256)),
            networkReceipt: `network-receipt:${receiptId}` };
        const artifactReceipt = await capability("traceforge.scenario.artifacts@1", "record", { operation: "record", commandId: "observation",
            kind: "web.http.observation", summary: `GET ${url} returned ${observation.status}`, contentRef: observation.networkReceipt, digest: bodyDigest,
            byteSize: observation.responseBytes, metadata: observation }, `surface-artifact:${key}`);
        const artifact = artifactReceipt.output;
        const evidenceReceipt = await capability("traceforge.scenario.evidence@1", "record_node", { commandId: "observation", node: {
                id: `web-observation:${sha(`${url}\0${receiptId}`)}`, kind: "fact", title: `Observed ${url}`,
                summary: `GET returned ${observation.status} (${contentType || "unknown content type"})`, status: "active", confidence: 1,
                properties: { url, status: observation.status, contentType: observation.contentType, responseBytes: observation.responseBytes, bodyTruncated: observation.bodyTruncated,
                    bodyDigest, artifactId: artifact.id, networkReceipt: observation.networkReceipt, discoveredUrls: observation.discoveredUrls,
                    externalOrigins: observation.externalOrigins, forms: observation.forms, hintsTruncated: observation.hintsTruncated },
            } }, `surface-evidence:${key}`);
        const saved = { ...observation, artifactId: artifact.id, evidenceRefs: evidenceReceipt.refs };
        state.visited.push(url);
        state.observations.push(saved);
        state.visited = unique(state.visited);
        state.omissions.observations += Math.max(0, state.observations.length - 16);
        state.observations = state.observations.slice(-16);
        state.pending = null;
        invocationObservations.push(saved);
        refs.push(artifact.contentRef, ...artifactReceipt.refs, ...evidenceReceipt.refs, ...execution.refs);
        ({ state, revision } = await saveSurface(capability, state, revision, step, stateKey));
        step += 1;
    }
    ({ state, revision } = await saveSurface(capability, state, revision, step, stateKey));
    const result = { schemaVersion: 1, contextHighlights: observationHighlights(state.observations, terms), observations: invocationObservations, coverage: { seedCount: state.seeds.length, visitedCount: state.visited.length,
            queuedCount: state.queue.length, skippedCount: state.skipped.length, observationCount: state.observations.length, requestBudget: maximum,
            budgetExhausted: step >= maximum && state.queue.length > 0, capacityExhausted: state.visited.length >= limits.urls,
            omissions: state.omissions, complete: false }, queued: state.queue.slice(0, 32), skipped: state.skipped.slice(-16), resume: { stateKey, revision } };
    return succeeded(`Explored ${invocationObservations.length} authorized URL(s); ${state.queue.length} remain queued`, result, refs);
}
async function saveSurface(capability, state, revision, step, stateKey) {
    while (Buffer.byteLength(JSON.stringify(state)) > 192 * 1024 && state.observations.length) {
        state.observations.shift();
        state.omissions.observations += 1;
    }
    if (Buffer.byteLength(JSON.stringify(state)) > 192 * 1024)
        throw new Error("Surface checkpoint capacity exhausted");
    const receipt = await capability("traceforge.scenario.state@1", "compare_and_set", { operation: "compare_and_set",
        commandId: `checkpoint:${stateKey}:${revision}`, key: stateKey, expectedRevision: revision, value: state }, `surface-state:${stateKey}:${revision}`);
    return { state: restoreSurfaceState(receipt.output), revision: receipt.output.revision };
}
function restoreSurfaceState(record) {
    if (record === null || record === undefined)
        return { schemaVersion: 1, seeds: [], queue: [], visited: [], observations: [], skipped: [], pending: null,
            omissions: { queuedUrls: 0, observations: 0, skipped: 0, documentHints: 0, legacyUnknown: false } };
    const value = plainObject(record.value, "Surface state");
    if (value.schemaVersion !== 1 || ![value.seeds, value.queue, value.visited, value.observations, value.skipped].every(Array.isArray))
        throw new Error("Surface state is incompatible");
    return { schemaVersion: 1, seeds: value.seeds.map((item) => canonicalHttpUrl(item, "Saved seed")).slice(0, 16),
        queue: value.queue.map((item) => canonicalHttpUrl(item, "Saved queued URL")).slice(0, 32),
        visited: value.visited.map((item) => canonicalHttpUrl(item, "Saved visited URL")).slice(0, 512),
        observations: value.observations.slice(-16), skipped: value.skipped.slice(-16), pending: value.pending == null ? null : canonicalHttpUrl(value.pending, "Pending Surface URL"),
        omissions: value.omissions == null ? { queuedUrls: 0, observations: 0, skipped: 0, documentHints: 0, legacyUnknown: true }
            : { queuedUrls: boundedInteger(value.omissions.queuedUrls, 0, Number.MAX_SAFE_INTEGER, "Omitted queue count"),
                observations: boundedInteger(value.omissions.observations, 0, Number.MAX_SAFE_INTEGER, "Omitted observation count"),
                skipped: boundedInteger(value.omissions.skipped, 0, Number.MAX_SAFE_INTEGER, "Omitted skip count"),
                documentHints: boundedInteger(value.omissions.documentHints, 0, Number.MAX_SAFE_INTEGER, "Omitted hint count"), legacyUnknown: value.omissions.legacyUnknown !== false } };
}
export function discoverLinks(body, base, origins, maximum) {
    const { sameOrigin, external } = inspectDocument(body, base, origins, maximum);
    return { sameOrigin, external };
}
function decodeBody(value) {
    const encoded = typeof value === "string" ? value : "";
    if (Buffer.from(encoded, "base64").toString("base64") !== encoded)
        throw new Error("Surface response body is invalid");
    return Buffer.from(encoded, "base64").toString("utf8");
}
function header(headers, name) {
    if (!Array.isArray(headers))
        return "";
    const found = headers.find((item) => item && typeof item.name === "string" && item.name.toLowerCase() === name);
    return typeof found?.value === "string" ? found.value : "";
}
function isHtml(contentType) { return /(?:text\/html|application\/xhtml\+xml)/i.test(contentType); }
function textSnippet(value, maximum) {
    const text = value.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ").replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
        .replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    return Buffer.from(text).subarray(0, maximum).toString("utf8").replace(/\uFFFD$/, "");
}
