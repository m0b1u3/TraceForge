import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createDb, getSqliteClient } from "./db/client.js";
import { SqliteBrowserArtifactContent } from "./browser-artifact-content.js";
import type { BrowserArtifactPort } from "@traceforge/browser-runtime";
import { SqliteScenarioArtifactStore } from "./scenario-runtime-state.js";

function observation(body = Buffer.from("retained observation")): Parameters<BrowserArtifactPort["recordObservation"]>[0] {
  return { sessionId: "session", owner: { caseId: "case", runId: "run", workId: "work", workerId: "worker", scopeRef: "scope", leaseId: "lease", leaseExpiresAt: "2099-01-01T00:00:00Z", authorizationAction: "observe" },
    kind: "dom", view: { generation: 1, pageId: "page", documentId: "document" }, mimeType: "application/vnd.traceforge.browser-dom+json",
    bodyBase64: body.toString("base64"), byteSize: body.length, sha256: createHash("sha256").update(body).digest("hex") };
}
it("persists attributed content, deduplicates, reopens and rejects cross-owner reads", () => {
  const directory = mkdtempSync(join(tmpdir(), "browser-content-")), path = join(directory, "state.sqlite");
  let db = getSqliteClient(createDb(path));
  try {
    let store = new SqliteBrowserArtifactContent(db); const input = observation(); const { ref } = store.recordObservation(input);
    expect(store.recordObservation(input).ref).toBe(ref);
    expect(db.prepare("SELECT count(*) AS n FROM browser_artifact_content").get()).toEqual({ n: 1 });
    db.close(); db = getSqliteClient(createDb(path)); store = new SqliteBrowserArtifactContent(db);
    expect(store.read(ref, input.owner)?.toString()).toBe("retained observation");
    expect(store.read(ref, { ...input.owner, runId: "other" })).toBeUndefined();
    expect(store.read(ref, { ...input.owner, caseId: "other" })).toBeUndefined();
    expect(() => db.prepare("UPDATE browser_artifact_content SET body=? WHERE ref=?").run(Buffer.from("changed"), ref)).toThrow("immutable");
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});
it("rejects malformed content and accepts evidence beyond the old 4 MiB limit", () => {
  const db = getSqliteClient(createDb(":memory:"));
  try {
    const store = new SqliteBrowserArtifactContent(db), input = observation();
    expect(() => store.recordObservation({ ...input, sha256: "a".repeat(64) })).toThrow("digest mismatch");
    expect(() => store.recordObservation({ ...input, bodyBase64: input.bodyBase64 + "\n" })).toThrow("digest mismatch");
    expect(store.recordObservation(observation(Buffer.alloc(4194305))).ref).toMatch(/^browser-content:/);
    expect(db.prepare("SELECT count(*) AS n FROM browser_artifact_content").get()).toEqual({ n: 1 });
  } finally { db.close(); }
});
it("commits content and its real index atomically, rolls back failure, and only prunes unreferenced bodies", () => {
  const db = getSqliteClient(createDb(":memory:"));
  try {
    const store = new SqliteBrowserArtifactContent(db), index = new SqliteScenarioArtifactStore(db), input = observation();
    const link = (saved: { ref: string }) => { return index.record({ packageId: "fixture", packageVersion: "1.0.0", caseId: "case", runId: "run",
      commandId: "first", kind: "browser.observation", summary: "Observation", contentRef: saved.ref, digest: `sha256:${input.sha256}`, byteSize: input.byteSize, metadata: {} }); };
    expect(() => store.persistArtifact("observation", input, saved => { link(saved); throw new Error("index interrupted"); })).toThrow("interrupted");
    for (const table of ["browser_artifact_content", "scenario_artifacts", "scenario_artifact_commands"])
      expect(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
    expect(() => store.persistArtifact("observation", input, () => {})).toThrow("matching index");
    const saved = store.persistArtifact("observation", input, link);
    expect(store.persistArtifact("observation", input, link)).toEqual(saved);
    store.recordObservation(observation(Buffer.from("unindexed legacy body")));
    expect(store.pruneUnreferenced()).toBe(1);
    expect(store.read(saved.ref, input.owner)).toBeDefined();
    expect(store.pruneUnreferenced()).toBe(0);
  } finally { db.close(); }
});
