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

  addAllowHost(id: string, host: string): Case | undefined {
    const c = this.get(id);
    if (!c) return undefined;
    const rules = c.scopeRules.length > 0
      ? c.scopeRules.map((r) => ({ ...r }))
      : [{ caseId: "pending", allowHosts: [], denyHosts: [] }];
    if (!rules[0].allowHosts.includes(host)) {
      rules[0] = { ...rules[0], allowHosts: [...rules[0].allowHosts, host] };
    }
    this.db.update(cases).set({ scopeRulesJson: JSON.stringify(rules) }).where(eq(cases.id, id)).run();
    return CaseSchema.parse({ ...c, scopeRules: rules });
  }

  update(id: string, patch: Partial<Pick<Case, "name" | "status">>): Case | undefined {
    const current = this.get(id);
    if (!current) return undefined;
    const next = CaseSchema.parse({ ...current, ...patch });
    this.db.update(cases).set({ name: next.name, status: next.status }).where(eq(cases.id, id)).run();
    return next;
  }

  list(): Case[] {
    return this.db.select().from(cases).all().map((row) =>
      CaseSchema.parse({
        id: row.id, name: row.name, status: row.status,
        scopeRules: JSON.parse(row.scopeRulesJson), createdAt: row.createdAt,
      }),
    );
  }

  delete(id: string): boolean {
    const result = this.db.delete(cases).where(eq(cases.id, id)).run();
    return result.changes > 0;
  }
}
