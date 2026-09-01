import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { createDb, getSqliteClient } from "./db/client.js";
import { SqliteScenarioArtifactStore, SqliteScenarioStateStore } from "./scenario-runtime-state.js";

const opened: Database.Database[] = [], roots: string[] = [];
afterEach(() => { while(opened.length) opened.pop()!.close(); while(roots.length) rmSync(roots.pop()!,{recursive:true,force:true}); });
function db(path=":memory:"){const value=getSqliteClient(createDb(path));opened.push(value);return value;}
const owner={packageId:"fixture.package",packageVersion:"1.0.0",caseId:"case",runId:"run"};
const artifact={...owner,commandId:"artifact-command",kind:"observation",summary:"Bounded observation",contentRef:"host-artifact://content/first",
  digest:`sha256:${"a".repeat(64)}` as const,byteSize:12,metadata:{source:"fixture"}};

describe("generic Scenario Artifact and State persistence",()=>{
  it("records idempotent Artifact envelopes and rejects command mutation",()=>{
    const store=new SqliteScenarioArtifactStore(db(),()=>"2026-09-01T00:00:00.000Z");
    const first=store.record(artifact);expect(store.record(artifact)).toEqual(first);
    expect(()=>store.record({...artifact,summary:"changed"})).toThrow("command conflict");
    expect(store.get({...owner,artifactId:first.id})).toEqual(first);
  });
  it("isolates Artifact reads by package version and Case",()=>{
    const store=new SqliteScenarioArtifactStore(db());const first=store.record(artifact);
    expect(store.get({...owner,caseId:"other",artifactId:first.id})).toBeUndefined();
    expect(store.get({...owner,packageVersion:"2.0.0",artifactId:first.id})).toBeUndefined();
    expect(store.list({...owner,limit:10})).toHaveLength(1);
  });
  it("uses compare-and-set revisions with replay-safe command results",()=>{
    const store=new SqliteScenarioStateStore(db(),()=>"2026-09-01T00:00:00.000Z");
    const command={...owner,commandId:"state-command",key:"cursor",expectedRevision:0,value:{offset:1}};
    const first=store.compareAndSet(command);expect(first.revision).toBe(1);expect(store.compareAndSet(command)).toEqual(first);
    expect(()=>store.compareAndSet({...command,commandId:"second",expectedRevision:0})).toThrow("revision conflict");
    expect(()=>store.compareAndSet({...command,value:{offset:2}})).toThrow("command conflict");
  });
  it("survives a complete database reopen without losing identity or revisions",()=>{
    const root=mkdtempSync(join(tmpdir(),"traceforge-scenario-state-"));roots.push(root);const path=join(root,"state.db");
    const firstDb=db(path),artifacts=new SqliteScenarioArtifactStore(firstDb),states=new SqliteScenarioStateStore(firstDb);
    const recorded=artifacts.record(artifact);states.compareAndSet({...owner,commandId:"state-command",key:"cursor",expectedRevision:0,value:{offset:1}});
    opened.pop()!.close();const reopened=db(path);
    expect(new SqliteScenarioArtifactStore(reopened).get({...owner,artifactId:recorded.id})?.digest).toBe(artifact.digest);
    expect(new SqliteScenarioStateStore(reopened).read({...owner,key:"cursor"})).toMatchObject({revision:1,value:{offset:1}});
  });
  it("rejects oversized state, metadata, invalid digests and unbounded lists",()=>{
    const sqlite=db(),artifacts=new SqliteScenarioArtifactStore(sqlite),states=new SqliteScenarioStateStore(sqlite);
    expect(()=>artifacts.record({...artifact,digest:"sha256:no" as `sha256:${string}`})).toThrow("canonical sha256");
    expect(()=>artifacts.record({...artifact,commandId:"large",metadata:{value:"x".repeat(20_000)}})).toThrow("exceeds");
    expect(()=>artifacts.list({...owner,limit:201})).toThrow("1..200");
    expect(()=>states.compareAndSet({...owner,commandId:"large-state",key:"state",expectedRevision:0,value:"x".repeat(300_000)})).toThrow("exceeds");
    expect(()=>states.compareAndSet({...owner,commandId:"invalid-state",key:"state",expectedRevision:0,value:undefined})).toThrow("JSON-compatible");
  });
  it("enforces per-package record capacity without blocking updates or other package versions",()=>{
    const sqlite=db();
    const artifacts=new SqliteScenarioArtifactStore(sqlite,undefined,{maxArtifactsPerPackage:1});
    artifacts.record(artifact);
    expect(()=>artifacts.record({...artifact,commandId:"second-artifact",kind:"second"})).toThrow("capacity exhausted");
    expect(()=>artifacts.record({...artifact,packageVersion:"2.0.0",commandId:"second-version"})).not.toThrow();
    const states=new SqliteScenarioStateStore(sqlite,undefined,{maxStateEntriesPerPackage:1});
    states.compareAndSet({...owner,commandId:"first-state",key:"first",expectedRevision:0,value:{revision:1}});
    expect(()=>states.compareAndSet({...owner,commandId:"second-state",key:"second",expectedRevision:0,value:{revision:1}})).toThrow("capacity exhausted");
    expect(()=>states.compareAndSet({...owner,commandId:"update-state",key:"first",expectedRevision:1,value:{revision:2}})).not.toThrow();
  });
});
