import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type Database from "better-sqlite3";

export interface ExecutionCookie { name: string; value: string; domain?: string; path?: string; expires?: number;
  httpOnly?: boolean; secure?: boolean; sameSite?: "Strict" | "Lax" | "None"; }
export interface ExecutionSessionDescriptor {
  id: string; caseId: string; runId: string; scopeRef: string; identityId: string | null; identityVersion: number | null;
  status: "active" | "frozen" | "closed" | "expired"; lastWorkerId: string | null; lastWorkId: string | null;
  lastLeaseId: string | null; lastLeaseExpiresAt: string | null; expiresAt: string; createdAt: string; updatedAt: string;
}
export interface SessionUseContext { workerId: string; workId: string; caseId: string; runId: string; scopeRef: string;
  leaseId: string; leaseExpiresAt: string; }
export interface SessionMaterial { session: ExecutionSessionDescriptor; headers: Record<string, string>; cookies: ExecutionCookie[]; }
interface ScenarioSessionPort {
  openSession(input: { caseId: string; runId: string; scopeRef: string; identityId?: string; ttlMs?: number }): ExecutionSessionDescriptor;
  use(sessionId: string, context: SessionUseContext): SessionMaterial;
  updateCookies(sessionId: string, cookies: ExecutionCookie[]): void;
}

export interface ExecutionIdentitySecret {
  headers: Record<string, string>;
  cookies: ExecutionCookie[];
}

export interface ExecutionIdentityDescriptor {
  id: string;
  caseId: string;
  name: string;
  kind: "anonymous" | "user" | "admin" | "service" | "custom";
  version: number;
  status: "active" | "revoked";
  createdAt: string;
  updatedAt: string;
}

interface SessionSecretState { cookies: ExecutionCookie[] }
interface IdentityRow {
  id: string; case_id: string; name: string; kind: ExecutionIdentityDescriptor["kind"];
  version: number; status: ExecutionIdentityDescriptor["status"]; secret_ref: string; created_at: string; updated_at: string;
}
interface SessionRow {
  id: string; case_id: string; run_id: string; scope_ref: string; identity_id: string | null; identity_version: number | null;
  state_secret_ref: string; status: ExecutionSessionDescriptor["status"]; last_worker_id: string | null; last_work_id: string | null;
  last_lease_id: string | null; last_lease_expires_at: string | null; expires_at: string; created_at: string; updated_at: string;
}

export class SqliteEncryptedSecretVault {
  constructor(
    private readonly sqlite: Database.Database,
    private readonly key: Buffer,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {
    if (key.byteLength !== 32) throw new Error("Secret Vault key must contain exactly 32 bytes");
  }

  put(ref: string, value: unknown): void {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
    cipher.setAAD(Buffer.from(ref));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
    const at = this.now();
    this.sqlite.prepare(`
      INSERT INTO encrypted_secret_entries (ref, nonce, ciphertext, auth_tag, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(ref) DO UPDATE SET nonce = excluded.nonce, ciphertext = excluded.ciphertext,
        auth_tag = excluded.auth_tag, updated_at = excluded.updated_at
    `).run(ref, nonce, ciphertext, cipher.getAuthTag(), at, at);
  }

  get<T>(ref: string): T {
    const row = this.sqlite.prepare(
      "SELECT nonce, ciphertext, auth_tag FROM encrypted_secret_entries WHERE ref = ?",
    ).get(ref) as { nonce: Buffer; ciphertext: Buffer; auth_tag: Buffer } | undefined;
    if (!row) throw new Error(`Secret material ${ref} is unavailable`);
    const decipher = createDecipheriv("aes-256-gcm", this.key, row.nonce);
    decipher.setAAD(Buffer.from(ref));
    decipher.setAuthTag(row.auth_tag);
    const cleartext = Buffer.concat([decipher.update(row.ciphertext), decipher.final()]).toString("utf8");
    return JSON.parse(cleartext) as T;
  }

  delete(ref: string): void {
    this.sqlite.prepare("DELETE FROM encrypted_secret_entries WHERE ref = ?").run(ref);
  }
}

export function loadOrCreateVaultKey(projectRoot: string): Buffer {
  const configured = process.env.TRACEFORGE_VAULT_KEY?.trim();
  if (configured) {
    const key = Buffer.from(configured, "base64");
    if (key.byteLength !== 32) throw new Error("TRACEFORGE_VAULT_KEY must be a base64-encoded 32-byte key");
    return key;
  }
  const path = resolve(projectRoot, "data", "secrets", "vault.key");
  try {
    const key = readFileSync(path);
    if (key.byteLength !== 32) throw new Error(`Vault key ${path} has an invalid length`);
    return key;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  mkdirSync(dirname(path), { recursive: true });
  const key = randomBytes(32);
  writeFileSync(path, key, { mode: 0o600, flag: "wx" });
  return key;
}

export class ExecutionSessionGateway implements ScenarioSessionPort {
  constructor(
    private readonly sqlite: Database.Database,
    private readonly vault: SqliteEncryptedSecretVault,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  createIdentity(input: {
    id?: string;
    caseId: string;
    name: string;
    kind: ExecutionIdentityDescriptor["kind"];
    secret: ExecutionIdentitySecret;
  }): ExecutionIdentityDescriptor {
    if (!this.sqlite.prepare("SELECT 1 FROM cases WHERE id = ?").get(input.caseId)) throw new Error(`Unknown Case ${input.caseId}`);
    const id = input.id ?? `identity_${randomUUID()}`;
    const secretRef = `identity-secret:${id}:1`;
    const at = this.now();
    const transaction = this.sqlite.transaction(() => {
      this.vault.put(secretRef, normalizeIdentitySecret(input.secret));
      this.sqlite.prepare(`
        INSERT INTO execution_identities (id, case_id, name, kind, version, status, secret_ref, created_at, updated_at)
        VALUES (?, ?, ?, ?, 1, 'active', ?, ?, ?)
      `).run(id, input.caseId, input.name.trim(), input.kind, secretRef, at, at);
    });
    transaction();
    return { id, caseId: input.caseId, name: input.name.trim(), kind: input.kind, version: 1, status: "active", createdAt: at, updatedAt: at };
  }

  listIdentities(caseId: string): ExecutionIdentityDescriptor[] {
    return (this.sqlite.prepare(`
      SELECT id, case_id, name, kind, version, status, secret_ref, created_at, updated_at
      FROM execution_identities WHERE case_id = ? ORDER BY created_at ASC
    `).all(caseId) as IdentityRow[]).map(identityDescriptor);
  }

  revokeIdentity(identityId: string): ExecutionIdentityDescriptor {
    const row = this.requireIdentity(identityId);
    const at = this.now();
    this.sqlite.transaction(() => {
      this.sqlite.prepare("UPDATE execution_identities SET status = 'revoked', updated_at = ? WHERE id = ?").run(at, identityId);
      this.sqlite.prepare("UPDATE execution_sessions SET status = 'frozen', updated_at = ? WHERE identity_id = ? AND status = 'active'").run(at, identityId);
      this.vault.delete(row.secret_ref);
    })();
    return { ...identityDescriptor(row), status: "revoked", updatedAt: at };
  }

  openSession(input: { caseId: string; runId: string; scopeRef: string; identityId?: string; ttlMs?: number }): ExecutionSessionDescriptor {
    const run = this.sqlite.prepare(`
      SELECT case_id, status FROM scenario_event_streams WHERE run_id = ?
    `).get(input.runId) as { case_id: string; status: string } | undefined;
    if (!run || run.case_id !== input.caseId || run.status !== "running") throw new Error(`Run ${input.runId} is not active for Case ${input.caseId}`);
    const authorization = this.sqlite.prepare(`
      SELECT status, expires_at FROM scenario_authorizations WHERE id = ? AND case_id = ?
    `).get(input.scopeRef, input.caseId) as { status: string; expires_at: string } | undefined;
    if (!authorization || authorization.status !== "active" || Date.parse(authorization.expires_at) <= Date.parse(this.now())) {
      throw new Error(`Scope authorization ${input.scopeRef} is not active`);
    }
    const identity = input.identityId ? this.requireIdentity(input.identityId) : undefined;
    if (identity && (identity.case_id !== input.caseId || identity.status !== "active")) throw new Error(`Identity ${identity.id} is not active for Case ${input.caseId}`);
    const id = `session_${randomUUID()}`;
    const stateSecretRef = `session-state:${id}`;
    const at = this.now();
    const requestedExpiry = Date.parse(at) + Math.min(24 * 60 * 60_000, Math.max(60_000, input.ttlMs ?? 60 * 60_000));
    const expiresAt = new Date(Math.min(requestedExpiry, Date.parse(authorization.expires_at))).toISOString();
    this.sqlite.transaction(() => {
      this.vault.put(stateSecretRef, { cookies: [] } satisfies SessionSecretState);
      this.sqlite.prepare(`
        INSERT INTO execution_sessions
          (id, case_id, run_id, scope_ref, identity_id, identity_version, state_secret_ref, status,
           last_worker_id, last_work_id, last_lease_id, last_lease_expires_at, expires_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'active', NULL, NULL, NULL, NULL, ?, ?, ?)
      `).run(id, input.caseId, input.runId, input.scopeRef, identity?.id ?? null, identity?.version ?? null, stateSecretRef, expiresAt, at, at);
    })();
    return this.requireSession(id);
  }

  use(sessionId: string, context: SessionUseContext): SessionMaterial {
    const row = this.requireSessionRow(sessionId);
    const at = this.now();
    if (row.status !== "active") throw new Error(`Execution Session ${sessionId} is ${row.status}`);
    if (Date.parse(row.expires_at) <= Date.parse(at)) {
      this.sqlite.prepare("UPDATE execution_sessions SET status = 'expired', updated_at = ? WHERE id = ?").run(at, sessionId);
      throw new Error(`Execution Session ${sessionId} is expired`);
    }
    if (row.case_id !== context.caseId || row.run_id !== context.runId || row.scope_ref !== context.scopeRef) {
      throw new Error(`Execution Session ${sessionId} does not belong to the assigned Run and authorization`);
    }
    if (Date.parse(context.leaseExpiresAt) <= Date.parse(at)) throw new Error(`Worker lease ${context.leaseId} is expired`);
    const identity = row.identity_id ? this.requireIdentity(row.identity_id) : undefined;
    if (identity && (identity.status !== "active" || identity.version !== row.identity_version)) {
      this.freeze(sessionId, "identity changed or was revoked");
      throw new Error(`Execution Session ${sessionId} identity is no longer valid`);
    }
    const identitySecret = identity ? this.vault.get<ExecutionIdentitySecret>(identity.secret_ref) : { headers: {}, cookies: [] };
    const sessionState = this.vault.get<SessionSecretState>(row.state_secret_ref);
    this.sqlite.prepare(`
      UPDATE execution_sessions SET last_worker_id = ?, last_work_id = ?, last_lease_id = ?,
        last_lease_expires_at = ?, updated_at = ? WHERE id = ?
    `).run(context.workerId, context.workId, context.leaseId, context.leaseExpiresAt, at, sessionId);
    return {
      session: descriptor({ ...row, last_worker_id: context.workerId, last_work_id: context.workId, last_lease_id: context.leaseId, last_lease_expires_at: context.leaseExpiresAt, updated_at: at }),
      headers: { ...identitySecret.headers },
      cookies: mergeCookies(identitySecret.cookies, sessionState.cookies),
    };
  }

  updateCookies(sessionId: string, cookies: ExecutionCookie[]): void {
    const row = this.requireSessionRow(sessionId);
    if (row.status !== "active") throw new Error(`Execution Session ${sessionId} is ${row.status}`);
    const state = this.vault.get<SessionSecretState>(row.state_secret_ref);
    this.vault.put(row.state_secret_ref, { cookies: mergeCookies(state.cookies, cookies) } satisfies SessionSecretState);
    this.sqlite.prepare("UPDATE execution_sessions SET updated_at = ? WHERE id = ?").run(this.now(), sessionId);
  }

  freezeByScope(scopeRef: string, reason = "authorization revoked"): number {
    const at = this.now();
    return this.sqlite.prepare(`
      UPDATE execution_sessions SET status = 'frozen', updated_at = ?
      WHERE scope_ref = ? AND status = 'active'
    `).run(at, scopeRef).changes;
  }

  freeze(sessionId: string, _reason: string): void {
    this.sqlite.prepare("UPDATE execution_sessions SET status = 'frozen', updated_at = ? WHERE id = ? AND status = 'active'")
      .run(this.now(), sessionId);
  }

  close(sessionId: string): ExecutionSessionDescriptor {
    const row = this.requireSessionRow(sessionId);
    const at = this.now();
    this.sqlite.transaction(() => {
      this.sqlite.prepare("UPDATE execution_sessions SET status = 'closed', updated_at = ? WHERE id = ?").run(at, sessionId);
      this.vault.delete(row.state_secret_ref);
    })();
    return descriptor({ ...row, status: "closed", updated_at: at });
  }

  listSessions(runId: string): ExecutionSessionDescriptor[] {
    return (this.sqlite.prepare("SELECT * FROM execution_sessions WHERE run_id = ? ORDER BY created_at ASC").all(runId) as SessionRow[]).map(descriptor);
  }

  private requireIdentity(id: string): IdentityRow {
    const row = this.sqlite.prepare("SELECT * FROM execution_identities WHERE id = ?").get(id) as IdentityRow | undefined;
    if (!row) throw new Error(`Unknown execution identity ${id}`);
    return row;
  }

  private requireSessionRow(id: string): SessionRow {
    const row = this.sqlite.prepare("SELECT * FROM execution_sessions WHERE id = ?").get(id) as SessionRow | undefined;
    if (!row) throw new Error(`Unknown Execution Session ${id}`);
    return row;
  }

  private requireSession(id: string): ExecutionSessionDescriptor { return descriptor(this.requireSessionRow(id)); }
}

function normalizeIdentitySecret(secret: ExecutionIdentitySecret): ExecutionIdentitySecret {
  return {
    headers: Object.fromEntries(Object.entries(secret.headers).map(([name, value]) => [name.trim(), String(value)]).filter(([name]) => name.length > 0)),
    cookies: mergeCookies([], secret.cookies),
  };
}

function mergeCookies(base: ExecutionCookie[], next: ExecutionCookie[]): ExecutionCookie[] {
  const merged = new Map<string, ExecutionCookie>();
  for (const cookie of [...base, ...next]) {
    if (!cookie.name.trim()) continue;
    const normalized = { ...cookie, name: cookie.name.trim(), value: String(cookie.value), path: cookie.path ?? "/" };
    merged.set(`${normalized.domain ?? ""}\u0000${normalized.path}\u0000${normalized.name}`, normalized);
  }
  return [...merged.values()];
}

function identityDescriptor(row: IdentityRow): ExecutionIdentityDescriptor {
  return { id: row.id, caseId: row.case_id, name: row.name, kind: row.kind, version: row.version, status: row.status, createdAt: row.created_at, updatedAt: row.updated_at };
}

function descriptor(row: SessionRow): ExecutionSessionDescriptor {
  return {
    id: row.id, caseId: row.case_id, runId: row.run_id, scopeRef: row.scope_ref,
    identityId: row.identity_id, identityVersion: row.identity_version, status: row.status,
    lastWorkerId: row.last_worker_id, lastWorkId: row.last_work_id, lastLeaseId: row.last_lease_id,
    lastLeaseExpiresAt: row.last_lease_expires_at, expiresAt: row.expires_at, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}
