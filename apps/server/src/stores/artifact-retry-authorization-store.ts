import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { ArtifactRetryAuthorizationSchema, type ArtifactRetryAuthorization } from "@traceforge/shared";
import type { Db } from "../db/client.js";
import { artifactRetryAuthorizations } from "../db/schema.js";

function fromRow(row: typeof artifactRetryAuthorizations.$inferSelect): ArtifactRetryAuthorization {
  return ArtifactRetryAuthorizationSchema.parse(row);
}

export class ArtifactRetryAuthorizationStore {
  constructor(private readonly db: Db) {}

  authorize(input: Omit<ArtifactRetryAuthorization, "id" | "status" | "createdAt" | "updatedAt">): ArtifactRetryAuthorization {
    const current = this.getActive(input.artifactId, input.analyzerId);
    if (current) this.revoke(current.id);
    const now = new Date().toISOString();
    const authorization = ArtifactRetryAuthorizationSchema.parse({
      ...input,
      id: `artifact_retry_${randomUUID()}`,
      status: "authorized",
      createdAt: now,
      updatedAt: now,
    });
    this.db.insert(artifactRetryAuthorizations).values(authorization).run();
    return authorization;
  }

  consume(id: string): ArtifactRetryAuthorization | undefined {
    return this.transition(id, "consumed");
  }

  revoke(id: string): ArtifactRetryAuthorization | undefined {
    return this.transition(id, "revoked");
  }

  private transition(id: string, status: "consumed" | "revoked"): ArtifactRetryAuthorization | undefined {
    const current = this.getById(id);
    if (!current || current.status !== "authorized") return current;
    const updatedAt = new Date().toISOString();
    this.db.update(artifactRetryAuthorizations).set({ status, updatedAt })
      .where(eq(artifactRetryAuthorizations.id, id)).run();
    return { ...current, status, updatedAt };
  }

  getById(id: string): ArtifactRetryAuthorization | undefined {
    const row = this.db.select().from(artifactRetryAuthorizations)
      .where(eq(artifactRetryAuthorizations.id, id)).get();
    return row ? fromRow(row) : undefined;
  }

  getActive(artifactId: string, analyzerId: string): ArtifactRetryAuthorization | undefined {
    return this.db.select().from(artifactRetryAuthorizations).where(and(
      eq(artifactRetryAuthorizations.artifactId, artifactId),
      eq(artifactRetryAuthorizations.analyzerId, analyzerId),
      eq(artifactRetryAuthorizations.status, "authorized"),
    )).all().map(fromRow).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
  }

  listByCase(caseId: string): ArtifactRetryAuthorization[] {
    return this.db.select().from(artifactRetryAuthorizations)
      .where(eq(artifactRetryAuthorizations.caseId, caseId)).all().map(fromRow)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }
}
