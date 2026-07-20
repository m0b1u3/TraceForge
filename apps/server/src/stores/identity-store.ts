import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { type IdentityContext, IdentityContextSchema } from "@traceforge/shared";
import type { Db } from "../db/client.js";
import { identityContexts } from "../db/schema.js";

type IdentityInput = Omit<IdentityContext, "id" | "caseId" | "version" | "createdAt" | "updatedAt">
  & Partial<Pick<IdentityContext, "status">>;

function fromRow(row: typeof identityContexts.$inferSelect): IdentityContext {
  return IdentityContextSchema.parse({
    id: row.id,
    caseId: row.caseId,
    name: row.name,
    kind: row.kind,
    status: row.status,
    version: row.version,
    credentials: JSON.parse(row.credentialsJson),
    headers: JSON.parse(row.headersJson),
    cookies: JSON.parse(row.cookiesJson),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

export class IdentityStore {
  constructor(private db: Db) {}

  create(caseId: string, input: IdentityInput): IdentityContext {
    const now = new Date().toISOString();
    const identity = IdentityContextSchema.parse({
      ...input,
      id: `identity_${randomUUID()}`,
      caseId,
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    this.db.insert(identityContexts).values({
      id: identity.id,
      caseId,
      name: identity.name,
      kind: identity.kind,
      status: identity.status,
      version: identity.version,
      credentialsJson: JSON.stringify(identity.credentials),
      headersJson: JSON.stringify(identity.headers),
      cookiesJson: JSON.stringify(identity.cookies),
      createdAt: now,
      updatedAt: now,
    }).run();
    return identity;
  }

  getById(id: string): IdentityContext | undefined {
    const row = this.db.select().from(identityContexts).where(eq(identityContexts.id, id)).get();
    return row ? fromRow(row) : undefined;
  }

  update(
    id: string,
    patch: Partial<Pick<IdentityContext, "name" | "kind" | "status" | "credentials" | "headers" | "cookies">>,
  ): IdentityContext | undefined {
    const current = this.getById(id);
    if (!current) return undefined;
    const next = IdentityContextSchema.parse({
      ...current,
      ...patch,
      version: current.version + 1,
      updatedAt: new Date().toISOString(),
    });
    this.db.update(identityContexts).set({
      name: next.name,
      kind: next.kind,
      status: next.status,
      version: next.version,
      credentialsJson: JSON.stringify(next.credentials),
      headersJson: JSON.stringify(next.headers),
      cookiesJson: JSON.stringify(next.cookies),
      updatedAt: next.updatedAt,
    }).where(eq(identityContexts.id, id)).run();
    return next;
  }

  listByCase(caseId: string): IdentityContext[] {
    return this.db.select().from(identityContexts).where(eq(identityContexts.caseId, caseId)).all().map(fromRow);
  }
}
