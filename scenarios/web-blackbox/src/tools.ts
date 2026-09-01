import { randomUUID } from "node:crypto";
import { chromium } from "playwright";
import { z } from "zod";
import type { ScenarioAuthorizationPort } from "@traceforge/scenario-sdk";
import type { ExecutionToolAdapter, GovernedExecutionPort, ToolExecutionContext, ToolExecutionResult } from "@traceforge/worker-runtime";
import type { ExecutionCookie, ScenarioSessionPort, ScenarioTrafficPort, SessionUseContext } from "./ports.js";
import { WEB_BLACKBOX_ACTIONS, WEB_BLACKBOX_AUTHORIZATION_SCOPE } from "./definition.js";

type ToolContext = ToolExecutionContext;

const httpInput = z.object({
  sessionId: z.string().min(1),
  url: z.string().min(1),
  method: z.string().min(1).default("GET").transform((value) => value.toUpperCase()),
  headers: z.record(z.string()).default({}),
  body: z.string().max(1_000_000).optional(),
});

export class ScenarioHttpRequestTool implements ExecutionToolAdapter {
  readonly name = "web.http.request";
  readonly source = "traceforge.builtin";
  readonly version = "1.0.0";
  readonly priority = 100;
  readonly description = "Send one bounded HTTP request to an explicitly authorized target. Redirects are returned but never followed implicitly.";
  readonly inputSchema = {
    type: "object",
    properties: {
      url: { type: "string" },
      sessionId: { type: "string" },
      method: { type: "string", default: "GET" },
      headers: { type: "object", additionalProperties: { type: "string" } },
      body: { type: "string", maxLength: 1_000_000 },
    },
    required: ["sessionId", "url"],
    additionalProperties: false,
  };
  readonly providedCapabilities = [WEB_BLACKBOX_ACTIONS.requestReplay];
  readonly dependencyCapabilities = ["execution.session.open"];
  readonly permissionRequirements = { network: "brokered" as const };
  readonly risk = "bounded_write" as const;
  readonly timeoutMs = 25_000;

  constructor(
    private readonly authorization: ScenarioAuthorizationPort,
    private readonly sessions: ScenarioSessionPort,
    private readonly traffic: ScenarioTrafficPort,
    private readonly execution: GovernedExecutionPort,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async execute(input: unknown, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    const request = httpInput.parse(input);
    const grant = this.authorization.authorizeResource(
      context.scopeRef, context.caseId, WEB_BLACKBOX_ACTIONS.requestReplay, "network.url", request.url,
    );
    const url = new URL(grant.canonicalValue);
    const material = this.sessions.use(request.sessionId, sessionContext(context));
    const headers = { ...request.headers, ...material.headers };
    const cookie = cookieHeader(material.cookies, url);
    if (cookie) headers.cookie = cookie;
    const response = await this.execution.requestHttp({
      authorizationAction: WEB_BLACKBOX_ACTIONS.requestReplay,
      url: url.href,
      method: request.method,
      headers,
      ...(request.body === undefined ? {} : { bodyBase64: Buffer.from(request.body).toString("base64") }),
      timeoutMs: 20_000,
      responseLimitBytes: 256_000,
    });
    const responseHeaders: Record<string, string> = {};
    for (const header of response.headers) responseHeaders[header.name] = header.value;
    const responseBody = Buffer.from(response.bodyBase64, "base64").toString("utf8");
    const cookies = response.headers
      .filter((header) => header.name.toLowerCase() === "set-cookie")
      .flatMap((header) => parseSetCookie(header.value, url));
    if (response.receipt.attribution.caseId !== context.caseId
      || response.receipt.attribution.runId !== context.runId
      || response.receipt.attribution.workId !== context.workId
      || response.receipt.attribution.workerId !== context.workerId
      || response.receipt.attribution.scopeRef !== context.scopeRef
      || response.receipt.authorizationRef !== context.scopeRef
      || response.receipt.url !== url.href
      || response.receipt.method !== request.method
      || response.receipt.redirectFollowed !== false) {
      throw new Error("Execution Node returned a network receipt that does not match the assigned operation");
    }
    const trafficId = `traf_${randomUUID()}`;
    const createdAt = this.now();
    this.traffic.recordHttpExchange({
      trafficId,
      caseId: context.caseId,
      runId: context.runId,
      url: url.href,
      method: request.method,
      requestHeaders: redactHeaders(headers),
      requestBody: request.body ?? null,
      responseStatus: response.status,
      responseHeaders: redactHeaders(responseHeaders),
      responseSize: response.responseBytes,
      contentType: responseHeaders["content-type"] ?? null,
      responseBody: safeBody(responseBody, responseHeaders["content-type"]),
      receipt: response.receipt,
      createdAt,
    });
    if (cookies.length) this.sessions.updateCookies(request.sessionId, cookies);
    return {
      status: "succeeded",
      summary: `HTTP ${request.method} completed with status ${response.status}; response was recorded as ${trafficId}`,
      raw: JSON.stringify({
        trafficId,
        url: url.href,
        method: request.method,
        status: response.status,
        headers: redactHeaders(responseHeaders),
        bodyPreview: responseBody.slice(0, 32_000),
        bodyTruncated: response.bodyTruncated,
        networkReceiptId: response.receipt.id,
        redirectFollowed: false,
      }),
      refs: [`traffic:${trafficId}`, `network-receipt:${response.receipt.id}`],
      retryable: response.status >= 500,
      metadata: { status: response.status, trafficId, networkReceiptId: response.receipt.id },
    };
  }
}

const trafficInput = z.object({ limit: z.number().int().min(1).max(200).default(50) });

export class ScenarioTrafficSnapshotTool implements ExecutionToolAdapter {
  readonly name = "web.traffic.snapshot";
  readonly source = "traceforge.builtin";
  readonly version = "1.0.0";
  readonly priority = 100;
  readonly description = "Read a bounded list of attributed HTTP observations recorded for the assigned Case.";
  readonly inputSchema = {
    type: "object",
    properties: { limit: { type: "integer", minimum: 1, maximum: 200, default: 50 } },
    additionalProperties: false,
  };
  readonly providedCapabilities = [WEB_BLACKBOX_ACTIONS.trafficRead];
  readonly dependencyCapabilities: string[] = [];
  readonly permissionRequirements = {};
  readonly risk = "read_only" as const;
  readonly timeoutMs = 5_000;

  constructor(private readonly authorization: ScenarioAuthorizationPort, private readonly traffic: ScenarioTrafficPort) {}

  async execute(input: unknown, context: ToolContext): Promise<ToolExecutionResult> {
    const { limit } = trafficInput.parse(input ?? {});
    this.authorization.requireAction(context.scopeRef, context.caseId, WEB_BLACKBOX_ACTIONS.trafficRead);
    const entries = this.traffic.list(context.caseId, limit);
    return {
      status: "succeeded",
      summary: `Loaded ${entries.length} attributed traffic observations from the assigned Case`,
      raw: JSON.stringify(entries),
      refs: entries.map((entry) => `traffic:${entry.id}`),
      retryable: false,
    };
  }
}

export class ScenarioScopeSnapshotTool implements ExecutionToolAdapter {
  readonly name = "scope.authorization.snapshot";
  readonly source = "traceforge.builtin";
  readonly version = "1.0.0";
  readonly priority = 100;
  readonly description = "Read the exact active authorization bound to the assigned Run.";
  readonly inputSchema = { type: "object", additionalProperties: false };
  readonly providedCapabilities = [WEB_BLACKBOX_ACTIONS.scopeRead];
  readonly dependencyCapabilities: string[] = [];
  readonly permissionRequirements = {};
  readonly risk = "read_only" as const;
  readonly timeoutMs = 5_000;

  constructor(private readonly authorization: ScenarioAuthorizationPort) {}

  async execute(_input: unknown, context: ToolContext): Promise<ToolExecutionResult> {
    const authorization = this.authorization.requireAction(context.scopeRef, context.caseId, WEB_BLACKBOX_ACTIONS.scopeRead);
    const scope = WEB_BLACKBOX_AUTHORIZATION_SCOPE.parse(authorization.scopePayload);
    return {
      status: "succeeded",
      summary: `Loaded active authorization ${authorization.id} with ${scope.targets.length} target(s)`,
      raw: JSON.stringify(authorization),
      refs: [`authorization:${authorization.id}`],
      retryable: false,
    };
  }
}

const browserInput = z.object({ url: z.string().min(1) });

export interface BrowserObservation {
  finalUrl: string;
  title: string;
  text: string;
  links: string[];
  status: number | null;
  cookies?: ExecutionCookie[];
}

export type ScenarioBrowserTransport = (
  url: string,
  allowed: (candidate: string) => boolean,
  material: { headers: Record<string, string>; cookies: ExecutionCookie[] },
) => Promise<BrowserObservation>;

const defaultBrowserTransport: ScenarioBrowserTransport = async (url, allowed, material) => {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ extraHTTPHeaders: material.headers });
    const target = new URL(url);
    if (material.cookies.length) {
      await context.addCookies(material.cookies.map((cookie) => ({
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain ?? target.hostname,
        path: cookie.path ?? "/",
        expires: cookie.expires ?? -1,
        httpOnly: cookie.httpOnly ?? false,
        secure: cookie.secure ?? target.protocol === "https:",
        sameSite: cookie.sameSite,
      })));
    }
    await context.route("**/*", async (route) => {
      const candidate = route.request().url();
      if (/^https?:/i.test(candidate) && !allowed(candidate)) return route.abort("blockedbyclient");
      return route.continue();
    });
    const page = await context.newPage();
    const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20_000 });
    const finalUrl = page.url();
    if (!allowed(finalUrl)) throw new Error(`Browser navigation left the authorized target at ${finalUrl}`);
    const snapshot = await page.evaluate(() => ({
      title: document.title,
      text: (document.body?.innerText ?? "").replace(/\s+/g, " ").trim().slice(0, 64_000),
      links: [...new Set(Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href]"), (anchor) => anchor.href))].slice(0, 500),
    }));
    const cookies = (await context.cookies()).map((cookie) => ({
      name: cookie.name, value: cookie.value, domain: cookie.domain, path: cookie.path,
      expires: cookie.expires, httpOnly: cookie.httpOnly, secure: cookie.secure, sameSite: cookie.sameSite,
    }));
    return { finalUrl, title: snapshot.title, text: snapshot.text, links: snapshot.links.filter(allowed), status: response?.status() ?? null, cookies };
  } finally {
    await browser.close();
  }
};

export class ScenarioBrowserObserveTool implements ExecutionToolAdapter {
  readonly name = "web.browser.observe";
  readonly source = "traceforge.builtin";
  readonly version = "1.0.0";
  readonly priority = 100;
  readonly description = "Open one authorized page in an isolated headless browser and return bounded rendered text and in-scope links.";
  readonly inputSchema = {
    type: "object",
    properties: { sessionId: { type: "string" }, url: { type: "string" } },
    required: ["sessionId", "url"],
    additionalProperties: false,
  };
  readonly providedCapabilities = [WEB_BLACKBOX_ACTIONS.browserNavigate];
  readonly dependencyCapabilities = ["execution.session.open"];
  readonly permissionRequirements = { network: "direct" as const };
  readonly risk = "bounded_write" as const;
  readonly timeoutMs = 30_000;

  constructor(
    private readonly authorization: ScenarioAuthorizationPort,
    private readonly sessions: ScenarioSessionPort,
    private readonly traffic: ScenarioTrafficPort,
    private readonly transport: ScenarioBrowserTransport = defaultBrowserTransport,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async execute(input: unknown, context: ToolContext): Promise<ToolExecutionResult> {
    const value = browserInput.extend({ sessionId: z.string().min(1) }).parse(input);
    const grant = this.authorization.authorizeResource(
      context.scopeRef, context.caseId, WEB_BLACKBOX_ACTIONS.browserNavigate, "network.url", value.url,
    );
    const url = new URL(grant.canonicalValue);
    const material = this.sessions.use(value.sessionId, sessionContext(context));
    const allowed = (candidate: string) => {
      try {
        this.authorization.authorizeResource(
          context.scopeRef, context.caseId, WEB_BLACKBOX_ACTIONS.browserNavigate, "network.url", candidate,
        );
        return true;
      } catch { return false; }
    };
    const observation = await this.transport(url.href, allowed, { headers: material.headers, cookies: material.cookies });
    if (observation.cookies?.length) this.sessions.updateCookies(value.sessionId, observation.cookies);
    if (!allowed(observation.finalUrl)) throw new Error(`Browser returned an out-of-scope URL ${observation.finalUrl}`);
    const { cookies: _secretCookies, ...publicObservation } = observation;
    const trafficId = `traf_${randomUUID()}`;
    this.traffic.recordBrowserObservation({
      trafficId,
      caseId: context.caseId,
      runId: context.runId,
      url: observation.finalUrl,
      responseStatus: observation.status,
      responseSize: Buffer.byteLength(observation.text),
      responseBody: observation.text.slice(0, 64_000),
      createdAt: this.now(),
    });
    return {
      status: "succeeded",
      summary: `Observed ${observation.finalUrl} in an isolated browser and recorded ${trafficId}`,
      raw: JSON.stringify({ ...publicObservation, text: observation.text.slice(0, 32_000) }),
      refs: [`traffic:${trafficId}`],
      retryable: false,
      metadata: { trafficId, status: observation.status },
    };
  }
}

export class ScenarioSessionOpenTool implements ExecutionToolAdapter {
  readonly name = "execution.session.open";
  readonly source = "traceforge.builtin";
  readonly version = "1.0.0";
  readonly priority = 100;
  readonly description = "Open a Run-bound execution Session using an operator-provisioned identity reference; secret material is never returned.";
  readonly inputSchema = {
    type: "object",
    properties: { identityId: { type: "string" }, ttlMinutes: { type: "integer", minimum: 1, maximum: 1_440 } },
    additionalProperties: false,
  };
  readonly providedCapabilities = ["execution.session.open"];
  readonly dependencyCapabilities: string[] = [];
  readonly permissionRequirements = { secrets: "handles_only" as const };
  readonly risk = "bounded_write" as const;
  readonly timeoutMs = 5_000;

  constructor(private readonly authorization: ScenarioAuthorizationPort, private readonly sessions: ScenarioSessionPort) {}

  async execute(input: unknown, context: ToolContext): Promise<ToolExecutionResult> {
    const value = z.object({ identityId: z.string().min(1).optional(), ttlMinutes: z.number().int().min(1).max(1_440).default(60) }).parse(input ?? {});
    this.authorization.requireAction(context.scopeRef, context.caseId, WEB_BLACKBOX_ACTIONS.scopeRead);
    const session = this.sessions.openSession({
      caseId: context.caseId,
      runId: context.runId,
      scopeRef: context.scopeRef,
      identityId: value.identityId,
      ttlMs: value.ttlMinutes * 60_000,
    });
    const attributed = this.sessions.use(session.id, sessionContext(context)).session;
    return {
      status: "succeeded",
      summary: `Opened execution Session ${attributed.id}${attributed.identityId ? ` with identity ${attributed.identityId}@${attributed.identityVersion}` : " as anonymous"}`,
      raw: JSON.stringify(attributed),
      refs: [`session:${attributed.id}`, ...(attributed.identityId ? [`identity:${attributed.identityId}@${attributed.identityVersion}`] : [])],
      retryable: false,
    };
  }
}

function redactHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).map(([name, value]) => [
    name,
    /^(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key)$/i.test(name) ? "[REDACTED]" : value,
  ]));
}

function safeBody(body: string, contentType: string | undefined): string | null {
  if (contentType && !/(?:text|json|xml|javascript|x-www-form-urlencoded|graphql|html)/i.test(contentType)) return null;
  const sample = body.slice(0, 4_096);
  const controls = [...sample].filter((character) => {
    const code = character.charCodeAt(0);
    return code === 0 || code < 9 || (code > 13 && code < 32);
  }).length;
  if (controls / Math.max(1, sample.length) > 0.02) return null;
  return body.slice(0, 64_000);
}

function sessionContext(context: ToolContext): SessionUseContext {
  return {
    workerId: context.workerId, workId: context.workId, caseId: context.caseId, runId: context.runId,
    scopeRef: context.scopeRef, leaseId: context.leaseId, leaseExpiresAt: context.leaseExpiresAt,
  };
}

function cookieHeader(cookies: ExecutionCookie[], url: URL): string {
  const nowSeconds = Date.now() / 1_000;
  return cookies.filter((cookie) => {
    if (cookie.expires !== undefined && cookie.expires > 0 && cookie.expires <= nowSeconds) return false;
    if (cookie.secure && url.protocol !== "https:") return false;
    const domain = (cookie.domain ?? url.hostname).replace(/^\./, "").toLowerCase();
    if (url.hostname !== domain && !url.hostname.endsWith(`.${domain}`)) return false;
    return url.pathname.startsWith(cookie.path ?? "/");
  }).map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
}

function parseSetCookie(value: string, requestUrl: URL): ExecutionCookie[] {
  const parts = value.split(";").map((part) => part.trim());
  const separator = parts[0]?.indexOf("=") ?? -1;
  if (separator < 1) return [];
  const cookie: ExecutionCookie = {
    name: parts[0].slice(0, separator),
    value: parts[0].slice(separator + 1),
    domain: requestUrl.hostname,
    path: "/",
  };
  for (const attribute of parts.slice(1)) {
    const [rawName, ...rawValue] = attribute.split("=");
    const name = rawName.toLowerCase();
    const attributeValue = rawValue.join("=");
    if (name === "domain" && attributeValue) cookie.domain = attributeValue.toLowerCase();
    else if (name === "path" && attributeValue) cookie.path = attributeValue;
    else if (name === "expires" && attributeValue) {
      const instant = Date.parse(attributeValue);
      if (Number.isFinite(instant)) cookie.expires = instant / 1_000;
    } else if (name === "max-age" && /^-?\d+$/.test(attributeValue)) cookie.expires = Date.now() / 1_000 + Number(attributeValue);
    else if (name === "secure") cookie.secure = true;
    else if (name === "httponly") cookie.httpOnly = true;
    else if (name === "samesite" && /^(strict|lax|none)$/i.test(attributeValue)) {
      cookie.sameSite = `${attributeValue[0].toUpperCase()}${attributeValue.slice(1).toLowerCase()}` as ExecutionCookie["sameSite"];
    }
  }
  return [cookie];
}
