import type { JsonObject, RpcRequest, ToolResult } from "./contracts.mjs";
import type { ScenarioRpcHost } from "./rpc.mjs";
import { exploreSurface } from "./surface.mjs";
import { compareHttp } from "./comparison.mjs";
import { investigation } from "./workflow.mjs";
import { reserveRequest } from "./budgets.mjs";
import { observationHighlights, observationTerms } from "./observations.mjs";
import { boundedInteger, canonicalHttpUrl, exact, plainObject, requiredBase64, requiredText, sha, stringRecord, succeeded } from "./validation.mjs";

export async function callTool(request: RpcRequest, host: ScenarioRpcHost): Promise<ToolResult> {
  const params = plainObject(request.params, "Tool call"), context = plainObject(params.context, "Tool context");
  if (typeof context.idempotencyKey !== "string" || !context.idempotencyKey) throw new Error("Tool context idempotency key is required");
  const rawCapability = (name: string, action: string, input: unknown, suffix: string) => host.capability(request.id, context, name, action, input, suffix);
  const capability:Capability = async(name,action,input,suffix)=>{
    if(name==="traceforge.scenario.execution@1"&&["request_http","request_http_session"].includes(action))await reserveRequest(rawCapability,`${context.idempotencyKey}:${suffix}`);
    return rawCapability(name,action,input,suffix);
  };
  const operations: Record<string, string> = { "web.investigation.snapshot": "snapshot", "web.hypothesis.register": "register", "web.validation.execute": "advance", "web.validation.review": "review", "web.report.build": "report" };
  if (typeof params.tool === "string" && operations[params.tool]) {
    return investigation(operations[params.tool]!, plainObject(params.input, "Workflow input"), context, capability, (input, suffix) => {
      const scoped: Capability = (name, action, value, child) => capability(name, action, value, `${suffix}:${child}`);
      const bounded = { ...input, timeoutMs: 15000, responseLimitBytes: 1024 * 1024 };
      return input.sessionId === undefined ? requestHttp(bounded, scoped) : requestSession(bounded, scoped);
    });
  }
  if (params.tool === "scope.authorization.snapshot") {
    exact(plainObject(params.input, "Scope input"), []);
    const receipt = await capability("traceforge.scenario.authorization@1", "require", { action: "scope.read" }, "scope");
    return succeeded("Authorization scope loaded", receipt.output, [`authorization:${receipt.output.id}`, ...receipt.refs]);
  }
  if (params.tool === "web.http.request") return requestHttp(plainObject(params.input, "HTTP input"), capability);
  if (params.tool === "web.browser.read") {
    const input = plainObject(params.input, "Browser artifact input"); exact(input, ["artifactId", "offset", "length"]);
    const receipt = await capability("traceforge.scenario.browser@1", "read", { operation: "read", authorizationAction: "web.traffic.read",
      artifactId: requiredText(input.artifactId, "Artifact id"), offset: boundedInteger(input.offset ?? 0, 0, 4194304, "Content offset"),
      length: boundedInteger(input.length ?? 65536, 1, 65536, "Content length"),
    }, "browser-read");
    return succeeded("Retained Browser artifact chunk loaded", receipt.output, receipt.refs);
  }
  if (params.tool === "web.browser.inspect") {
    const input = plainObject(params.input, "Browser input"); exact(input, ["url", "screenshot"]);
    const url = canonicalHttpUrl(input.url, "Browser URL");
    if (input.screenshot !== undefined && typeof input.screenshot !== "boolean") throw new Error("Screenshot option must be boolean");
    const receipt = await capability("traceforge.scenario.browser@1", "inspect", {
      operation: "inspect", authorizationAction: "web.request.replay", url, screenshot: input.screenshot ?? false,
    }, "browser-inspect");
    return succeeded("Browser observation retained; this is not a verified security finding", receipt.output, receipt.refs);
  }
  if (params.tool === "web.validation.compare") return compareHttp(plainObject(params.input, "Comparison input"), capability, (spec, step) => {
    const scoped: Capability = (name, action, input, suffix) => capability(name, action, input, `comparison-request:${step}:${suffix}`);
    const input = { url: spec.url, method: spec.method, responseLimitBytes: 1024 * 1024 };
    return spec.sessionId === null ? requestHttp(input, scoped) : requestSession({ ...input, sessionId: spec.sessionId }, scoped);
  });
  if (params.tool === "web.session.catalog") {
    exact(plainObject(params.input, "Session catalog input"), []);
    const identities = await capability("traceforge.scenario.sessions@1", "list_identities",
      { operation: "list_identities", authorizationAction: "web.session.use", resourceKind: "identity.handle" }, "session-identities");
    const sessions = await capability("traceforge.scenario.sessions@1", "list",
      { operation: "list", authorizationAction: "web.session.use" }, "session-list");
    return succeeded(`Loaded ${identities.output.length} identity handle(s) and ${sessions.output.length} Session(s)`,
      { identities: identities.output, sessions: sessions.output }, [...identities.refs, ...sessions.refs]);
  }
  if (params.tool === "web.session.open") {
    const input = plainObject(params.input, "Session open input"); exact(input, ["identityId", "ttlMs"]);
    const identityId = input.identityId === undefined ? null : requiredText(input.identityId, "Identity id");
    const ttlMs = boundedInteger(input.ttlMs ?? 60 * 60 * 1000, 60_000, 86_400_000, "Session lifetime");
    const receipt = await capability("traceforge.scenario.sessions@1", "open",
      { operation: "open", authorizationAction: "web.session.use", resourceKind: "identity.handle", identityId, ttlMs }, "session-open");
    return succeeded(`Opened controlled Session ${receipt.output.id}`, receipt.output, receipt.refs);
  }
  if (params.tool === "web.session.request") return requestSession(plainObject(params.input, "Session HTTP input"), capability);
  if (params.tool === "web.traffic.snapshot") {
    const input = plainObject(params.input, "Traffic input"); exact(input, ["limit"]);
    const limit = boundedInteger(input.limit ?? 50, 1, 200, "Traffic limit");
    const receipt = await capability("traceforge.scenario.traffic@1", "list",
      { operation: "list", authorizationAction: "web.traffic.read", limit }, "traffic-list");
    return succeeded(`Loaded ${receipt.output.length} redacted Traffic descriptor(s)`, receipt.output, receipt.refs);
  }
  if (params.tool === "web.surface.explore") return exploreSurface(plainObject(params.input, "Surface exploration input"), capability);
  throw new Error(`Unknown Web black-box tool ${String(params.tool)}`);
}

type Capability = (name: string, action: string, input: unknown, suffix: string) => ReturnType<ScenarioRpcHost["capability"]>;

async function requestHttp(input: JsonObject, capability: Capability): Promise<ToolResult> {
  exact(input, ["url", "method", "headers", "bodyBase64", "timeoutMs", "responseLimitBytes", "interestTerms"]);
  const terms=observationTerms(input.interestTerms);
  if (typeof input.url !== "string" || !input.url.trim()) throw new Error("HTTP URL is required");
  const method = input.method === undefined ? "GET" : requiredText(input.method, "HTTP method").toUpperCase();
  const headers = input.headers === undefined ? {} : stringRecord(input.headers, "HTTP headers");
  const bodyBase64 = input.bodyBase64 === undefined ? "" : requiredBase64(input.bodyBase64);
  const timeoutMs = boundedInteger(input.timeoutMs ?? 15_000, 1, 120_000, "HTTP timeout");
  const responseLimitBytes = boundedInteger(input.responseLimitBytes ?? 1024 * 1024, 1, 4 * 1024 * 1024, "HTTP response limit");
  const authorization = await capability("traceforge.scenario.authorization@1", "authorize_resource",
    { action: "web.request.replay", resourceKind: "network.url", value: input.url.trim() }, "http-authorization");
  const execution = await capability("traceforge.scenario.execution@1", "request_http", {
    authorizationAction: "web.request.replay", url: authorization.output.canonicalValue, method, headers, bodyBase64, timeoutMs, responseLimitBytes,
  }, "http-execution");
  return succeeded(`HTTP ${method} completed with status ${execution.output.status}`, {...execution.output,contextHighlights:observationHighlights([execution.output],terms)}, [...authorization.refs, ...execution.refs]);
}

async function requestSession(input: JsonObject, capability: Capability): Promise<ToolResult> {
  exact(input, ["sessionId", "url", "method", "headers", "bodyBase64", "secretBody", "captures", "timeoutMs", "responseLimitBytes", "interestTerms"]);
  const terms=observationTerms(input.interestTerms);
  if (input.bodyBase64 !== undefined && input.secretBody !== undefined) throw new Error("Session HTTP body forms are mutually exclusive");
  const sessionId = requiredText(input.sessionId, "Session id"), url = canonicalHttpUrl(input.url, "Session HTTP URL");
  const method = requiredText(input.method ?? "GET", "HTTP method").toUpperCase();
  const headers = input.headers === undefined ? {} : stringRecord(input.headers, "HTTP headers");
  const bodyBase64 = input.bodyBase64 === undefined ? "" : requiredBase64(input.bodyBase64);
  const authorization = await capability("traceforge.scenario.authorization@1", "authorize_resource",
    { action: "web.request.replay", resourceKind: "network.url", value: url }, `session-authorization:${sha(url)}`);
  const execution = await capability("traceforge.scenario.execution@1", "request_http_session", {
    authorizationAction: "web.request.replay", sessionAuthorizationAction: "web.session.use", sessionId,
    url: authorization.output.canonicalValue, method, headers, ...(input.secretBody === undefined ? { bodyBase64 } : { secretBody: input.secretBody }),
    ...(input.captures === undefined ? {} : { captures: input.captures }),
    timeoutMs: boundedInteger(input.timeoutMs ?? 15_000, 1, 120_000, "HTTP timeout"),
    responseLimitBytes: boundedInteger(input.responseLimitBytes ?? 256 * 1024, 1, 1024 * 1024, "HTTP response limit"),
  }, `session-http:${sha(url)}`);
  return succeeded(`Authenticated HTTP ${method} completed with status ${execution.output.status}`, {...execution.output,contextHighlights:observationHighlights([execution.output],terms)}, [...authorization.refs, ...execution.refs]);
}
