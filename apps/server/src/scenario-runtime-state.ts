import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { canonicalJson } from "@traceforge/orchestration-core";
import type { ScenarioArtifactPort, ScenarioArtifactRecord, ScenarioStatePort, ScenarioStateRecord } from "@traceforge/scenario-sdk";

const MAX_METADATA_BYTES = 16 * 1024;
const MAX_STATE_BYTES = 256 * 1024;
const MAX_SUMMARY_BYTES = 4096;
const DEFAULT_MAX_RECORDS_PER_PACKAGE = 100_000;

export interface ScenarioRuntimeStateLimits {
  maxArtifactsPerPackage: number;
  maxStateEntriesPerPackage: number;
}

export class SqliteScenarioArtifactStore implements ScenarioArtifactPort {
  private readonly maxArtifactsPerPackage: number;
  constructor(
    private readonly sqlite: Database.Database,
    private readonly now: () => string = () => new Date().toISOString(),
    limits: Partial<ScenarioRuntimeStateLimits> = {},
  ) {
    this.maxArtifactsPerPackage = positiveLimit(limits.maxArtifactsPerPackage ?? DEFAULT_MAX_RECORDS_PER_PACKAGE, "Artifact");
  }

  record(input: Parameters<ScenarioArtifactPort["record"]>[0]): ScenarioArtifactRecord {
    validateIdentity(input); text(input.commandId, "commandId", 256); text(input.kind, "kind", 128);
    text(input.summary, "summary", MAX_SUMMARY_BYTES); text(input.contentRef, "contentRef", 2048);
    if (!/^sha256:[a-f0-9]{64}$/.test(input.digest)) throw new Error("Scenario Artifact digest must be canonical sha256");
    if (!Number.isSafeInteger(input.byteSize) || input.byteSize < 0) throw new Error("Scenario Artifact byteSize is invalid");
    const metadataJson = boundedJson(input.metadata, MAX_METADATA_BYTES, "Scenario Artifact metadata");
    const fingerprint = digest({ ...input, metadata: JSON.parse(metadataJson) });
    return this.sqlite.transaction(() => {
      const command = this.sqlite.prepare(`SELECT fingerprint, artifact_id FROM scenario_artifact_commands
        WHERE package_id=? AND package_version=? AND command_id=?`).get(input.packageId, input.packageVersion, input.commandId) as
        { fingerprint: string; artifact_id: string } | undefined;
      if (command) {
        if (command.fingerprint !== fingerprint) throw new Error("Scenario Artifact command conflict");
        return this.require(input.packageId, input.packageVersion, input.caseId, command.artifact_id);
      }
      const count = this.sqlite.prepare(`SELECT COUNT(*) AS total FROM scenario_artifacts WHERE package_id=? AND package_version=?`)
        .get(input.packageId, input.packageVersion) as { total: number };
      if (count.total >= this.maxArtifactsPerPackage) throw new Error("Scenario Artifact package capacity exhausted");
      const { commandId: _commandId, ...artifactInput } = input;
      const record: ScenarioArtifactRecord = { ...artifactInput, id: `scenario-artifact:${randomUUID()}`, createdAt: this.now() };
      this.sqlite.prepare(`INSERT INTO scenario_artifacts
        (id,package_id,package_version,case_id,run_id,kind,summary,content_ref,digest,byte_size,metadata_json,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(record.id,record.packageId,record.packageVersion,record.caseId,record.runId,
        record.kind,record.summary,record.contentRef,record.digest,record.byteSize,metadataJson,record.createdAt);
      this.sqlite.prepare(`INSERT INTO scenario_artifact_commands
        (package_id,package_version,command_id,fingerprint,artifact_id,created_at) VALUES (?,?,?,?,?,?)`)
        .run(record.packageId,record.packageVersion,input.commandId,fingerprint,record.id,record.createdAt);
      return record;
    })();
  }

  get(input: Parameters<ScenarioArtifactPort["get"]>[0]): ScenarioArtifactRecord | undefined {
    validatePackage(input); text(input.caseId,"caseId",256); text(input.artifactId,"artifactId",256);
    const row=this.sqlite.prepare(`SELECT * FROM scenario_artifacts WHERE package_id=? AND package_version=? AND case_id=? AND id=?`)
      .get(input.packageId,input.packageVersion,input.caseId,input.artifactId) as ArtifactRow|undefined;
    return row ? artifact(row) : undefined;
  }

  list(input: Parameters<ScenarioArtifactPort["list"]>[0]): ScenarioArtifactRecord[] {
    validatePackage(input); text(input.caseId,"caseId",256);
    if (!Number.isSafeInteger(input.limit)||input.limit<1||input.limit>200) throw new Error("Scenario Artifact list limit must be 1..200");
    if(input.runId)text(input.runId,"runId",256);
    const rows=(input.runId
      ? this.sqlite.prepare(`SELECT * FROM scenario_artifacts WHERE package_id=? AND package_version=? AND case_id=? AND run_id=? ORDER BY created_at DESC,id DESC LIMIT ?`)
        .all(input.packageId,input.packageVersion,input.caseId,input.runId,input.limit)
      : this.sqlite.prepare(`SELECT * FROM scenario_artifacts WHERE package_id=? AND package_version=? AND case_id=? ORDER BY created_at DESC,id DESC LIMIT ?`)
        .all(input.packageId,input.packageVersion,input.caseId,input.limit)) as ArtifactRow[];
    return rows.map(artifact);
  }

  private require(packageId:string,packageVersion:string,caseId:string,id:string):ScenarioArtifactRecord {
    const value=this.get({packageId,packageVersion,caseId,artifactId:id});if(!value)throw new Error("Scenario Artifact command result is missing");return value;
  }
}

export class SqliteScenarioStateStore implements ScenarioStatePort {
  private readonly maxStateEntriesPerPackage: number;
  constructor(
    private readonly sqlite: Database.Database,
    private readonly now: () => string = () => new Date().toISOString(),
    limits: Partial<ScenarioRuntimeStateLimits> = {},
  ) {
    this.maxStateEntriesPerPackage = positiveLimit(limits.maxStateEntriesPerPackage ?? DEFAULT_MAX_RECORDS_PER_PACKAGE, "State");
  }
  read(input: Parameters<ScenarioStatePort["read"]>[0]): ScenarioStateRecord | undefined {
    validateStateIdentity(input);
    const row=this.sqlite.prepare(`SELECT * FROM scenario_states WHERE package_id=? AND package_version=? AND case_id=? AND run_id=? AND state_key=?`)
      .get(input.packageId,input.packageVersion,input.caseId,input.runId,input.key) as StateRow|undefined;
    return row?state(row):undefined;
  }
  compareAndSet(input: Parameters<ScenarioStatePort["compareAndSet"]>[0]): ScenarioStateRecord {
    validateStateIdentity(input);text(input.commandId,"commandId",256);
    if(!Number.isSafeInteger(input.expectedRevision)||input.expectedRevision<0)throw new Error("Scenario State expectedRevision is invalid");
    const valueJson=boundedJson(input.value,MAX_STATE_BYTES,"Scenario State value");
    const fingerprint=digest({...input,value:JSON.parse(valueJson)});
    return this.sqlite.transaction(()=>{
      const command=this.sqlite.prepare(`SELECT fingerprint,result_json FROM scenario_state_commands WHERE package_id=? AND package_version=? AND command_id=?`)
        .get(input.packageId,input.packageVersion,input.commandId) as {fingerprint:string;result_json:string}|undefined;
      if(command){if(command.fingerprint!==fingerprint)throw new Error("Scenario State command conflict");return JSON.parse(command.result_json) as ScenarioStateRecord;}
      const current=this.read(input);const revision=current?.revision??0;
      if(revision!==input.expectedRevision)throw new Error(`Scenario State revision conflict: expected ${input.expectedRevision}, current ${revision}`);
      if (!current) {
        const count = this.sqlite.prepare(`SELECT COUNT(*) AS total FROM scenario_states WHERE package_id=? AND package_version=?`)
          .get(input.packageId, input.packageVersion) as { total: number };
        if (count.total >= this.maxStateEntriesPerPackage) throw new Error("Scenario State package capacity exhausted");
      }
      const result:ScenarioStateRecord={packageId:input.packageId,packageVersion:input.packageVersion,caseId:input.caseId,runId:input.runId,
        key:input.key,revision:revision+1,value:JSON.parse(valueJson),updatedAt:this.now()};
      this.sqlite.prepare(`INSERT INTO scenario_states (package_id,package_version,case_id,run_id,state_key,revision,value_json,updated_at)
        VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(package_id,package_version,case_id,run_id,state_key) DO UPDATE SET
        revision=excluded.revision,value_json=excluded.value_json,updated_at=excluded.updated_at`)
        .run(result.packageId,result.packageVersion,result.caseId,result.runId,result.key,result.revision,valueJson,result.updatedAt);
      this.sqlite.prepare(`INSERT INTO scenario_state_commands (package_id,package_version,command_id,fingerprint,result_json,created_at) VALUES (?,?,?,?,?,?)`)
        .run(result.packageId,result.packageVersion,input.commandId,fingerprint,JSON.stringify(result),result.updatedAt);
      return result;
    })();
  }
}

interface ArtifactRow {id:string;package_id:string;package_version:string;case_id:string;run_id:string;kind:string;summary:string;content_ref:string;
  digest:string;byte_size:number;metadata_json:string;created_at:string}
interface StateRow {package_id:string;package_version:string;case_id:string;run_id:string;state_key:string;revision:number;value_json:string;updated_at:string}
function artifact(row:ArtifactRow):ScenarioArtifactRecord{return{id:row.id,packageId:row.package_id,packageVersion:row.package_version,
  caseId:row.case_id,runId:row.run_id,kind:row.kind,summary:row.summary,contentRef:row.content_ref,digest:row.digest as `sha256:${string}`,
  byteSize:row.byte_size,metadata:JSON.parse(row.metadata_json),createdAt:row.created_at};}
function state(row:StateRow):ScenarioStateRecord{return{packageId:row.package_id,packageVersion:row.package_version,caseId:row.case_id,runId:row.run_id,
  key:row.state_key,revision:row.revision,value:JSON.parse(row.value_json),updatedAt:row.updated_at};}
function validatePackage(value:{packageId:string;packageVersion:string}){text(value.packageId,"packageId",256);text(value.packageVersion,"packageVersion",128);}
function validateIdentity(value:{packageId:string;packageVersion:string;caseId:string;runId:string}){validatePackage(value);text(value.caseId,"caseId",256);text(value.runId,"runId",256);}
function validateStateIdentity(value:{packageId:string;packageVersion:string;caseId:string;runId:string;key:string}){validateIdentity(value);text(value.key,"key",256);}
function text(value:string,name:string,max:number){if(typeof value!=="string"||!value.trim()||value!==value.trim()||Buffer.byteLength(value)>max)throw new Error(`Invalid Scenario ${name}`);}
function boundedJson(value:unknown,max:number,name:string){let encoded:string;try{encoded=canonicalJson(value);if(typeof encoded!=="string")throw new Error();JSON.parse(encoded);}catch{throw new Error(`${name} must be JSON-compatible`);}
  if(Buffer.byteLength(encoded)>max)throw new Error(`${name} exceeds ${max} bytes`);return encoded;}
function digest(value:unknown){return createHash("sha256").update(canonicalJson(value)).digest("hex");}
function positiveLimit(value:number,name:string){if(!Number.isSafeInteger(value)||value<1)throw new Error(`Scenario ${name} capacity must be positive`);return value;}
