import type { JsonObject, RpcRequest, ToolResult } from "./contracts.mjs";
import type { ScenarioRpcHost } from "./rpc.mjs";
import { exploreSurface } from "./surface.mjs";
import { boundedInteger, canonicalHttpUrl, exact, plainObject, requiredBase64, requiredText, sha, stringRecord, succeeded } from "./validation.mjs";

export async function callTool(request: RpcRequest, host: ScenarioRpcHost): Promise<ToolResult> {
  const params = plainObject(request.params, "Tool call"), context = plainObject(params.context, "Tool context");
  if (typeof context.idempotencyKey !== "string" || !context.idempotencyKey) throw new Error("Tool context idempotency key is required");
  const capability = (name: string, action: string, input: unknown, suffix: string) => host.capability(request.id, context, name, action, input, suffix);
  if (params.tool === "scope.authorization.snapshot") {
    exact(plainObject(params.input, "Scope input"), []);
    const receipt = await capability("traceforge.scenario.authorization@1", "require", { action: "scope.read" }, "scope");
    return succeeded("Authorization scope loaded", receipt.output, [`authorization:${receipt.output.id}`, ...receipt.refs]);
  }
  if (params.tool === "web.http.request") return requestHttp(plainObject(params.input, "HTTP input"), capability);
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
  exact(input, ["url", "method", "headers", "bodyBase64", "timeoutMs", "responseLimitBytes"]);
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
  return succeeded(`HTTP ${method} completed with status ${execution.output.status}`, execution.output, [...authorization.refs, ...execution.refs]);
}

async function requestSession(input: JsonObject, capability: Capability): Promise<ToolResult> {
  exact(input, ["sessionId", "url", "method", "headers", "bodyBase64", "secretBody", "captures", "timeoutMs", "responseLimitBytes"]);
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
  return succeeded(`Authenticated HTTP ${method} completed with status ${execution.output.status}`, execution.output, [...authorization.refs, ...execution.refs]);
}
