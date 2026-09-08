import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { DesktopMcpOperationSchema, type DesktopMcpSnapshot, type McpConnection, type McpCatalog } from "@traceforge/shared/desktop-mcp";
import { authorizeScenarioResource, type ScenarioPackageRegistry } from "@traceforge/scenario-sdk";
import { canonicalJson, type ScenarioRunState } from "@traceforge/orchestration-core";
import type { BrokeredHttpTransport, ExecutionAttribution, ExecutionNode } from "@traceforge/execution-node";
import type { ExecutionToolDiscoveryRuntime, ExecutionToolDiscoverySource, ToolExecutionContext } from "@traceforge/worker-runtime";
import { SqliteScenarioAuthorizationService } from "./scenario-authorization.js";
import { DesktopMcpSession, mcpDigest } from "./desktop-mcp-session.js";
import { parseMcpInputPolicy, authorizeMcpPolicyInput, type McpInputPolicy } from "./mcp-input-policy.js";
import { DesktopMcpStdioSession } from "./desktop-mcp-stdio.js";
import type { ProcessExecutionCapacity } from "./process-execution-capacity.js";

export interface DesktopMcpSecretStore { read(ref: string): Promise<string | undefined>; write(ref: string, value: string): Promise<void>; }
export interface DesktopMcpOptions { secrets?: DesktopMcpSecretStore; transport?: BrokeredHttpTransport }
type Review = Extract<ReturnType<typeof DesktopMcpOperationSchema.parse>, { operation: "activate" }>["tools"];
interface Version { connection: McpConnection; credentialRef?: string }
interface Activation { catalog: McpCatalog; tools: Review }
type Head = { id: string; revision: number; active: number | null; deleted: number };
const sourceName = (id: string, revision: number) => `desktop.mcp.${id}.r${revision}`;

/** Operator-managed endpoint grants. All calls still pass the existing Tool Gateway and Run scope. */
export class DesktopMcpControl {
  private runtime?: ExecutionToolDiscoveryRuntime;
  private locked = false;
  private readonly calls=new Map<string,Set<AbortController>>();
  private reconcile: () => void = () => undefined;
  private assertAssembly: (id: string,digest: string) => void = () => {throw new Error("MCP assembly unavailable");};
  constructor(private readonly sqlite: Database.Database, private readonly packages: ScenarioPackageRegistry,
    private readonly loadRun: (id: string) => ScenarioRunState | null, private readonly options: DesktopMcpOptions = {},
    private readonly node?:ExecutionNode,private readonly capacity?:ProcessExecutionCapacity) {
    sqlite.exec(`CREATE TABLE IF NOT EXISTS desktop_mcp_heads(id TEXT PRIMARY KEY,revision INTEGER NOT NULL,active INTEGER,deleted INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS desktop_mcp_versions(id TEXT NOT NULL,revision INTEGER NOT NULL,value_json TEXT NOT NULL,PRIMARY KEY(id,revision));
      CREATE TABLE IF NOT EXISTS desktop_mcp_tests(id TEXT NOT NULL,revision INTEGER NOT NULL,catalog_json TEXT NOT NULL,PRIMARY KEY(id,revision));
      CREATE TABLE IF NOT EXISTS desktop_mcp_activations(id TEXT NOT NULL,revision INTEGER NOT NULL,value_json TEXT NOT NULL,PRIMARY KEY(id,revision));
      CREATE TABLE IF NOT EXISTS desktop_mcp_runs(run_id TEXT NOT NULL,id TEXT NOT NULL,revision INTEGER NOT NULL,PRIMARY KEY(run_id,id));
      CREATE TRIGGER IF NOT EXISTS desktop_mcp_pin AFTER INSERT ON scenario_event_streams BEGIN
        INSERT INTO desktop_mcp_runs SELECT NEW.run_id,h.id,h.active FROM desktop_mcp_heads h JOIN desktop_mcp_versions v ON v.id=h.id AND v.revision=h.active
        WHERE h.deleted=0 AND h.active IS NOT NULL AND json_extract(v.value_json,'$.connection.package.id')=NEW.scenario_package_id
        AND json_extract(v.value_json,'$.connection.package.version')=NEW.scenario_package_version
        AND json_extract(v.value_json,'$.connection.package.schemaRevision')=NEW.scenario_schema_revision; END;`);
    for (const table of ["desktop_mcp_versions", "desktop_mcp_activations", "desktop_mcp_runs"]) {
      for (const op of ["UPDATE", "DELETE"]) sqlite.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_${op} BEFORE ${op} ON ${table} BEGIN SELECT RAISE(ABORT,'MCP history is immutable'); END;`);
      sqlite.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_capacity BEFORE INSERT ON ${table} BEGIN
        SELECT CASE WHEN (SELECT count(*) FROM ${table})>=8192 THEN RAISE(ABORT,'MCP history capacity exceeded') END;
        SELECT execution_physical_admit(execution_floor,maximum_database_bytes,maximum_wal_bytes,262144,'execution') FROM execution_physical_policy WHERE id=1; END;`);
    }
  }
  private head(id: string): Head | undefined { return this.sqlite.prepare("SELECT * FROM desktop_mcp_heads WHERE id=?").get(id) as Head | undefined; }
  private version(id: string, revision: number): Version { const row = this.sqlite.prepare("SELECT value_json FROM desktop_mcp_versions WHERE id=? AND revision=?").get(id, revision) as { value_json: string } | undefined; if (!row) throw new Error("MCP revision unavailable"); return JSON.parse(row.value_json); }
  private activation(id: string, revision: number): Activation { const row = this.sqlite.prepare("SELECT value_json FROM desktop_mcp_activations WHERE id=? AND revision=?").get(id, revision) as { value_json: string } | undefined; if (!row) throw new Error("MCP revision not reviewed"); return JSON.parse(row.value_json); }
  private pkg(connection: McpConnection) {
    const pkg = this.packages.list().find(p => canonicalJson(this.packages.bindingFor(p)) === canonicalJson(connection.package));
    if (!pkg) throw new Error("MCP package unavailable"); this.packages.assertAvailable(pkg);
    if (!pkg.definition.authorizationActions.includes(connection.authorizationAction)
      || !pkg.definition.agentTopology?.workerPools.some(p => p.capabilities.includes(connection.capability))) throw new Error("MCP action or capability is not declared by the package");
    return pkg;
  }
  snapshot(): DesktopMcpSnapshot {
    const heads = this.sqlite.prepare("SELECT * FROM desktop_mcp_heads WHERE deleted=0 ORDER BY id").all() as Head[];
    return { secureStorage: !!this.options.secrets, connections: heads.map(h => {
      const v = this.version(h.id, h.revision), row = this.sqlite.prepare("SELECT catalog_json FROM desktop_mcp_tests WHERE id=? AND revision=?").get(h.id, h.revision) as { catalog_json: string } | undefined;
      let reviewedTools: Review = []; try { reviewedTools = this.activation(h.id, h.revision).tools; } catch {}
      return { connection: v.connection, revision: h.revision, enabled: h.active !== null, credentialConfigured: !!v.credentialRef, catalog: row ? JSON.parse(row.catalog_json) : null, reviewedTools,
        ...(h.active === null ? {} : {effective:{revision:h.active,connection:this.version(h.id,h.active).connection,tools:this.activation(h.id,h.active).tools}}) };
    }), packages: this.packages.list().map(p => ({ package: this.packages.bindingFor(p), title: p.definition.title, actions: p.definition.authorizationActions,
      capabilities: [...new Set(p.definition.agentTopology?.workerPools.flatMap(p => p.capabilities) ?? [])],
      resourceKinds: "resources" in p.authorizationPolicy ? p.authorizationPolicy.resources.map(r => r.kind) : [] })) };
  }
  /** Includes retained revisions for old Runs; the Run pin controls which revision can be invoked. */
  sources(): ExecutionToolDiscoverySource[] {
    return (this.sqlite.prepare("SELECT a.id,a.revision FROM desktop_mcp_activations a JOIN desktop_mcp_heads h ON h.id=a.id WHERE h.deleted=0 AND h.active IS NOT NULL").all() as Array<{id:string;revision:number}>).map(r => this.source(r.id, r.revision));
  }
  assemblyUnits() { return this.sources().map(s => { const match = /^(.*)\.r([0-9]+)$/.exec(s.source)!; const id = match[1]!.slice("desktop.mcp.".length), revision = Number(match[2]); return { id: s.source, digest: mcpDigest({ version: this.version(id, revision), activation: this.activation(id, revision) }) }; }); }
  attach(runtime: ExecutionToolDiscoveryRuntime, reconcile: () => void, assertAssembly:(id:string,digest:string)=>void) { this.runtime = runtime; this.reconcile = reconcile;this.assertAssembly=assertAssembly; }
  allowed(runId: string, source: string): boolean {
    if (!source.startsWith("desktop.mcp.")) return true;
    return (this.sqlite.prepare("SELECT p.id,p.revision FROM desktop_mcp_runs p JOIN desktop_mcp_heads h ON h.id=p.id WHERE p.run_id=? AND h.deleted=0 AND h.active IS NOT NULL").all(runId) as Array<{id:string;revision:number}>).some(r => sourceName(r.id,r.revision) === source);
  }
  async operate(value: unknown): Promise<DesktopMcpSnapshot> {
    const op = DesktopMcpOperationSchema.parse(value); if (this.locked) throw new Error("MCP configuration is busy"); this.locked = true;
    try {
      const id = op.operation === "save" ? op.connection.id : op.id, head = this.head(id);
      if ((head?.revision ?? 0) !== op.expectedRevision || head?.deleted) throw new Error("MCP configuration changed; reload");
      if (op.operation === "save") {
        if(op.credential && op.clearCredential)throw new Error("Cannot replace and clear a credential together");
        this.pkg(op.connection);
        if (!head && (this.sqlite.prepare("SELECT count(*) AS n FROM desktop_mcp_heads").get() as {n:number}).n >= 128) throw new Error("MCP connection capacity reached");
        const revision = op.expectedRevision + 1;
        let credentialRef = head ? this.version(id, head.revision).credentialRef : undefined;
        if (op.clearCredential) credentialRef = undefined;
        if (op.credential) { if (!this.options.secrets) throw new Error("OS secure storage unavailable"); if (op.connection.transport!=="streamable-http" || new URL(op.connection.endpoint).protocol !== "https:") throw new Error("Credentials require HTTPS");
          credentialRef = `mcp:${id}:${revision}:${randomUUID()}`; await this.options.secrets.write(credentialRef, op.credential); }
        if (credentialRef && (op.connection.transport!=="streamable-http" || new URL(op.connection.endpoint).protocol !== "https:")) throw new Error("Credentials require HTTPS");
        if (head && this.version(id,head.revision).connection.endpoint !== op.connection.endpoint && credentialRef && !op.credential && !op.clearCredential) throw new Error("Confirm a new credential or clear it when changing endpoint");
        this.sqlite.transaction(() => { this.sqlite.prepare("INSERT INTO desktop_mcp_versions VALUES (?,?,?)").run(id,revision,JSON.stringify({ connection:op.connection, credentialRef }));
          this.sqlite.prepare("INSERT INTO desktop_mcp_heads(id,revision,active) VALUES (?,?,NULL) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision").run(id,revision); })();
      } else {
        if (!head) throw new Error("MCP connection not found");
        const v = this.version(id,head.revision);
        if (op.operation === "test" || op.operation === "activate") this.pkg(v.connection);
        if (op.operation === "test") {
          const session = await this.session(v, this.serviceAttribution(id), () => { if (this.head(id)?.revision !== head.revision) throw new Error("MCP configuration changed"); });
          try{const catalog = await session.discover();
          this.sqlite.prepare("INSERT INTO desktop_mcp_tests VALUES (?,?,?) ON CONFLICT(id,revision) DO UPDATE SET catalog_json=excluded.catalog_json").run(id,head.revision,JSON.stringify(catalog));}finally{await session.close();}
        } else if (op.operation === "activate") {
          if (!this.runtime) throw new Error("MCP runtime unavailable");
          const row = this.sqlite.prepare("SELECT catalog_json FROM desktop_mcp_tests WHERE id=? AND revision=?").get(id,head.revision) as {catalog_json:string} | undefined;
          const catalog: McpCatalog = row ? JSON.parse(row.catalog_json) : null;
          if (!catalog || catalog.digest !== op.catalogDigest || new Set(op.tools.map(t=>t.name)).size !== op.tools.length) throw new Error("Test and review this exact MCP revision first");
          if (!op.tools.some(t=>t.enabled)) throw new Error("Select at least one MCP tool");
          for (const review of op.tools) { const tool = catalog.tools.find(t=>t.name===review.name); if (!tool) throw new Error("Unknown MCP tool"); if (review.enabled) this.inputPolicy(tool.inputSchema, review.resources); }
          const activation = { catalog,tools:op.tools }, prior = this.sqlite.prepare("SELECT value_json FROM desktop_mcp_activations WHERE id=? AND revision=?").get(id,head.revision) as {value_json:string}|undefined;
          if (prior && canonicalJson(JSON.parse(prior.value_json)) !== canonicalJson(activation)) throw new Error("Save a new revision before changing an approved tool review");
          this.sqlite.transaction(() => { if (!prior) this.sqlite.prepare("INSERT INTO desktop_mcp_activations VALUES (?,?,?)").run(id,head.revision,JSON.stringify(activation)); this.sqlite.prepare("UPDATE desktop_mcp_heads SET active=? WHERE id=?").run(head.revision,id); })();
          try { this.reconcile(); await this.runtime.activateSource(this.source(id,head.revision)); }
          catch (error) { this.sqlite.prepare("UPDATE desktop_mcp_heads SET active=NULL WHERE id=?").run(id); this.reconcile(); throw error; }
        } else {
          this.sqlite.prepare("UPDATE desktop_mcp_heads SET active=NULL,deleted=? WHERE id=?").run(op.operation === "delete" ? 1 : 0,id); this.reconcile();
          for(const controller of this.calls.get(id)??[])controller.abort();
          for (const row of this.sqlite.prepare("SELECT revision FROM desktop_mcp_activations WHERE id=?").all(id) as Array<{revision:number}>) await this.runtime?.deactivateSource(sourceName(id,row.revision));
        }
      }
      return this.snapshot();
    } finally { this.locked = false; }
  }
  private serviceAttribution(id: string): ExecutionAttribution { return { caseId:"desktop-mcp",runId:"desktop-mcp",workId:"discovery",workerId:"operator",scopeRef:id,leaseId:randomUUID(),leaseExpiresAt:new Date(Date.now()+60000).toISOString(),actionId:"mcp.discovery",idempotencyKey:randomUUID() }; }
  private async session(v: Version, attribution: ExecutionAttribution, check: () => void, signal?: AbortSignal) {
    if(v.connection.transport==="stdio") {
      if(!this.node||!this.capacity||v.credentialRef)throw new Error("Controlled stdio execution unavailable");
      return new DesktopMcpStdioSession(v.connection,this.node,this.capacity,attribution,check,signal);
    }
    const credential = v.credentialRef ? await this.options.secrets?.read(v.credentialRef) : undefined;
    if (v.credentialRef && !credential) throw new Error("MCP credential unavailable");
    return new DesktopMcpSession(v.connection,credential,attribution,check,this.options.transport,signal);
  }
  private inputPolicy(schema: Record<string,any>, resources: Review[number]["resources"]): McpInputPolicy {
    if (Object.keys(schema).some(k=>!["type","properties","required","additionalProperties","description","title","$schema"].includes(k)) || schema.additionalProperties !== undefined && schema.additionalProperties !== false) throw new Error("Tool requires a closed, flat input schema for this adapter");
    const fields: McpInputPolicy["fields"] = {};
    if (!schema.properties || typeof schema.properties !== "object" || Array.isArray(schema.properties) || !Array.isArray(schema.required ?? [])) throw new Error("Unsupported MCP input schema");
    for (const [name, raw] of Object.entries(schema.properties) as Array<[string,Record<string,any>]>) {
      if (!raw || typeof raw !== "object" || Object.keys(raw).some(k=>!["type","description","title","enum","items"].includes(k))) throw new Error("Tool input constraints require another adapter");
      const type = raw.type === "array" && raw.items?.type === "string" && Object.keys(raw.items).every(k=>k==="type") ? "string_list" : raw.type;
      fields[name] = { type, required: (schema.required ?? []).includes(name), ...(raw.enum ? {values:raw.enum} : {}) };
    }
    if ((schema.required ?? []).some((name: string)=>!Object.hasOwn(fields,name))) throw new Error("Unknown required input field");
    return parseMcpInputPolicy({version:1,fields,resources});
  }
  private source(id: string, revision: number): ExecutionToolDiscoverySource {
    const v = this.version(id,revision), activation = this.activation(id,revision), source = sourceName(id,revision);
    return { source, discover: async () => activation.tools.filter(t=>t.enabled).map(review => {
      const remote = activation.catalog.tools.find(t=>t.name===review.name)!;
      const inputPolicy = this.inputPolicy(remote.inputSchema,review.resources);
      return { name:`${source}.${activation.catalog.tools.indexOf(remote)}`,source,version:activation.catalog.digest,priority:0,
        description:`Reviewed MCP tool: ${remote.name}`,inputSchema:remote.inputSchema,providedCapabilities:[v.connection.capability],dependencyCapabilities:[],
        permissionRequirements:v.connection.transport==="stdio"?{}:{network:"brokered" as const},risk:"privileged" as const,timeoutMs:60000,
        execute: async (input: unknown,context: ToolExecutionContext) => {
          const check = () => {
            this.assertAssembly(source,mcpDigest({version:v,activation}));
            if (!this.allowed(context.runId,source)) throw new Error("MCP revision is not enabled for this Run");
            const run = this.loadRun(context.runId),work = run?.workItems.find(w=>w.id===context.workId);
            if (!run || run.status!=="running" || run.caseId!==context.caseId || run.scopeRef!==context.scopeRef || !work || work.status!=="running"
              || work.workerId!==context.workerId || work.leaseId!==context.leaseId || !(Date.parse(work.leaseExpiresAt ?? "")>Date.now()) || canonicalJson(run.scenarioPackage)!==canonicalJson(v.connection.package)) throw new Error("MCP Work is not active");
            const {scope,package:pkg} = new SqliteScenarioAuthorizationService(this.sqlite,this.packages).requireRun(run);
            if (!scope.allowedActions.includes(v.connection.authorizationAction) || scope.deniedActions.includes(v.connection.authorizationAction)) throw new Error("MCP action outside Run scope");
            authorizeMcpPolicyInput(inputPolicy,input,(kind,value)=>authorizeScenarioResource(pkg.authorizationPolicy,scope.payload,kind,value));
          };
          check();
          if([...this.calls.values()].reduce((n,set)=>n+set.size,0)>=16)throw new Error("MCP concurrent call capacity reached");
          const controller=new AbortController(),set=this.calls.get(id)??new Set<AbortController>();set.add(controller);this.calls.set(id,set);
          try {
          const session = await this.session(v,{...context,actionId:v.connection.authorizationAction},check,AbortSignal.any([controller.signal,...(context.signal?[context.signal]:[])]));
          try {
          const catalog = await session.discover(); if (catalog.digest!==activation.catalog.digest) throw new Error("MCP catalog changed; test and review a new revision");
          check(); const result = await session.rpc("tools/call",{name:remote.name,arguments:input}); check();
          if (!result || !Array.isArray(result.content) || result.content.some((c:any)=>c.type!=="text" || typeof c.text!=="string")) throw new Error("MCP response must contain text only");
          const raw = result.content.map((c:{text:string})=>c.text).join("\n");
          if (Buffer.byteLength(raw)>65536) throw new Error("MCP tool output exceeds limit");
          return {status:result.isError?"failed" as const:"succeeded" as const,summary:"MCP returned an untrusted tool observation",raw,refs:[],retryable:false,
            metadata:{mcp:{source,revision,catalogDigest:catalog.digest,networkReceipts:session.receipts}}};
          }finally{await session.close();}
          } finally {set.delete(controller);if(!set.size)this.calls.delete(id);}
        } };
    }) };
  }
}

export function registerDesktopMcpRoutes(app: FastifyInstance, control: DesktopMcpControl) {
  app.get("/api/desktop/mcp",async()=>control.snapshot());
  app.post("/api/desktop/mcp",{bodyLimit:128*1024},async(request,reply)=>{ try {return await control.operate(request.body);} catch {return reply.code(409).send({error:"MCP 操作未完成。请检查修订、HTTPS 凭证、场景授权及工具输入契约；保存不会自动启用。"});} });
}
