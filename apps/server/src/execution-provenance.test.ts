import { expect, it } from "vitest";
import { createDb, getSqliteClient } from "./db/client.js";
import { SqliteToolInvocationBindingStore, SqliteToolReceiptStore } from "./worker-execution-adapters.js";
import { toolReceiptProvenance, executionSourceProvenance } from "./execution-provenance.js";
import { SqliteScenarioArtifactStore } from "./scenario-runtime-state.js";
import { archiveExecutionRow } from "./db/execution-archive.js";

it("uses original traffic and artifact provenance and rejects cross-Run, cross-Case and incomplete observations",()=>{
  const db=getSqliteClient(createDb(":memory:")),owner={caseId:"case",runId:"run"},at="2026-09-01T00:00:00.000Z";
  try{
    db.prepare("INSERT INTO traffic_entries (id,case_id,run_id,url,method,request_headers_json,response_status,created_at) VALUES ('first','case','run','https://first.example/','GET','{}',200,?)").run(at);
    const source={type:"traffic" as const,ref:"first"};
    const original=executionSourceProvenance(db,source,owner);
    expect(original).toMatchObject({observedAt:at,producerId:"traffic:first",integrity:{algorithm:"sha256"}});
    for(const other of [{caseId:"other",runId:"run"},{caseId:"case",runId:"other"}])expect(()=>executionSourceProvenance(db,source,other)).toThrow("Case/Run");
    db.prepare("UPDATE traffic_entries SET response_body='changed' WHERE id='first'").run();
    expect(executionSourceProvenance(db,source,owner).integrity).not.toEqual(original.integrity);
    db.prepare("UPDATE traffic_entries SET response_status=NULL WHERE id='first'").run();
    expect(()=>executionSourceProvenance(db,source,owner)).toThrow("not complete");
    const artifact=new SqliteScenarioArtifactStore(db,()=>at).record({...owner,packageId:"neutral",packageVersion:"1",commandId:"save",kind:"observation",summary:"saved",contentRef:"artifact:first",digest:`sha256:${"a".repeat(64)}`,byteSize:1,metadata:{}});
    expect(executionSourceProvenance(db,{type:"artifact",ref:artifact.id},owner)).toMatchObject({observedAt:at,producerId:"neutral@1"});
    expect(()=>executionSourceProvenance(db,{type:"artifact",ref:artifact.id},{...owner,runId:"other"})).toThrow("Case/Run");
  }finally{db.close();}
});

it("binds evidence to completed same-Run receipts, original time/producer and content digest", async () => {
  const db = getSqliteClient(createDb(":memory:")), bindings = new SqliteToolInvocationBindingStore(db);
  const at = "2026-09-01T00:00:00.000Z", receipts = new SqliteToolReceiptStore(db, () => at);
  try {
    await bindings.prepare({ idempotencyKey: "observation", invocationId: "first", tool: { name: "read", source: "local.fixture", version: "1", contractFingerprint: "a".repeat(64) },
      inputFingerprint: "b".repeat(64), attribution: { caseId: "case", runId: "run", workId: "work" } });
    await receipts.put("observation", { status: "succeeded", raw: "observed", summary: "observed", refs: [], retryable: false });
    expect(() => toolReceiptProvenance(db, "observation", { caseId: "case", runId: "run" })).toThrow("not complete");
    await bindings.complete("observation");
    expect(() => toolReceiptProvenance(db, "observation", { caseId: "other", runId: "run" })).toThrow("Case/Run");
    expect(() => toolReceiptProvenance(db, "observation", { caseId: "case", runId: "other" })).toThrow("Case/Run");
    expect(toolReceiptProvenance(db, "observation", { caseId: "case", runId: "run" })).toMatchObject({ observedAt: at,
      producerId: "local.fixture@1:first", integrity: { algorithm: "sha256", digest: expect.stringMatching(/^[a-f0-9]{64}$/) } });
    const original = toolReceiptProvenance(db, "observation", { caseId: "case", runId: "run" });
    db.transaction(() => archiveExecutionRow(db, "receipt", "observation", at))();
    expect(toolReceiptProvenance(db, "observation", { caseId: "case", runId: "run" })).toEqual(original);
  } finally { db.close(); }
});
