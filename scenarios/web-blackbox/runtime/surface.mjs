import { boundedInteger, canonicalHttpUrl, exact, plainObject, requiredText, sha, shaBytes, stringRecord, succeeded, unique } from "./validation.mjs";
export async function exploreSurface(input, capability) {
    exact(input, ["seeds", "headers", "maxRequests", "maxLinksPerPage", "responseLimitBytes", "sessionId"]);
    if (!Array.isArray(input.seeds) || input.seeds.length > 16)
        throw new Error("Surface seeds are invalid");
    const seeds = input.seeds.map((item) => canonicalHttpUrl(item, "Surface seed"));
    const headers = input.headers === undefined ? {} : stringRecord(input.headers, "Surface headers");
    const maximum = boundedInteger(input.maxRequests ?? 4, 1, 8, "Surface request limit");
    const maximumLinks = boundedInteger(input.maxLinksPerPage ?? 24, 1, 64, "Surface link limit");
    const responseLimitBytes = boundedInteger(input.responseLimitBytes ?? 256 * 1024, 1024, 1024 * 1024, "Surface response limit");
    const sessionId = input.sessionId === undefined ? null : requiredText(input.sessionId, "Session id");
    const stateKey = sessionId ? `web.surface.v1:${sha(sessionId).slice(0, 16)}` : "web.surface.v1";
    const loaded = await capability("traceforge.scenario.state@1", "read", { operation: "read", key: stateKey }, "surface-state-read");
    let state = restoreSurfaceState(loaded.output), revision = loaded.output?.revision ?? 0;
    const origins = new Set([...state.seeds, ...seeds].map((value) => new URL(value).origin));
    state.seeds = unique([...state.seeds, ...seeds]).slice(0, 16);
    state.queue = unique([...state.queue, ...seeds]).filter((value) => !state.visited.includes(value)).slice(0, 32);
    if (!state.queue.length && !state.visited.length)
        throw new Error("At least one Surface seed is required for a new exploration");
    const invocationObservations = [], refs = [];
    let step = 0;
    while (step < maximum && state.queue.length) {
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
            state.skipped.push({ url, reason: "not_authorized" });
            state.skipped = state.skipped.slice(-16);
            ({ state, revision } = await saveSurface(capability, state, revision, step, stateKey));
            step += 1;
            continue;
        }
        const execution = await capability("traceforge.scenario.execution@1", sessionId ? "request_http_session" : "request_http", {
            authorizationAction: "web.request.replay", ...(sessionId ? { sessionAuthorizationAction: "web.session.use", sessionId } : {}),
            url: authorization.output.canonicalValue, method: "GET", headers, bodyBase64: "", timeoutMs: 10000, responseLimitBytes,
        }, `surface-http:${key}`);
        const response = plainObject(execution.output, "Surface HTTP response"), body = decodeBody(response.bodyBase64), contentType = header(response.headers, "content-type");
        const links = isHtml(contentType) ? discoverLinks(body, url, origins, maximumLinks) : { sameOrigin: [], external: [] };
        const discovered = links.sameOrigin.filter((value) => !state.visited.includes(value) && !state.queue.includes(value));
        state.queue.push(...discovered.slice(0, Math.max(0, 32 - state.queue.length)));
        const bodyDigest = `sha256:${shaBytes(Buffer.from(response.bodyBase64, "base64"))}`;
        const receiptId = requiredText(response.receipt?.id, "Network receipt id");
        const observation = { url, status: boundedInteger(response.status, 100, 599, "HTTP status"), contentType: contentType.slice(0, 256),
            responseBytes: boundedInteger(response.responseBytes, 0, 1024 * 1024, "HTTP response bytes"), bodyTruncated: Boolean(response.bodyTruncated), bodyDigest,
            snippet: textSnippet(body, 1024), discoveredUrls: links.sameOrigin.slice(0, 8).map((value) => value.slice(0, 512)),
            externalOrigins: unique(links.external.map((value) => new URL(value).origin)).slice(0, 8).map((value) => value.slice(0, 256)),
            networkReceipt: `network-receipt:${receiptId}` };
        const artifactReceipt = await capability("traceforge.scenario.artifacts@1", "record", { operation: "record", commandId: "observation",
            kind: "web.http.observation", summary: `GET ${url} returned ${observation.status}`, contentRef: observation.networkReceipt, digest: bodyDigest,
            byteSize: observation.responseBytes, metadata: observation }, `surface-artifact:${key}`);
        const artifact = artifactReceipt.output;
        const evidenceReceipt = await capability("traceforge.scenario.evidence@1", "record_node", { commandId: "observation", node: {
                id: `web-observation:${sha(`${url}\0${receiptId}`)}`, kind: "evidence", title: `Observed ${url}`,
                summary: `GET returned ${observation.status} (${contentType || "unknown content type"})`, status: "active", confidence: 1,
                properties: { url, status: observation.status, contentType, responseBytes: observation.responseBytes, bodyTruncated: observation.bodyTruncated,
                    bodyDigest, artifactId: artifact.id, networkReceipt: observation.networkReceipt, discoveredUrls: observation.discoveredUrls,
                    externalOrigins: observation.externalOrigins },
            } }, `surface-evidence:${key}`);
        const saved = { ...observation, artifactId: artifact.id, evidenceRefs: evidenceReceipt.refs };
        state.visited.push(url);
        state.observations.push(saved);
        state.visited = unique(state.visited).slice(-64);
        state.observations = state.observations.slice(-16);
        invocationObservations.push(saved);
        refs.push(artifact.contentRef, ...artifactReceipt.refs, ...evidenceReceipt.refs, ...execution.refs);
        ({ state, revision } = await saveSurface(capability, state, revision, step, stateKey));
        step += 1;
    }
    const result = { schemaVersion: 1, observations: invocationObservations, coverage: { seedCount: state.seeds.length, visitedCount: state.visited.length,
            queuedCount: state.queue.length, skippedCount: state.skipped.length, observationCount: state.observations.length, requestBudget: maximum,
            budgetExhausted: step >= maximum && state.queue.length > 0 }, queued: state.queue.slice(0, 32), skipped: state.skipped.slice(-16), resume: { stateKey, revision } };
    return succeeded(`Explored ${invocationObservations.length} authorized URL(s); ${state.queue.length} remain queued`, result, refs);
}
async function saveSurface(capability, state, revision, step, stateKey) {
    const receipt = await capability("traceforge.scenario.state@1", "compare_and_set", { operation: "compare_and_set",
        commandId: `checkpoint:${stateKey}:${step}`, key: stateKey, expectedRevision: revision, value: state }, `surface-state:${stateKey}:${step}`);
    return { state: restoreSurfaceState(receipt.output), revision: receipt.output.revision };
}
function restoreSurfaceState(record) {
    if (record === null || record === undefined)
        return { schemaVersion: 1, seeds: [], queue: [], visited: [], observations: [], skipped: [] };
    const value = plainObject(record.value, "Surface state");
    if (value.schemaVersion !== 1 || ![value.seeds, value.queue, value.visited, value.observations, value.skipped].every(Array.isArray))
        throw new Error("Surface state is incompatible");
    return { schemaVersion: 1, seeds: value.seeds.map((item) => canonicalHttpUrl(item, "Saved seed")).slice(0, 16),
        queue: value.queue.map((item) => canonicalHttpUrl(item, "Saved queued URL")).slice(0, 32),
        visited: value.visited.map((item) => canonicalHttpUrl(item, "Saved visited URL")).slice(0, 64),
        observations: value.observations.slice(-16), skipped: value.skipped.slice(-16) };
}
export function discoverLinks(body, base, origins, maximum) {
    const sameOrigin = [], external = [];
    const expression = /(?:href|src|action)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
    let match;
    while ((match = expression.exec(body)) && sameOrigin.length + external.length < maximum * 4) {
        const raw = match[1] ?? match[2] ?? match[3];
        let value;
        try {
            value = canonicalHttpUrl(new URL(raw, base).href, "Discovered URL");
        }
        catch {
            continue;
        }
        (origins.has(new URL(value).origin) ? sameOrigin : external).push(value);
    }
    return { sameOrigin: unique(sameOrigin).slice(0, maximum), external: unique(external).slice(0, maximum) };
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
    return value.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ").replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
        .replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, maximum);
}
