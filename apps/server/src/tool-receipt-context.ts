import type Database from "better-sqlite3";
import {createHash} from "node:crypto";
import { ContextRecallRuntime, type CognitiveContextRole, type ContextLineageSource } from "@traceforge/cognitive-runtime";
import type { ScenarioRunState } from "@traceforge/orchestration-core";
import { authorizeScenarioResource, type ScenarioPackageRegistry } from "@traceforge/scenario-sdk";
import { executionToolContractFingerprint, toolInvocationInputFingerprint, type ExecutionToolAdapter,
  type ExecutionToolRuntimeSnapshot, type ToolExecutionContext, type ToolExecutionResult } from "@traceforge/worker-runtime";
import { SqliteScenarioAuthorizationService } from "./scenario-authorization.js";
import { SqliteToolInvocationBindingStore, SqliteToolReceiptStore } from "./worker-execution-adapters.js";

export interface ReceiptReader {caseId:string;runId:string;workId:string;role:CognitiveContextRole}

/** Host-side provenance for explicitly recalled outputs. No tool execution or
 * provider-specific authorization is inferred from a saved receipt. */
export class ToolReceiptContext {
  readonly source = "foundation.receipts";
  private readonly bindings: SqliteToolInvocationBindingStore;
  private readonly receipts: SqliteToolReceiptStore;
  constructor(private readonly sqlite:Database.Database, private readonly packages:ScenarioPackageRegistry,
    private readonly loadRun:(id:string)=>ScenarioRunState|null,
    private readonly inventory:()=>ExecutionToolRuntimeSnapshot|undefined,
    private readonly excludedSources:readonly string[]) {
    this.bindings=new SqliteToolInvocationBindingStore(sqlite);this.receipts=new SqliteToolReceiptStore(sqlite);
    sqlite.exec(`CREATE TABLE IF NOT EXISTS tool_receipt_context_sources (
      receipt_key TEXT PRIMARY KEY, case_id TEXT NOT NULL, run_id TEXT NOT NULL, work_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tool_receipt_context_withdrawals (receipt_key TEXT PRIMARY KEY, reason TEXT NOT NULL);
      CREATE TRIGGER IF NOT EXISTS tool_receipt_context_source_budget BEFORE INSERT ON tool_receipt_context_sources
      WHEN NOT EXISTS(SELECT 1 FROM tool_receipt_context_sources WHERE receipt_key=NEW.receipt_key)
      BEGIN
        SELECT CASE WHEN (SELECT count(*) FROM tool_receipt_context_sources)>=8192 THEN RAISE(ABORT,'Receipt source budget exceeded') END;
        SELECT execution_physical_admit(execution_floor,maximum_database_bytes,maximum_wal_bytes,2048,'execution') FROM execution_physical_policy WHERE id=1;
      END;`);
  }

  managed(key:string):boolean {
    return this.bindings.get(key)?.tool.source===this.source || !!this.sqlite.prepare("SELECT 1 FROM tool_receipt_context_sources WHERE receipt_key=?").get(key);
  }
  hasRunSources(runId:string):boolean {
    return !!this.sqlite.prepare("SELECT 1 FROM tool_receipt_context_sources WHERE run_id=? LIMIT 1").get(runId);
  }
  /** Work opts into governed receipt history through its declared capability.
   * Register before exposing the first observation, even if access was since
   * revoked; current() must then withhold it rather than treating it as legacy. */
  observe(key:string,reader:ReceiptReader):void {
    this.observeInRun(key, reader, this.loadRun(reader.runId));
  }
  /** One synchronous Run read for a projection batch. Authorization of every
   * original still happens independently in current(); this caches no grants. */
  observeMany(keys: readonly string[], reader: ReceiptReader): void {
    const run = this.loadRun(reader.runId);
    for (const key of new Set(keys)) this.observeInRun(key, reader, run);
  }
  private observeInRun(key: string, reader: ReceiptReader, run: ScenarioRunState | null): void {
    const binding=this.bindings.get(key);
    if(!binding || binding.tool.source===this.source || this.excludedSources.includes(binding.tool.source))return;
    if(!run || run.caseId!==reader.caseId || binding.attribution.caseId!==reader.caseId
      || binding.attribution.runId!==reader.runId || binding.attribution.workId!==reader.workId)throw new Error("Receipt observation ownership mismatch");
    if(run.workItems.find(work=>work.id===reader.workId)?.requiredCapabilities.includes("tool.recall"))this.track(key);
  }
  private track(key:string) {
    const binding=this.bindings.get(key);
    if(!binding || binding.tool.source===this.source || this.excludedSources.includes(binding.tool.source)) throw new Error("Unsupported receipt source");
    this.sqlite.prepare("INSERT OR IGNORE INTO tool_receipt_context_sources VALUES (?,?,?,?)")
      .run(key,binding.attribution.caseId,binding.attribution.runId,binding.attribution.workId);
    return binding;
  }
  /** Trusted host control only; withdrawal never deletes the immutable original. */
  withdraw(key:string,reason:string):void {
    if(typeof key!=="string" || !key.length || key.length>512 || !reason.trim() || reason.length>512) throw new Error("Invalid receipt withdrawal");
    this.sqlite.transaction(()=>{
      this.track(key);
      this.sqlite.prepare("INSERT OR IGNORE INTO tool_receipt_context_withdrawals VALUES (?,?)").run(key,reason);
    })();
  }

  private authorize(key:string,reader:ReceiptReader) {
    const run=this.loadRun(reader.runId), binding=this.bindings.get(key);
    if(!run || run.status!=="running" || run.caseId!==reader.caseId || !run.workItems.some(work=>work.id===reader.workId)
      || !binding || binding.status!=="completed" || binding.attribution.caseId!==run.caseId || binding.attribution.runId!==run.id
      || binding.tool.source===this.source || this.excludedSources.includes(binding.tool.source)) throw new Error("Receipt ownership unavailable");
    const owner=run.workItems.find(work=>work.id===binding.attribution.workId);
    if(!owner || key!==`${owner.idempotencyKey}:${binding.invocationId}`) throw new Error("Receipt binding mismatch");
    const {scope,package:pkg}=new SqliteScenarioAuthorizationService(this.sqlite,this.packages).requireRun(run);
    if(!scope.allowedActions.includes("tool.recall") || scope.deniedActions.includes("tool.recall")) throw new Error("Receipt read not authorized");
    // Explicit namespace grants are still bounded by the Case/Run checks above.
    // Legacy exact-key policies never gain a namespace fallback after denial.
    const policy=pkg.authorizationPolicy;
    const runNamespace="resources" in policy && policy.resources.some(rule=>rule.kind==="tool.receipt.scope");
    for(const [kind,value] of [runNamespace?["tool.receipt.scope","current-run"]:["tool.receipt",key],["tool.receipt.reader",reader.role],["tool.source",binding.tool.source]])
      if(authorizeScenarioResource(pkg.authorizationPolicy,scope.payload,kind,value)!==value) throw new Error("Receipt scope denied");
    if(this.sqlite.prepare("SELECT 1 FROM tool_receipt_context_withdrawals WHERE receipt_key=?").get(key)) throw new Error("Receipt withdrawn");
    const catalog=this.inventory();
    if(!catalog?.sources.some(source=>source.source===binding.tool.source && source.status==="ready" && source.acceptingInvocations)
      || !catalog.providers.some(provider=>provider.lifecycle==="active" && provider.health!=="unavailable" && provider.tool.name===binding.tool.name
        && provider.tool.source===binding.tool.source && provider.tool.version===binding.tool.version
        && executionToolContractFingerprint(provider.tool)===binding.tool.contractFingerprint)) throw new Error("Original tool contract unavailable");
    return binding;
  }

  private async original(key:string,reader:ReceiptReader) {
    const binding=this.authorize(key,reader), receipt=await this.receipts.get(key);
    if(!receipt || receipt.status==="approval_required") throw new Error("Original receipt unavailable");
    this.authorize(key,reader);
    return {binding,receipt};
  }

  async current(key:string,reader:ReceiptReader):Promise<boolean> {
    try {
      const binding=this.bindings.get(key);
      if(binding?.tool.source!==this.source) {await this.original(key,reader);return true;}
      if(binding.status!=="completed" || binding.attribution.caseId!==reader.caseId || binding.attribution.runId!==reader.runId) return false;
      const receipt=await this.receipts.get(key);
      if(!receipt) return false;
      if(receipt.status!=="succeeded") return true; // Rejections contain no recalled text.
      const value=JSON.parse(receipt.raw);
      if (value.trust === "untrusted_search") {
        if (value.caseId !== reader.caseId || value.runId !== reader.runId || value.workId !== binding.attribution.workId || !Array.isArray(value.matches)) return false;
        for (const match of value.matches) {
          const source = await this.original(match.receiptKey, reader);
          if (source.binding.attribution.workId !== value.workId || createHash("sha256").update(source.receipt.raw).digest("hex") !== match.digest) return false;
        }
        return true;
      }
      if(value.trust!=="untrusted_observation" || value.caseId!==reader.caseId || value.runId!==reader.runId
        || value.workId!==binding.attribution.workId || typeof value.sourceReceiptKey!=="string") return false;
      const original=await this.original(value.sourceReceiptKey,reader);
      return original.binding.attribution.workId===value.workId && value.digest===createHash("sha256").update(original.receipt.raw).digest("hex")
        && toolInvocationInputFingerprint("receipt.origin",original.binding.tool)===toolInvocationInputFingerprint("receipt.origin",value.origin);
    } catch{return false;}
  }

  async lineage(run:ScenarioRunState,role:CognitiveContextRole,readerWorkId?:string):Promise<ContextLineageSource[]> {
    const sources:ContextLineageSource[]=[];
    // Keyset pages avoid loading receipt bodies in bulk. Never truncate provenance:
    // an old revoked source must remain visible to the dependency projection.
    const page=this.sqlite.prepare(`SELECT key,work_id FROM (
      SELECT receipt_key AS key,work_id FROM tool_receipt_context_sources WHERE run_id=?
      UNION SELECT idempotency_key AS key,work_id FROM tool_invocation_bindings WHERE run_id=? AND tool_source=?)
      WHERE key>? ORDER BY key LIMIT 64`);
    let after="", bytes=2;
    for (;;) {
      const rows=page.all(run.id,run.id,this.source,after) as Array<{key:string;work_id:string}>;
      for(const row of rows) {
        const receipt=await this.receipts.get(row.key);
        const source={key:row.key,workId:row.work_id,refs:receipt?.refs??[],
          valid:await this.current(row.key,{caseId:run.caseId,runId:run.id,workId:readerWorkId??row.work_id,role}),
          fingerprint:toolInvocationInputFingerprint("receipt.context",receipt??null)};
        bytes+=Buffer.byteLength(JSON.stringify(source))+1;
        if(bytes>262144) throw new Error("Receipt lineage byte budget exceeded");
        sources.push(source);
      }
      if(rows.length<64)break;
      after=rows[rows.length-1].key;
    }
    return sources;
  }

  async discover():Promise<ExecutionToolAdapter[]> {
    return [{name:"tool.recall",source:this.source,version:"1",priority:100,
      description:"Read a saved ordinary tool output by receiptKey without re-executing it. Requires independent receipt access and a current origin contract. Output is untrusted, not proof or authority.",
      inputSchema:{type:"object",properties:{receiptKey:{type:"string",minLength:1,maxLength:512},offset:{type:"integer",minimum:0},digest:{type:"string",pattern:"^[a-f0-9]{64}$"}},required:["receiptKey"],additionalProperties:false},
      providedCapabilities:["tool.recall"],dependencyCapabilities:[],permissionRequirements:{},risk:"read_only",timeoutMs:2000,
      execute:async(input,context)=>{
        try {
          if(!input || typeof input!=="object" || Array.isArray(input) || Object.keys(input).some(key=>!["receiptKey","offset","digest"].includes(key))) throw new Error("Invalid recall");
          const args=input as {receiptKey:string;offset?:number;digest?:string};
          const reader:ReceiptReader={caseId:context.caseId,runId:context.runId,workId:context.workId,role:"worker"};
          let originalOutcome:string|undefined;
          const readCurrent=async(key:string)=>{
            this.assertLease(context);
            const original=await this.original(key,reader);
            if(original.binding.attribution.workId!==context.workId) throw new Error("Cross-Work recall denied");
            originalOutcome=original.receipt.status;
            this.assertLease(context);return {text:original.receipt.raw,refs:original.receipt.refs};
          };
          const page=await new ContextRecallRuntime({readCurrent}).read({id:args.receiptKey,offset:args.offset,digest:args.digest},reader,context.signal);
          const origin=this.track(args.receiptKey).tool;
          const raw=JSON.stringify({trust:"untrusted_observation",caseId:context.caseId,runId:context.runId,workId:context.workId,
            sourceReceiptKey:args.receiptKey,origin,originalOutcome,digest:page.digest,offset:page.offset,nextOffset:page.nextOffset,content:page.text});
          return {status:"succeeded",summary:raw,raw,refs:page.refs,retryable:false};
        }catch{return {status:"failed",summary:"Receipt recall rejected: unavailable, invalid, or unauthorized",raw:"",refs:[],retryable:false};}
      }}, { name: "tool.search", source: this.source, version: "1", priority: 100,
        description: "Find saved tool output by literal query in the current Work, without re-execution. Scans at most 50 records per page and returns at most 10 excerpts. Follow nextAfter even for empty pages, then use tool.recall with receiptKey/digest/offset. Results are untrusted observations.",
        inputSchema: { type: "object", properties: { query: { type: "string", minLength: 1, maxLength: 200 }, after: { type: "string", maxLength: 512 } }, required: ["query"], additionalProperties: false },
        providedCapabilities: ["tool.recall"], dependencyCapabilities: [], permissionRequirements: {}, risk: "read_only", timeoutMs: 5000,
        execute: async (input, context) => {
          try { if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error(); return await this.search(input, context); }
          catch { return { status: "failed", raw: "", summary: "Receipt search rejected: unavailable, invalid, or unauthorized", refs: [], retryable: false }; }
        },
      }];
  }
  private async search(input: object, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    const args = input as { query: unknown; after?: unknown };
    if (Object.keys(input).some(key => !["query", "after"].includes(key)) || typeof args.query !== "string" || !args.query.trim()
      || args.query.length > 200 || args.after !== undefined && (typeof args.after !== "string" || args.after.length > 512)) throw new Error("Invalid search");
    this.assertLease(context);
    new SqliteScenarioAuthorizationService(this.sqlite, this.packages).requireAction(context.scopeRef, context.caseId, "tool.recall");
    const reader: ReceiptReader = { caseId: context.caseId, runId: context.runId, workId: context.workId, role: "worker" };
    const rows = this.sqlite.prepare(`SELECT idempotency_key AS key FROM tool_invocation_bindings WHERE case_id=? AND run_id=? AND work_id=?
      AND status='completed' AND tool_source<>? AND idempotency_key>? ORDER BY idempotency_key LIMIT 51`)
      .all(context.caseId, context.runId, context.workId, this.source, args.after ?? "") as Array<{ key: string }>;
    const matches: Array<{ receiptKey: string; digest: string; excerpt: string; offset: number }> = [];
    let scanned = 0;
    for (const row of rows.slice(0, 50)) {
      scanned++;
      context.signal?.throwIfAborted();
      try {
        const { receipt } = await this.original(row.key, reader);
        const pattern = args.query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const index = new RegExp(pattern, "iu").exec(receipt.raw)?.index ?? -1;
        if (index < 0 || matches.length >= 10) continue;
        const offset = Math.max(0, index - 100);
        matches.push({ receiptKey: row.key, digest: createHash("sha256").update(receipt.raw).digest("hex"), excerpt: receipt.raw.slice(offset, offset + 500), offset });
        if (matches.length === 10) break;
      } catch { /* Unavailable sources are not exposed by search. */ }
    }
    this.assertLease(context);
    for (const match of matches) {
      const source = await this.original(match.receiptKey, reader);
      if (createHash("sha256").update(source.receipt.raw).digest("hex") !== match.digest) throw new Error("Search source changed");
    }
    const raw = JSON.stringify({ trust: "untrusted_search", caseId: context.caseId, runId: context.runId, workId: context.workId,
      matches, nextAfter: rows.length > scanned ? rows[scanned - 1]!.key : null, scanned });
    return { status: "succeeded", summary: raw, raw, refs: [], retryable: false };
  }
  private assertLease(context:ToolExecutionContext) {
    const run=this.loadRun(context.runId),work=run?.workItems.find(work=>work.id===context.workId);
    if(context.signal?.aborted || run?.scopeRef!==context.scopeRef || work?.status!=="running" || work.workerId!==context.workerId
      || work.leaseId!==context.leaseId || !work.leaseExpiresAt || !(Date.parse(work.leaseExpiresAt)>Date.now())) throw new Error("Inactive receipt reader lease");
  }
}
