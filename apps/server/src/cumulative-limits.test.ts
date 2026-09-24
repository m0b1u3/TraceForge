import { expect, it } from "vitest";
import { ScenarioPackageRegistry } from "@traceforge/scenario-sdk";
import { createDb, getSqliteClient } from "./db/client.js";
import { DesktopMcpControl } from "./desktop-mcp.js";
import { RunContextPolicy } from "./run-context-policy.js";
import { SqliteRunObserverStore } from "./run-observer.js";

it("replaces old cumulative triggers and continues recording across Runs", () => {
  const db = createDb(":memory:"), sql = getSqliteClient(db);
  try {
    new DesktopMcpControl(sql, new ScenarioPackageRegistry([]), () => null);
    sql.exec(`DROP TRIGGER desktop_mcp_runs_capacity;
      CREATE TRIGGER desktop_mcp_runs_capacity BEFORE INSERT ON desktop_mcp_runs BEGIN
        SELECT RAISE(ABORT,'old MCP count gate'); END;`);
    new DesktopMcpControl(sql, new ScenarioPackageRegistry([]), () => null);
    sql.prepare("INSERT INTO desktop_mcp_runs VALUES ('new-run','source',1)").run();

    const resources = {} as ConstructorParameters<typeof RunContextPolicy>[1];
    const snapshots = {} as ConstructorParameters<typeof RunContextPolicy>[3];
    new RunContextPolicy(sql, resources, () => null, snapshots);
    sql.exec(`DROP TRIGGER context_derivations_bounded;
      CREATE TRIGGER context_derivations_bounded BEFORE INSERT ON context_derivations BEGIN
        SELECT RAISE(ABORT,'old context count gate'); END;`);
    new RunContextPolicy(sql, resources, () => null, snapshots);
    const context = sql.prepare("INSERT INTO context_derivations VALUES ('case',?,'work','target','snapshot','[]')");
    sql.transaction(() => { for (let i = 0; i < 8193; i++) context.run(`run-${i}`); })();
    expect(sql.prepare("SELECT count(*) AS n FROM context_derivations").get()).toEqual({ n: 8193 });

    new SqliteRunObserverStore(sql);
    sql.exec(`DROP TRIGGER observer_context_bounded;
      CREATE TRIGGER observer_context_bounded BEFORE INSERT ON scenario_observer_context_evaluations BEGIN
        SELECT RAISE(ABORT,'old observer count gate'); END;`);
    new SqliteRunObserverStore(sql);
    const observation = sql.prepare(`INSERT INTO scenario_observer_context_evaluations
      (id,run_id,case_id,observed_run_revision,observed_graph_revision,context_fingerprint,decision_json,created_at)
      VALUES (?,'run','case',?,0,'fingerprint','{}','2026-01-01')`);
    sql.transaction(() => { for (let i = 0; i < 4097; i++) observation.run(`observation-${i}`, i); })();
    expect(sql.prepare("SELECT count(*) AS n FROM scenario_observer_context_evaluations").get()).toEqual({ n: 4097 });
  } finally { sql.close(); }
});
