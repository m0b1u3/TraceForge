import { createHash, randomUUID } from "node:crypto";
import { permissionProfileFingerprint } from "./protocol.js";
import type {
  BrokeredHttpHeader,
  BrokeredHttpRequest,
  BrokeredHttpResponse,
} from "./protocol.js";

export interface BrokeredHttpAuthorizationGrant {
  authorizationRef: string;
  canonicalUrl: string;
  expiresAt: string;
}

export interface BrokeredHttpAuthorizer {
  authorize(input: {
    attribution: BrokeredHttpRequest["attribution"];
    authorizationAction: string;
    url: string;
    method: string;
  }): Promise<BrokeredHttpAuthorizationGrant> | BrokeredHttpAuthorizationGrant;
}

export interface BrokeredHttpTransportRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Buffer | undefined;
  timeoutMs: number;
  responseLimitBytes: number;
}

export interface BrokeredHttpTransportResponse {
  status: number;
  headers: BrokeredHttpHeader[];
  body: Buffer;
  bodyTruncated: boolean;
}

export type BrokeredHttpTransport = (request: BrokeredHttpTransportRequest) => Promise<BrokeredHttpTransportResponse>;

export interface ExecutionHttpBrokerLimits {
  maximumRequestBytes: number;
  maximumResponseBytes: number;
  maximumHeaders: number;
  maximumConcurrentRequests: number;
  maximumTimeoutMs: number;
}

export interface ExecutionHttpBroker {
  readonly limits: ExecutionHttpBrokerLimits;
  execute(nodeId: string, request: BrokeredHttpRequest): Promise<BrokeredHttpResponse>;
}

export interface BrokeredHttpGatewayOptions {
  authorizer: BrokeredHttpAuthorizer;
  transport?: BrokeredHttpTransport;
  limits?: Partial<ExecutionHttpBrokerLimits>;
  now?: () => string;
}

interface RecordedResponse {
  fingerprint: string;
  response: BrokeredHttpResponse;
}

const forbiddenRequestHeaders = new Set([
  "connection",
  "content-length",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const methodPattern = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const headerNamePattern = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function decodeBase64(value: string | undefined): Buffer | undefined {
  if (value === undefined) return undefined;
  if (value === "") return Buffer.alloc(0);
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error("Brokered HTTP bodies must use canonical base64 encoding");
  }
  return Buffer.from(value, "base64");
}

function assertUrl(rawUrl: string): string {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("Brokered HTTP URL must be an absolute HTTP or HTTPS URL");
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error("Brokered HTTP URL must use HTTP or HTTPS and must not contain embedded credentials");
  }
  return url.href;
}

function validateHeaders(headers: Record<string, string>, maximumHeaders: number): Record<string, string> {
  const entries = Object.entries(headers);
  if (entries.length > maximumHeaders) throw new Error(`Brokered HTTP request exceeds the ${maximumHeaders}-header limit`);
  let encodedBytes = 0;
  const normalized: Record<string, string> = {};
  for (const [name, value] of entries) {
    const lower = name.toLowerCase();
    if (!headerNamePattern.test(name) || forbiddenRequestHeaders.has(lower)) {
      throw new Error(`Brokered HTTP request header ${name} is not allowed`);
    }
    if (typeof value !== "string" || /[\r\n]/.test(value)) throw new Error(`Brokered HTTP request header ${name} has an invalid value`);
    encodedBytes += Buffer.byteLength(name) + Buffer.byteLength(value);
    if (encodedBytes > 64 * 1024) throw new Error("Brokered HTTP request headers exceed the 64 KiB limit");
    normalized[name] = value;
  }
  return normalized;
}

function validateResponseHeaders(headers: BrokeredHttpHeader[], maximumHeaders: number): BrokeredHttpHeader[] {
  if (headers.length > maximumHeaders) throw new Error(`Brokered HTTP response exceeds the ${maximumHeaders}-header limit`);
  let encodedBytes = 0;
  return headers.map((header) => {
    if (!headerNamePattern.test(header.name) || /[\r\n]/.test(header.value)) throw new Error("Brokered HTTP transport returned an invalid response header");
    encodedBytes += Buffer.byteLength(header.name) + Buffer.byteLength(header.value);
    if (encodedBytes > 64 * 1024) throw new Error("Brokered HTTP response headers exceed the 64 KiB limit");
    return { name: header.name.toLowerCase(), value: header.value };
  });
}

async function defaultTransport(request: BrokeredHttpTransportRequest): Promise<BrokeredHttpTransportResponse> {
  const response = await fetch(request.url, {
    method: request.method,
    headers: request.headers,
    body: request.body ? new Uint8Array(request.body) : undefined,
    redirect: "manual",
    signal: AbortSignal.timeout(request.timeoutMs),
  });
  const headers: BrokeredHttpHeader[] = [];
  response.headers.forEach((value, name) => {
    if (name !== "set-cookie") headers.push({ name, value });
  });
  const setCookies = (response.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.()
    ?? (response.headers.get("set-cookie") ? [response.headers.get("set-cookie")!] : []);
  for (const value of setCookies) headers.push({ name: "set-cookie", value });

  if (!response.body) return { status: response.status, headers, body: Buffer.alloc(0), bodyTruncated: false };
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let retained = 0;
  let bodyTruncated = false;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = Buffer.from(next.value);
      const remaining = request.responseLimitBytes - retained;
      if (remaining > 0) {
        const kept = chunk.subarray(0, remaining);
        chunks.push(kept);
        retained += kept.length;
      }
      if (chunk.length > remaining) {
        bodyTruncated = true;
        await reader.cancel("TraceForge broker response limit reached").catch(() => undefined);
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }
  return { status: response.status, headers, body: Buffer.concat(chunks, retained), bodyTruncated };
}

export class BrokeredHttpGateway implements ExecutionHttpBroker {
  readonly limits: ExecutionHttpBrokerLimits;
  private readonly authorizer: BrokeredHttpAuthorizer;
  private readonly transport: BrokeredHttpTransport;
  private readonly now: () => string;
  private readonly responses = new Map<string, RecordedResponse>();
  private activeRequests = 0;

  constructor(options: BrokeredHttpGatewayOptions) {
    this.authorizer = options.authorizer;
    this.transport = options.transport ?? defaultTransport;
    this.now = options.now ?? (() => new Date().toISOString());
    this.limits = {
      maximumRequestBytes: options.limits?.maximumRequestBytes ?? 1024 * 1024,
      maximumResponseBytes: options.limits?.maximumResponseBytes ?? 4 * 1024 * 1024,
      maximumHeaders: options.limits?.maximumHeaders ?? 128,
      maximumConcurrentRequests: options.limits?.maximumConcurrentRequests ?? 32,
      maximumTimeoutMs: options.limits?.maximumTimeoutMs ?? 60_000,
    };
    if (Object.values(this.limits).some((value) => !Number.isSafeInteger(value) || value < 1)) {
      throw new Error("Brokered HTTP limits must be positive safe integers");
    }
  }

  async execute(nodeId: string, request: BrokeredHttpRequest): Promise<BrokeredHttpResponse> {
    const prepared = this.prepare(request);
    const requestFingerprint = fingerprint(prepared.fingerprintInput);
    const prior = this.responses.get(request.attribution.idempotencyKey);
    if (prior) {
      if (prior.fingerprint !== requestFingerprint) {
        throw new Error(`Brokered HTTP idempotency key ${request.attribution.idempotencyKey} was reused with different input`);
      }
      return { ...structuredClone(prior.response), replayed: true };
    }
    if (this.activeRequests >= this.limits.maximumConcurrentRequests) throw new Error("Brokered HTTP capacity is exhausted");
    this.activeRequests += 1;
    const startedAt = this.now();
    try {
      const grant = await this.authorizer.authorize({
        attribution: structuredClone(request.attribution),
        authorizationAction: request.authorizationAction,
        url: prepared.url,
        method: prepared.method,
      });
      if (!grant.authorizationRef.trim()) throw new Error("Brokered HTTP authorizer returned no authorization reference");
      const grantedUrl = assertUrl(grant.canonicalUrl);
      if (grantedUrl !== prepared.url) throw new Error("Brokered HTTP authorization does not match the requested URL");
      const grantExpiry = Date.parse(grant.expiresAt);
      if (!Number.isFinite(grantExpiry) || grantExpiry <= Date.parse(this.now())) throw new Error(`Network authorization ${grant.authorizationRef} is expired`);

      const transported = await this.transport({
        url: grantedUrl,
        method: prepared.method,
        headers: prepared.headers,
        body: prepared.body,
        timeoutMs: request.timeoutMs,
        responseLimitBytes: request.responseLimitBytes,
      });
      if (!Number.isInteger(transported.status) || transported.status < 100 || transported.status > 599) {
        throw new Error("Brokered HTTP transport returned an invalid status code");
      }
      if (transported.body.length > request.responseLimitBytes) throw new Error("Brokered HTTP transport exceeded the response body limit");
      const headers = validateResponseHeaders(transported.headers, this.limits.maximumHeaders);
      const completedAt = this.now();
      const response: BrokeredHttpResponse = {
        receipt: {
          id: `netreceipt_${randomUUID()}`,
          nodeId,
          requestId: request.requestId,
          attribution: structuredClone(request.attribution),
          authorizationRef: grant.authorizationRef,
          authorizationAction: request.authorizationAction,
          url: grantedUrl,
          method: prepared.method,
          status: transported.status,
          requestBytes: prepared.body?.length ?? 0,
          responseBytes: transported.body.length,
          responseBodyTruncated: transported.bodyTruncated,
          permissionProfileFingerprint: permissionProfileFingerprint(request.permissions),
          redirectFollowed: false,
          startedAt,
          completedAt,
        },
        status: transported.status,
        headers,
        bodyBase64: transported.body.toString("base64"),
        responseBytes: transported.body.length,
        bodyTruncated: transported.bodyTruncated,
        replayed: false,
      };
      this.responses.set(request.attribution.idempotencyKey, { fingerprint: requestFingerprint, response: structuredClone(response) });
      return response;
    } finally {
      this.activeRequests -= 1;
    }
  }

  private prepare(request: BrokeredHttpRequest) {
    if (!request.requestId.trim()) throw new Error("Brokered HTTP request id is required");
    if (request.permissions.network !== "brokered") throw new Error("Brokered HTTP requires an effective brokered-only network permission");
    if (!request.authorizationAction.trim()) throw new Error("Brokered HTTP authorization action is required");
    const url = assertUrl(request.url);
    const method = request.method.toUpperCase();
    if (!methodPattern.test(method) || method === "CONNECT") throw new Error(`Brokered HTTP method ${request.method} is not allowed`);
    const headers = validateHeaders(request.headers, this.limits.maximumHeaders);
    const body = decodeBase64(request.bodyBase64);
    if (body && body.length > this.limits.maximumRequestBytes) throw new Error("Brokered HTTP request body exceeds the node limit");
    if (body?.length && (method === "GET" || method === "HEAD")) throw new Error(`Brokered HTTP ${method} requests cannot contain a body`);
    if (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs < 1 || request.timeoutMs > this.limits.maximumTimeoutMs) {
      throw new Error("Brokered HTTP timeout is outside the node limit");
    }
    if (!Number.isSafeInteger(request.responseLimitBytes) || request.responseLimitBytes < 1
      || request.responseLimitBytes > this.limits.maximumResponseBytes) {
      throw new Error("Brokered HTTP response limit is outside the node limit");
    }
    return {
      url,
      method,
      headers,
      body,
      fingerprintInput: {
        requestId: request.requestId,
        attribution: request.attribution,
        permissions: request.permissions,
        authorizationAction: request.authorizationAction,
        url,
        method,
        headers,
        bodyBase64: request.bodyBase64,
        timeoutMs: request.timeoutMs,
        responseLimitBytes: request.responseLimitBytes,
      },
    };
  }
}
