export const PROTOCOL_VERSION = 1;
export const PACKAGE_ID = "traceforge.web-blackbox";
export const PACKAGE_VERSION = "0.3.0";
export const SOURCE = "scenario:web_blackbox@1";
export const tools = Object.freeze([
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
