import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { ApprovalPreferenceUpdateSchema } from "@traceforge/shared/desktop-approval-preference";

/** A live host preference, not a Scenario resource grant or a model-editable setting. */
export class DesktopApprovalPreference {
  constructor(private readonly sqlite: Database.Database) {
    sqlite.exec(`CREATE TABLE IF NOT EXISTS desktop_approval_preferences (
      revision INTEGER PRIMARY KEY, required INTEGER NOT NULL CHECK(required IN (0,1)), changed_at TEXT NOT NULL)`);
  }
  read() {
    const row = this.sqlite.prepare("SELECT revision,required FROM desktop_approval_preferences ORDER BY revision DESC LIMIT 1").get() as { revision: number; required: number } | undefined;
    return { revision: row?.revision ?? 0, routineApprovalRequired: row ? row.required === 1 : true };
  }
  save(input: unknown) {
    const value = ApprovalPreferenceUpdateSchema.parse(input);
    return this.sqlite.transaction(() => {
      const previous = this.read();
      if (previous.revision !== value.expectedRevision) throw new Error("Approval preference changed; reload before retrying");
      this.sqlite.prepare("INSERT INTO desktop_approval_preferences VALUES (?,?,?)")
        .run(previous.revision + 1, Number(value.routineApprovalRequired), new Date().toISOString());
      return this.read();
    })();
  }
}
export function registerDesktopApprovalPreference(app: FastifyInstance, store: DesktopApprovalPreference) {
  app.get("/api/desktop/approval-preference", async () => store.read());
  app.post("/api/desktop/approval-preference", { bodyLimit: 1024 }, async (request, reply) => {
    if (!ApprovalPreferenceUpdateSchema.safeParse(request.body).success) return reply.code(400).send({ error: "Invalid preference" });
    try { return store.save(request.body); }
    catch { return reply.code(409).send({ error: "Preference not confirmed; reload" }); }
  });
}
