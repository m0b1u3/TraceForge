export const PROTOCOL_VERSION = 1;
export const PACKAGE_ID = "traceforge.web-blackbox";
export const PACKAGE_VERSION = "0.4.0";
export const SOURCE = "scenario:web_blackbox@1";
const comparisonRequest = { type: "object", additionalProperties: false, required: ["url"], properties: {
        url: { type: "string" }, method: { enum: ["GET", "HEAD"] }, sessionId: { type: "string" },
    } };
const workflowRequest = { type: "object", additionalProperties: false, required: ["url"], properties: {
        url: { type: "string" }, method: { enum: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] }, sessionId: { type: "string" },
        headers: { type: "object", maxProperties: 16, additionalProperties: { type: "string" } }, bodyBase64: { type: "string", maxLength: 87384 },
        secretBody: { type: "object", additionalProperties: false, required: ["format", "fields"], properties: { format: { enum: ["form", "json"] }, fields: { type: "object" } } },
        captures: { type: "array", maxItems: 16, items: { type: "object", additionalProperties: false, required: ["name", "start", "end", "maximumBytes"], properties: {
                    name: { type: "string" }, start: { type: "string" }, end: { type: "string" }, maximumBytes: { type: "integer", minimum: 1, maximum: 8192 },
                } } }, purpose: { type: "string" },
    } };
const evidenceRefs = { type: "array", minItems: 1, maxItems: 32, items: { type: "string" } };
export const tools = Object.freeze([
    {
        name: "web.browser.read", source: SOURCE, version: PACKAGE_VERSION, priority: 85,
        description: "Read a bounded chunk of a retained Browser artifact from this Run; does not launch a browser or contact the target.",
        inputSchema: { type: "object", additionalProperties: false, required: ["artifactId"], properties: {
                artifactId: { type: "string" }, offset: { type: "integer", minimum: 0, maximum: 4194304 }, length: { type: "integer", minimum: 1, maximum: 65536 },
            } }, providedCapabilities: ["web.browser.read"], dependencyCapabilities: [], permissionRequirements: {}, risk: "read_only", timeoutMs: 10000,
    },
    {
        name: "web.browser.inspect", source: SOURCE, version: PACKAGE_VERSION, priority: 85,
        description: "Observe one page through the reviewed local Browser Runtime and HTTP Broker; unavailable without a trusted deployment, never falls back to direct networking. Observations are not verified findings.",
        inputSchema: { type: "object", additionalProperties: false, required: ["url"], properties: { url: { type: "string" }, screenshot: { type: "boolean" } } },
        providedCapabilities: ["web.browser.inspect"], dependencyCapabilities: [],
        permissionRequirements: { network: "brokered", process: "sandboxed" }, risk: "bounded_write", timeoutMs: 45000,
    },
    {
        name: "web.hypothesis.register", source: SOURCE, version: PACKAGE_VERSION, priority: 98,
        description: "Preserve a distinct candidate linked to retained surface observations; Core still schedules validation Work.",
        inputSchema: { type: "object", additionalProperties: false, required: ["candidateId", "statement", "basisRefs"], properties: {
                candidateId: { type: "string" }, statement: { type: "string" }, basisRefs: evidenceRefs, surfaceSessionId: { type: "string" },
            } }, providedCapabilities: ["web.hypothesis.register"], dependencyCapabilities: [], permissionRequirements: {}, risk: "bounded_write", timeoutMs: 10000,
    },
    {
        name: "web.validation.execute", source: SOURCE, version: PACKAGE_VERSION, priority: 99,
        description: "Execute a hypothesis-bound HTTP workflow: explicit preconditions, repeated comparison, durable continuation and unknown-effect fencing.",
        inputSchema: { type: "object", additionalProperties: false, required: ["candidateId", "plan"], properties: {
                candidateId: { type: "string" }, maxRequests: { type: "integer", minimum: 1, maximum: 6 },
                plan: { type: "object", additionalProperties: false, required: ["prepare", "baseline", "candidate", "changedCondition"], properties: {
                        prepare: { type: "array", maxItems: 4, items: { type: "object", additionalProperties: false, required: ["request", "expectedStatuses"], properties: {
                                    request: workflowRequest, expectedStatuses: { type: "array", minItems: 1, maxItems: 8, items: { type: "integer", minimum: 100, maximum: 599 } },
                                } } }, baseline: workflowRequest, candidate: workflowRequest, changedCondition: { type: "string" }, rounds: { type: "integer", minimum: 2, maximum: 3 },
                    } },
            } }, providedCapabilities: ["web.validation.execute"], dependencyCapabilities: [], permissionRequirements: { network: "brokered", secrets: "handles_only" }, risk: "bounded_write", timeoutMs: 125000,
    },
    {
        name: "web.validation.review", source: SOURCE, version: PACKAGE_VERSION, priority: 98,
        description: "Review attributed workflow observations and missing causal links without verifying a Finding or releasing unknown effects.",
        inputSchema: { type: "object", additionalProperties: false, required: ["candidateId", "outcome", "causalMechanism", "expectedBoundary", "securityImpact", "alternatives", "refs"], properties: {
                candidateId: { type: "string" }, outcome: { enum: ["supported", "refuted", "inconclusive"] }, causalMechanism: { type: "string" },
                expectedBoundary: { type: "string" }, securityImpact: { type: "string" }, alternatives: { type: "string" }, refs: evidenceRefs,
            } }, providedCapabilities: ["web.validation.review"], dependencyCapabilities: [], permissionRequirements: {}, risk: "bounded_write", timeoutMs: 10000,
    },
    {
        name: "web.report.build", source: SOURCE, version: PACKAGE_VERSION, priority: 98,
        description: "Assemble retained coverage, reviewed candidates and unresolved work without inventing verified findings or issuing network requests.",
        inputSchema: { type: "object", additionalProperties: false }, providedCapabilities: ["web.report.build"], dependencyCapabilities: [],
        permissionRequirements: {}, risk: "read_only", timeoutMs: 10000,
    },
    {
        name: "web.validation.compare", source: SOURCE, version: PACKAGE_VERSION, priority: 97,
        description: "Repeat a single-dimension HTTP comparison with evidence and resumable checkpoints; differences never verify findings.",
        inputSchema: { type: "object", additionalProperties: false, required: ["experimentId", "hypothesisId", "baseline", "candidate"], properties: {
                experimentId: { type: "string" }, hypothesisId: { type: "string" }, baseline: comparisonRequest, candidate: comparisonRequest,
                rounds: { type: "integer", minimum: 2, maximum: 3 }, maxRequests: { type: "integer", minimum: 1, maximum: 6 },
            } }, providedCapabilities: ["web.validation.compare"], dependencyCapabilities: [],
        permissionRequirements: { network: "brokered", secrets: "handles_only" }, risk: "bounded_write", timeoutMs: 125_000,
    },
    {
        name: "scope.authorization.snapshot", source: SOURCE, version: PACKAGE_VERSION, priority: 100,
        description: "Read the immutable authorization scope assigned to this investigation.",
        inputSchema: { type: "object", additionalProperties: false },
        providedCapabilities: ["scope.read"], dependencyCapabilities: [], permissionRequirements: {},
        risk: "read_only", timeoutMs: 5_000,
    },
    {
        name: "web.http.request", source: SOURCE, version: PACKAGE_VERSION, priority: 90,
        description: "Send one bounded HTTP request through the host network broker after exact scope authorization.",
        inputSchema: {
            type: "object", additionalProperties: false, required: ["url"], properties: {
                url: { type: "string" }, method: { type: "string" }, headers: { type: "object", additionalProperties: { type: "string" } },
                bodyBase64: { type: "string" }, timeoutMs: { type: "integer", minimum: 1, maximum: 120000 },
                responseLimitBytes: { type: "integer", minimum: 1, maximum: 4194304 },
            },
        },
        providedCapabilities: ["web.request.replay"], dependencyCapabilities: [],
        permissionRequirements: { network: "brokered" }, risk: "bounded_write", timeoutMs: 125_000,
    },
    {
        name: "web.session.catalog", source: SOURCE, version: PACKAGE_VERSION, priority: 92,
        description: "List Host-managed identity and Session descriptors without exposing secret material.",
        inputSchema: { type: "object", additionalProperties: false }, providedCapabilities: ["web.session.use"], dependencyCapabilities: [],
        permissionRequirements: { secrets: "handles_only" }, risk: "read_only", timeoutMs: 5_000,
    },
    {
        name: "web.session.open", source: SOURCE, version: PACKAGE_VERSION, priority: 91,
        description: "Open a Run- and Scope-bound HTTP Session for an operator-provisioned identity handle.",
        inputSchema: { type: "object", additionalProperties: false, properties: { identityId: { type: "string" }, ttlMs: { type: "integer", minimum: 60000, maximum: 86400000 } } },
        providedCapabilities: ["web.session.use"], dependencyCapabilities: [], permissionRequirements: { secrets: "handles_only" }, risk: "bounded_write", timeoutMs: 5_000,
    },
    {
        name: "web.session.request", source: SOURCE, version: PACKAGE_VERSION, priority: 96,
        description: "Send authenticated HTTP through a Host Session; secret headers and cookies never enter tool input or output.",
        inputSchema: { type: "object", additionalProperties: false, required: ["sessionId", "url"], properties: {
                sessionId: { type: "string" }, url: { type: "string" }, method: { type: "string" },
                headers: { type: "object", additionalProperties: { type: "string" } }, bodyBase64: { type: "string" },
                timeoutMs: { type: "integer", minimum: 1, maximum: 120000 },
                secretBody: { type: "object", additionalProperties: false, required: ["format", "fields"], properties: { format: { enum: ["form", "json"] }, fields: { type: "object" } } },
                captures: { type: "array", maxItems: 16, items: { type: "object", additionalProperties: false, required: ["name", "start", "end", "maximumBytes"], properties: { name: { type: "string" }, start: { type: "string" }, end: { type: "string" }, maximumBytes: { type: "integer", minimum: 1, maximum: 8192 } } } },
                responseLimitBytes: { type: "integer", minimum: 1, maximum: 1048576 },
            } }, providedCapabilities: ["web.session.use", "web.request.replay"], dependencyCapabilities: [],
        permissionRequirements: { network: "brokered", secrets: "handles_only" }, risk: "bounded_write", timeoutMs: 125_000,
    },
    {
        name: "web.traffic.snapshot", source: SOURCE, version: PACKAGE_VERSION, priority: 88,
        description: "Read bounded redacted traffic descriptors attributed to this Run.",
        inputSchema: { type: "object", additionalProperties: false, properties: { limit: { type: "integer", minimum: 1, maximum: 200 } } },
        providedCapabilities: ["web.traffic.read"], dependencyCapabilities: [], permissionRequirements: {}, risk: "read_only", timeoutMs: 5_000,
    },
    {
        name: "web.surface.explore", source: SOURCE, version: PACKAGE_VERSION, priority: 95,
        description: "Explore a bounded same-origin HTTP surface, checkpoint progress, and record attributable artifacts and evidence.",
        inputSchema: { type: "object", additionalProperties: false, required: ["seeds"], properties: {
                seeds: { type: "array", minItems: 0, maxItems: 16, items: { type: "string" } },
                headers: { type: "object", additionalProperties: { type: "string" } }, maxRequests: { type: "integer", minimum: 1, maximum: 8 },
                maxLinksPerPage: { type: "integer", minimum: 1, maximum: 64 }, responseLimitBytes: { type: "integer", minimum: 1024, maximum: 1048576 },
                sessionId: { type: "string" },
            } }, providedCapabilities: ["web.surface.explore"], dependencyCapabilities: [],
        permissionRequirements: { network: "brokered" }, risk: "bounded_write", timeoutMs: 125_000,
    },
]);
