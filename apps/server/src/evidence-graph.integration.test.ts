import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { createDb, getSqliteClient } from "./db/client.js";
import {
  EvidenceGraphIdempotencyConflictError,
  EvidenceGraphRevisionConflictError,
  SqliteEvidenceGraphStore,
} from "./evidence-graph-store.js";
import { registerEvidenceGraphRoutes } from "./evidence-graph-routes.js";
import { EvidenceGraphMutateTool } from "./evidence-graph-tools.js";

const open: Database.Database[] = [];
const at = "2026-08-24T08:00:00.000Z";

function setup() {
  const db = createDb(":memory:");
  const sqlite = getSqliteClient(db);
  open.push(sqlite);
  sqlite.prepare("INSERT INTO cases (id, name, status, scope_rules_json, created_at) VALUES (?, ?, ?, ?, ?)")
    .run("case_1", "Authorized assessment", "active", "{}", at);
  return { sqlite, store: new SqliteEvidenceGraphStore(sqlite) };
}

afterEach(() => {
  while (open.length) open.pop()!.close();
});

describe("durable Evidence Graph", () => {
  it("replays commands, rejects stale writes, and atomically projects invalidation propagation", () => {
    const { sqlite, store } = setup();
    let state = store.ensure("case_1", at);
    const add = (commandId: string, node: { id: string; kind: "evidence" | "validation_conclusion"; status: "active" | "resolved"; source?: object }) => {
      const result = store.execute({
        caseId: "case_1", commandId, expectedRevision: state.revision,
        command: { type: "add_node", at, node: {
          id: node.id, caseId: "case_1", runId: "run_1", kind: node.kind, title: node.id,
          summary: `Summary for ${node.id}`, status: node.status, confidence: 0.8, properties: {}, source: (node.source ?? null) as never,
        } },
      });
      state = result.state;
      return result;
    };
    const first = add("add_evidence", {
      id: "evidence_1", kind: "evidence", status: "active",
      source: { type: "traffic", ref: "traffic_1", observedAt: at, producerId: "worker_1" },
    });
    const replay = store.execute({
      caseId: "case_1", commandId: "add_evidence", expectedRevision: 1,
      command: { type: "add_node", at, node: {
        id: "evidence_1", caseId: "case_1", runId: "run_1", kind: "evidence", title: "evidence_1",
        summary: "Summary for evidence_1", status: "active", confidence: 0.8, properties: {},
        source: { type: "traffic", ref: "traffic_1", observedAt: at, producerId: "worker_1" },
      } },
    });
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.state).toEqual(first.state);
    expect(() => store.execute({
      caseId: "case_1", commandId: "stale", expectedRevision: 1,
      command: { type: "invalidate_node", nodeId: "evidence_1", reason: "stale", at },
    })).toThrow(EvidenceGraphRevisionConflictError);
    expect(() => store.execute({
      caseId: "case_1", commandId: "add_evidence", expectedRevision: state.revision,
      command: { type: "invalidate_node", nodeId: "evidence_1", reason: "different command", at },
    })).toThrow(EvidenceGraphIdempotencyConflictError);

    add("add_conclusion", { id: "conclusion_1", kind: "validation_conclusion", status: "resolved" });
    state = store.execute({
      caseId: "case_1", commandId: "connect", expectedRevision: state.revision,
      command: { type: "add_edge", edge: { id: "edge_1", sourceId: "evidence_1", targetId: "conclusion_1", relation: "supports", rationale: "Traceable support" }, at },
    }).state;
    const invalidated = store.execute({
      caseId: "case_1", commandId: "invalidate", expectedRevision: state.revision,
      command: { type: "invalidate_node", nodeId: "evidence_1", reason: "Source withdrawn", at },
    });
    expect(invalidated.events).toHaveLength(2);
    const rows = sqlite.prepare("SELECT id, status FROM evidence_graph_nodes ORDER BY id").all();
    expect(rows).toEqual([
      { id: "conclusion_1", status: "needs_review" },
      { id: "evidence_1", status: "invalidated" },
    ]);
    expect(store.load("case_1")).toEqual(invalidated.state);
  });

  it("exposes revisioned graph commands and bounded neighborhood queries", async () => {
    const { sqlite, store } = setup();
    const app = Fastify();
    registerEvidenceGraphRoutes(app, sqlite, store, () => at);
    await app.ready();
    const empty = await app.inject({ method: "GET", url: "/api/knowledge-graph/case_1" });
    expect(empty.statusCode).toBe(200);
    expect(empty.json().revision).toBe(1);
    const added = await app.inject({ method: "POST", url: "/api/knowledge-graph/case_1/commands", payload: {
      commandId: "add_entity", expectedRevision: 1,
      command: { type: "add_node", node: {
        id: "entity_1", runId: null, kind: "entity", title: "Application",
        summary: "Authorized application", status: "active", confidence: 1, properties: {}, source: null,
      } },
    } });
    expect(added.statusCode).toBe(201);
    const adjacent = await app.inject({ method: "GET", url: "/api/knowledge-graph/case_1/nodes/entity_1?depth=1" });
    expect(adjacent.statusCode).toBe(200);
    expect(adjacent.json().center.id).toBe("entity_1");
    await app.close();
  });

  it("prevents Workers from inventing Evidence source references", async () => {
    const { sqlite, store } = setup();
    const tool = new EvidenceGraphMutateTool(sqlite, store, () => at);
    const context = {
      workerId: "worker_1", runId: "run_1", workId: "work_1", caseId: "case_1", scopeRef: "scope_1",
      leaseId: "lease_1", leaseExpiresAt: "2026-08-24T09:00:00.000Z", idempotencyKey: "invocation_1",
      effectivePermissions: {
        version: 1 as const,
        platform: "windows" as const,
        filesystem: { read: [], write: [], deny: [] },
        network: "deny" as const,
        process: { access: "deny" as const, interactive: false, background: false },
        secrets: "deny" as const,
        sources: ["test"],
      },
    };
    await expect(tool.execute({
      type: "add_node", node: {
        id: "evidence_1", kind: "evidence", title: "Observation", summary: "Persisted observation",
        status: "active", confidence: 0.8, properties: {}, source: { type: "traffic", ref: "missing_traffic" },
      },
    }, context)).rejects.toThrow(/does not exist/);
    sqlite.prepare(`
      INSERT INTO traffic_entries
        (id, case_id, url, method, request_headers_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run("traffic_1", "case_1", "https://authorized.example", "GET", "{}", at);
    const result = await tool.execute({
      type: "add_node", node: {
        id: "evidence_1", kind: "evidence", title: "Observation", summary: "Persisted observation",
        status: "active", confidence: 0.8, properties: {}, source: { type: "traffic", ref: "traffic_1" },
      },
    }, context);
    expect(result.status).toBe("succeeded");
    expect(store.load("case_1")?.nodes[0].source?.ref).toBe("traffic_1");
  });
});
