import { randomUUID } from "node:crypto";
import { validateEndpoint } from "./connections.js";
import type { ModelAccountConnection } from "./model-account.js";

export interface OAuthConnection {
  /** Deployment-approved registration. No borrowed CLI identity is built in. */
  issuer: string; clientId: string; scopes: string[]; apiBaseUrl: string;
  verificationOrigins?: string[];
  defaultTokenType?: "Bearer";
  defaultTokenLifetimeSeconds?: number;
}
export interface OAuthTokenRecord { accessToken: string; refreshToken?: string; expiresAt: number; binding: string }
/** The embedding host supplies encrypted persistence; this module never writes credential files. */
export interface OAuthTokenStore {
  read(account: string): Promise<OAuthTokenRecord | undefined>;
  write(account: string, value: OAuthTokenRecord): Promise<void>;
  remove(account: string): Promise<void>;
}
interface Pending { deviceCode: string; expiresAt: number; nextPoll: number; interval: number; inFlight?: boolean }

export class DeviceAuthorizationConnection implements ModelAccountConnection {
  private pending = new Map<string, Pending>();
  private refreshes = new Map<string, Promise<OAuthTokenRecord>>();
  private generations = new Map<string, number>();
  private endpoints?: { device: string; token: string };
  private readonly binding: string;
  private readonly config: OAuthConnection;
  constructor(config: OAuthConnection, private store: OAuthTokenStore,
    private transport: typeof fetch = globalThis.fetch, private now: () => number = Date.now) {
    validateEndpoint(config.issuer); validateEndpoint(config.apiBaseUrl);
    if (!config.clientId.trim() || !config.scopes.length || config.scopes.some(scope => !/^[\w:.-]+$/.test(scope))) throw new Error("Invalid OAuth registration");
    this.config = structuredClone(config);
    this.binding = JSON.stringify(this.config);
  }

  async begin(signal?: AbortSignal) {
    const endpoints = await this.discover(signal);
    for (const [id, pending] of this.pending) if (pending.expiresAt <= this.now()) this.pending.delete(id);
    if (this.pending.size >= 8) throw new Error("Too many pending model logins");
    const body = await this.post(endpoints.device, { client_id: this.config.clientId, scope: this.config.scopes.join(" ") }, signal);
    const pendingId = randomUUID();
    const expiresAt = this.now() + integer(body.expires_in, 1, 86400) * 1000;
    const interval = integer(body.interval ?? 5, 1, 60) * 1000;
    const verificationUrl = text(body.verification_uri);
    const verification = validateEndpoint(verificationUrl);
    if (![new URL(this.config.issuer).origin, ...(this.config.verificationOrigins ?? [])].includes(verification.origin)) throw new Error("OAuth verification address escaped approved origins");
    this.pending.set(pendingId, { deviceCode: text(body.device_code), expiresAt, interval, nextPoll: this.now() + interval });
    return { pendingId, userCode: text(body.user_code), verificationUrl, expiresAt, intervalMs: interval };
  }

  /** One bounded poll, no hidden background loop or blocking sleep. */
  async poll(pendingId: string, account: string, signal?: AbortSignal): Promise<"pending" | "connected"> {
    identifier(account);
    const pending = this.pending.get(pendingId);
    if (!pending || pending.expiresAt <= this.now()) { this.pending.delete(pendingId); throw new Error("Model login expired or canceled"); }
    if (pending.inFlight || pending.nextPoll > this.now()) return "pending";
    pending.nextPoll = this.now() + pending.interval;
    const generation = this.generations.get(account) ?? 0;
    pending.inFlight = true;
    let body: Record<string, unknown>;
    try { body = await this.post((await this.discover(signal)).token,
      { client_id: this.config.clientId, grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: pending.deviceCode }, signal, true); }
    finally { pending.inFlight = false; }
    if (!this.pending.has(pendingId)) throw new Error("Model login canceled");
    if (body.error === "authorization_pending" || body.error === "slow_down") {
      if (body.error === "slow_down") { pending.interval += 5000; pending.nextPoll = this.now() + pending.interval; }
      return "pending";
    }
    if (body.error) { this.pending.delete(pendingId); throw new Error("Model login denied or expired"); }
    const tokens = this.tokens(body);
    if ((this.generations.get(account) ?? 0) !== generation) throw new Error("Model account disconnected during login");
    await this.store.write(account, tokens);
    if (!this.pending.has(pendingId) || (this.generations.get(account) ?? 0) !== generation) { await this.store.remove(account); throw new Error("Model account disconnected during login"); }
    this.pending.delete(pendingId);
    return "connected";
  }

  cancel(pendingId: string) { this.pending.delete(pendingId); }
  cancelAll() { this.pending.clear(); }
  async status(account: string): Promise<"signed_out" | "connected" | "refresh_required"> {
    identifier(account);
    const record = await this.store.read(account);
    if (!record || record.binding !== this.binding) return "signed_out";
    if (!Number.isFinite(record.expiresAt) || !record.accessToken) throw new Error("Invalid stored model credential");
    if (record.expiresAt <= this.now() + 60000) return record.refreshToken ? "refresh_required" : "signed_out";
    return "connected";
  }
  async disconnect(account: string) {
    identifier(account); this.generations.set(account, (this.generations.get(account) ?? 0) + 1);
    await this.store.remove(account);
  }
  async resolve(account: string, signal?: AbortSignal) {
    identifier(account); signal?.throwIfAborted();
    const generation = this.generations.get(account) ?? 0;
    let record = await this.store.read(account);
    if (!record || record.binding !== this.binding) throw new Error("Model account requires login for this connection");
    if (!Number.isFinite(record.expiresAt)) throw new Error("Invalid model token expiration");
    if (record.expiresAt <= this.now() + 60000) {
      let task = this.refreshes.get(account);
      if (!task) {
        task = this.refresh(account, record, generation);
        this.refreshes.set(account, task);
        void task.finally(() => { if (this.refreshes.get(account) === task) this.refreshes.delete(account); }).catch(() => {});
      }
      record = await task;
    }
    signal?.throwIfAborted();
    if ((this.generations.get(account) ?? 0) !== generation) throw new Error("Model account disconnected");
    return { value: text(record.accessToken), expiresAt: record.expiresAt, baseUrl: this.config.apiBaseUrl };
  }
  private async refresh(account: string, previous: OAuthTokenRecord, generation: number) {
    if (!previous.refreshToken) throw new Error("Model account requires login");
    const body = await this.post((await this.discover()).token, {
      client_id: this.config.clientId, grant_type: "refresh_token", refresh_token: previous.refreshToken,
    }, undefined, true);
    if (body.error) {
      if (body.error === "invalid_grant" && (this.generations.get(account) ?? 0) === generation) await this.store.remove(account);
      throw new Error("Model account refresh failed; login may be required");
    }
    const record = this.tokens(body, previous.refreshToken);
    if ((this.generations.get(account) ?? 0) !== generation) throw new Error("Model account disconnected during refresh");
    await this.store.write(account, record);
    if ((this.generations.get(account) ?? 0) !== generation) { await this.store.remove(account); throw new Error("Model account disconnected during refresh"); }
    return record;
  }
  private tokens(body: Record<string, unknown>, previousRefresh?: string): OAuthTokenRecord {
    if (String(body.token_type ?? this.config.defaultTokenType).toLowerCase() !== "bearer") throw new Error("Unsupported model token type");
    return { accessToken: text(body.access_token), refreshToken: body.refresh_token === undefined ? previousRefresh : text(body.refresh_token),
      expiresAt: this.now() + integer(body.expires_in ?? this.config.defaultTokenLifetimeSeconds, 1, 86400) * 1000, binding: this.binding };
  }
  private async discover(signal?: AbortSignal) {
    if (this.endpoints) return this.endpoints;
    const issuer = this.config.issuer.replace(/\/+$/, "");
    const body = await this.json(`${issuer}/.well-known/openid-configuration`, { signal });
    if (body.issuer !== issuer) throw new Error("OAuth issuer mismatch");
    this.endpoints = { device: this.issuerEndpoint(text(body.device_authorization_endpoint)), token: this.issuerEndpoint(text(body.token_endpoint)) };
    return this.endpoints;
  }
  private issuerEndpoint(value: string) {
    const endpoint = validateEndpoint(value);
    if (endpoint.origin !== new URL(this.config.issuer).origin) throw new Error("OAuth endpoint escaped approved issuer");
    return endpoint.href;
  }
  private post(url: string, values: Record<string, string>, signal?: AbortSignal, allowError = false) {
    return this.json(url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(values), signal }, allowError);
  }
  private async json(url: string, init: RequestInit, allowError = false): Promise<Record<string, unknown>> {
    const timeout = AbortSignal.timeout(15000);
    const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    let response: Response;
    try { response = await this.transport(url, { ...init, signal, redirect: "manual" }); }
    catch { throw new Error("Model authentication transport failed"); }
    if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); throw new Error("OAuth redirect rejected"); }
    const reader = response.body?.getReader(); let size = 0; const chunks: Uint8Array[] = [];
    if (!reader) throw new Error("Empty OAuth response");
    try { for (;;) { const next = await reader.read(); if (next.done) break; size += next.value.length;
      if (size > 65536) throw new Error("OAuth response exceeds limit"); chunks.push(next.value); } }
    finally { await reader.cancel(); }
    let body: Record<string, unknown>;
    try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new Error("Invalid OAuth response"); }
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Invalid OAuth response");
    if (!response.ok && !(allowError && typeof body.error === "string")) throw new Error("Model authentication request failed");
    return body;
  }
}
function text(value: unknown) {
  if (typeof value !== "string" || !value.trim() || value.length > 16384 || /[\r\n]/.test(value)) throw new Error("Invalid OAuth field");
  return value;
}
function identifier(value: string) { if (!/^[a-z][a-z0-9_.:-]{0,127}$/.test(value)) throw new Error("Invalid model account reference"); }
function integer(value: unknown, min: number, max: number) { if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) throw new Error("Invalid OAuth timing"); return value as number; }
