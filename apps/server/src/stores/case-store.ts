import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { cases } from "../db/schema.js";
import { type Case, type ScopeRule, CaseSchema } from "@traceforge/shared";

export class CaseStore {
  constructor(private db: Db) {}

  create(name: string, scopeRules: ScopeRule[]): Case {
    const id = `case_${randomUUID()}`;
    const createdAt = new Date().toISOString();
    const c = CaseSchema.parse({ id, name, status: "active", scopeRules, createdAt });
    this.db.insert(cases).values({
      id, name, status: c.status,
      scopeRulesJson: JSON.stringify(scopeRules), createdAt,
    }).run();
    return c;
  }

  get(id: string): Case | undefined {
    const row = this.db.select().from(cases).where(eq(cases.id, id)).get();
    if (!row) return undefined;
    return CaseSchema.parse({
      id: row.id, name: row.name, status: row.status,
      scopeRules: JSON.parse(row.scopeRulesJson), createdAt: row.createdAt,
    });
  }

  list(): Case[] {
    return this.db.select().from(cases).all().map((row) =>
      CaseSchema.parse({
        id: row.id, name: row.name, status: row.status,
        scopeRules: JSON.parse(row.scopeRulesJson), createdAt: row.createdAt,
      }),
    );
  }
}
