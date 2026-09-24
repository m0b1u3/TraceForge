import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import type { ScenarioPackageBinding } from "@traceforge/orchestration-core";
import type { ScenarioPackageRegistry, ScenarioPackageResource } from "@traceforge/scenario-sdk";
import { ConfigurationSaveSchema, ConfigurationImportSchema, renderGuidanceTemplate, type ConfigurationSave, type ConfigurationSnapshot, type ConfigurationImportPreview } from "@traceforge/shared/desktop-configuration";
import { contextContentDigest, type SqlitePackageContextStore } from "./package-context-resources.js";
import { mcpToolProfileDigest, type FoundationMcpServer } from "./mcp-execution-source.js";

const key = (binding: ScenarioPackageBinding) => JSON.stringify([binding.id, binding.version, binding.schemaRevision]);
type Saved = Pick<ConfigurationSave, "resources" | "mcp" | "userResources">;
const empty = (): Saved => ({ resources: [], mcp: [] });

/** User overlays are not signed package material or execution authority. */
export class DesktopConfigurationStore {
  constructor(private readonly sqlite: Database.Database, private readonly packages: ScenarioPackageRegistry,
    private readonly content: SqlitePackageContextStore, private readonly mcp: readonly FoundationMcpServer[] = []) {
    sqlite.exec(`CREATE TABLE IF NOT EXISTS desktop_configuration_versions (
      binding TEXT NOT NULL, revision INTEGER NOT NULL, value_json TEXT NOT NULL,
      PRIMARY KEY(binding,revision));
      CREATE TABLE IF NOT EXISTS desktop_configuration_runs (
      run_id TEXT PRIMARY KEY, binding TEXT NOT NULL, revision INTEGER NOT NULL);
      CREATE TRIGGER IF NOT EXISTS desktop_configuration_pin AFTER INSERT ON scenario_event_streams BEGIN
        INSERT INTO desktop_configuration_runs VALUES (NEW.run_id,
          json_array(NEW.scenario_package_id,NEW.scenario_package_version,NEW.scenario_schema_revision),
          coalesce((SELECT max(revision) FROM desktop_configuration_versions WHERE binding=
            json_array(NEW.scenario_package_id,NEW.scenario_package_version,NEW.scenario_schema_revision)),0));
      END;`);
    // Pre-feature Runs keep defaults, never today's user settings on first read.
    sqlite.exec(`INSERT OR IGNORE INTO desktop_configuration_runs SELECT run_id,
      json_array(scenario_package_id,scenario_package_version,scenario_schema_revision),0 FROM scenario_event_streams;`);
    for (const table of ["desktop_configuration_versions", "desktop_configuration_runs"]) {
      for (const operation of ["UPDATE", "DELETE"]) sqlite.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_${operation}
        BEFORE ${operation} ON ${table} BEGIN SELECT RAISE(ABORT,'Configuration history is immutable'); END;`);
    }
    sqlite.exec(`CREATE TRIGGER IF NOT EXISTS desktop_configuration_physical BEFORE INSERT ON desktop_configuration_versions BEGIN
      SELECT execution_physical_admit(execution_floor,maximum_database_bytes,maximum_wal_bytes,
        length(CAST(NEW.value_json AS BLOB))+2048,'execution') FROM execution_physical_policy WHERE id=1; END;`);
  }

  private latest(binding: ScenarioPackageBinding) {
    const row = this.sqlite.prepare("SELECT revision,value_json FROM desktop_configuration_versions WHERE binding=? ORDER BY revision DESC LIMIT 1")
      .get(key(binding)) as { revision: number; value_json: string } | undefined;
    return { revision: row?.revision ?? 0, value: row ? JSON.parse(row.value_json) as Saved : empty() };
  }

  private forRun(runId: string, binding: ScenarioPackageBinding): Saved {
    const pin = this.sqlite.prepare("SELECT binding,revision FROM desktop_configuration_runs WHERE run_id=?").get(runId) as { binding: string; revision: number } | undefined;
    if (!pin || pin.binding !== key(binding)) throw new Error("Run configuration binding unavailable; migration requires explicit configuration reconciliation");
    if (!pin.revision) return empty();
    const row = this.sqlite.prepare("SELECT value_json FROM desktop_configuration_versions WHERE binding=? AND revision=?").get(pin.binding, pin.revision) as { value_json: string } | undefined;
    if (!row) throw new Error("Pinned configuration unavailable");
    return JSON.parse(row.value_json) as Saved;
  }

  snapshot(): ConfigurationSnapshot {
    return { packages: this.packages.list().filter(pkg => this.packages.bindingStatus(this.packages.bindingFor(pkg), pkg.definition.kind, pkg.definition.version).status === "available").map(pkg => {
      const binding = this.packages.bindingFor(pkg), saved = this.latest(binding);
      return { package: binding, title: pkg.definition.title, revision: saved.revision, userResources: saved.value.userResources ?? [], inspection:this.inspection(binding),
        previousVersions:(this.sqlite.prepare("SELECT binding,max(revision) AS revision FROM desktop_configuration_versions WHERE json_extract(binding,'$[0]')=? AND binding<>? GROUP BY binding").all(binding.id,key(binding)) as Array<{binding:string;revision:number}>).map(row=>{const [id,version,schemaRevision]=JSON.parse(row.binding);return {package:{id,version,schemaRevision},revision:row.revision};}),
        resources: (pkg.resourceManifest?.resources ?? []).filter(r => r.context).map(r => {
          const override = saved.value.resources.find(item => item.id === r.id);
          let defaultContent = "", reason: string | undefined;
          try { if (r.context!.external) throw new Error(); defaultContent = this.content.read(binding, r); }
          catch { reason = "外部或不可用资源不能在此覆盖。"; }
          return { id: r.id, type: r.context!.type, summary: r.context!.summary, phases: r.context!.phaseIds,
            roles: r.context!.readerRoles ?? ["worker"], enabled: override?.enabled ?? true,
            content: override?.content ?? null, defaultContent, defaultDigest: r.digest, editable: !reason, ...(reason ? { reason } : {}) };
        }),
        mcp: this.mcp.filter(server => server.packages.some(p => key(p) === key(binding))).map(server => {
          const digest = mcpToolProfileDigest(server), choice = saved.value.mcp.find(item => item.source === server.source && item.profileDigest === digest);
          return { source: server.source, name: server.serverName, profileDigest: digest, enabled: choice?.enabled ?? true,
            tools: server.tools.map(tool => ({ name: tool.tool.name, enabled: choice ? choice.tools.includes(tool.tool.name) : true })) };
        }) };
    }) };
  }

  /** Read projection of the existing immutable revision ledger, not another source of truth. */
  private inspection(binding:ScenarioPackageBinding) {
    const versions=this.sqlite.prepare("SELECT revision,value_json FROM desktop_configuration_versions WHERE binding=? ORDER BY revision DESC LIMIT 21").all(key(binding)) as Array<{revision:number;value_json:string}>;
    const history=versions.slice(0,20).map((row,index)=>{
      const value=JSON.parse(row.value_json) as Saved,previous=versions[index+1]?JSON.parse(versions[index+1].value_json) as Saved:empty();
      const changes:string[]=[];
      for(const r of value.userResources??[]){
        const old=previous.userResources?.find(p=>p.id===r.id);
        if(JSON.stringify(old)!==JSON.stringify(r))changes.push(`${old?"更新":"添加"} ${r.title} · ${r.source?.kind==="file"?"来源文件："+r.source.name:"客户端编辑"}`);
      }
      for(const old of previous.userResources??[])if(!value.userResources?.some(r=>r.id===old.id))changes.push(`移除 ${old.title}`);
      if(JSON.stringify(value.resources)!==JSON.stringify(previous.resources))changes.push("调整场景资源启停或正文");
      if(JSON.stringify(value.mcp)!==JSON.stringify(previous.mcp))changes.push("调整场景 MCP 工具选择");
      return {revision:row.revision,changes:changes.length?changes:["保存配置（内容未变化）"]};
    });
    const runs=this.sqlite.prepare("SELECT run_id AS runId,revision FROM desktop_configuration_runs WHERE binding=? ORDER BY rowid DESC LIMIT 20").all(key(binding)) as Array<{runId:string;revision:number}>;
    const runCount=(this.sqlite.prepare("SELECT count(*) AS n FROM desktop_configuration_runs WHERE binding=?").get(key(binding)) as {n:number}).n;
    return {history,runs,runCount};
  }

  save(input: unknown): ConfigurationSnapshot {
    const request = ConfigurationSaveSchema.parse(input);
    if (Buffer.byteLength(JSON.stringify(request)) > 512 * 1024) throw new Error("Configuration exceeds 512 KiB");
    this.sqlite.transaction(() => {
      const current = this.snapshot().packages.find(pkg => key(pkg.package) === key(request.package));
      if (!current) throw new Error("Installed package unavailable");
      if (current.revision !== request.expectedRevision) throw new Error("Configuration changed; reload before saving");
      if (new Set(request.resources.map(r => r.id)).size !== request.resources.length || new Set(request.mcp.map(m => m.source)).size !== request.mcp.length) throw new Error("Duplicate configuration entry");
      for (const r of request.resources) {
        if (!current.resources.some(item => item.id === r.id && item.editable)) throw new Error("Resource is not editable");
        if (r.content !== null && Buffer.byteLength(r.content) > 65536) throw new Error("Resource exceeds 64 KiB");
      }
      const pkg = this.packages.list().find(p => key(this.packages.bindingFor(p)) === key(request.package))!;
      const userResources = request.userResources ?? current.userResources ?? [];
      if (new Set(userResources.map(r => r.id)).size !== userResources.length) throw new Error("Duplicate user resource");
      for (const r of userResources) {
        if (r.kind === "prompt") renderGuidanceTemplate(r.content,{goal:"",phase:"",role:"",runId:"",caseId:""});
        const parent = current.resources.find(item => item.id === r.parentId && item.editable);
        if (!parent || current.resources.some(item => item.id === r.id)) throw new Error("User resource requires an available local parent");
        if (Buffer.byteLength(r.content) > 65536) throw new Error("User resource exceeds 64 KiB");
        if (new Set(r.roles).size !== r.roles.length || new Set(r.phases).size !== r.phases.length
          || r.roles.some(role => !parent.roles.includes(role)) || r.phases.some(phase => !pkg.definition.phases.some(p => p.id === phase)
            || parent.phases.length > 0 && !parent.phases.includes(phase))) throw new Error("User resource scope exceeds its parent");
      }
      const disabled = new Set(request.resources.filter(r => !r.enabled).map(r => r.id));
      for (const r of pkg.resourceManifest?.resources ?? []) if (r.context && !disabled.has(r.id) && r.context.references.some(id => disabled.has(id))) throw new Error("Enabled resource depends on a disabled resource");
      for (const m of request.mcp) {
        const profile = current.mcp.find(item => item.source === m.source && item.profileDigest === m.profileDigest);
        if (!profile || new Set(m.tools).size !== m.tools.length || m.tools.some(name => !profile.tools.some(t => t.name === name))) throw new Error("MCP profile or tool is not reviewed");
      }
      const value = JSON.stringify({ resources: request.resources, mcp: request.mcp, userResources });
      if (Buffer.byteLength(value) > 512 * 1024) throw new Error("Configuration exceeds 512 KiB");
      this.sqlite.prepare("INSERT INTO desktop_configuration_versions VALUES (?,?,?)").run(key(request.package), current.revision + 1, value);
    })();
    return this.snapshot();
  }

  previewImport(input: unknown): ConfigurationImportPreview {
    const request=ConfigurationImportSchema.parse(input);
    if(request.from.id!==request.package.id || key(request.from)===key(request.package))throw new Error("Choose another version of the same package");
    const current=this.snapshot().packages.find(p=>key(p.package)===key(request.package));
    if(!current || current.revision!==request.expectedRevision)throw new Error("Configuration changed; reload");
    const old=this.latest(request.from);if(!old.revision)throw new Error("Previous configuration unavailable");
    const phases=this.packages.list().find(p=>key(this.packages.bindingFor(p))===key(request.package))!.definition.phases.map(p=>p.id);
    const conflicts:string[]=[];
    const resources=current.resources.filter(r=>r.editable).map(r=>{const prior=old.value.resources.find(p=>p.id===r.id);return prior??{id:r.id,enabled:r.enabled,content:r.content};});
    for(const r of old.value.resources)if(!resources.some(p=>p.id===r.id))conflicts.push(`${r.id}: 新版本没有可编辑的对应资源，未导入。`);
    const userResources=(old.value.userResources??[]).filter(r=>{const parent=current.resources.find(p=>p.id===r.parentId&&p.editable);
      const compatible=parent&&r.roles.every(role=>parent.roles.includes(role))&&r.phases.every(phase=>phases.includes(phase)&&(!parent.phases.length||parent.phases.includes(phase)));
      if(!compatible)conflicts.push(`${r.id}: 父资源、角色或阶段不兼容，未导入。`);return compatible;});
    if(old.value.mcp.length)conflicts.push("MCP 工具选择绑定原审核配置，未跨版本转移；请单独审核新版本连接。");
    return {draft:{package:request.package,expectedRevision:current.revision,resources,userResources,mcp:current.mcp.map(m=>({source:m.source,profileDigest:m.profileDigest,enabled:m.enabled,tools:m.tools.filter(t=>t.enabled).map(t=>t.name)}))},conflicts};
  }

  resource(runId: string, binding: ScenarioPackageBinding, original: ScenarioPackageResource): ScenarioPackageResource | null {
    const override = this.forRun(runId, binding).resources.find(r => r.id === original.id);
    if (override?.enabled === false) return null;
    return override?.content !== null && override?.content !== undefined ? { ...original, digest: contextContentDigest(override.content) } : original;
  }

  /** Custom text inherits an already-authorized parent; it cannot add capabilities or executable contracts. */
  promptIds(runId: string,binding: ScenarioPackageBinding): string[] { return (this.forRun(runId,binding).userResources ?? []).filter(r=>r.kind==="prompt"&&r.enabled).map(r=>r.id); }

  userResources(runId: string, binding: ScenarioPackageBinding, parents: readonly ScenarioPackageResource[]): ScenarioPackageResource[] {
    return (this.forRun(runId, binding).userResources ?? []).flatMap(item => {
      const parent = parents.find(p => p.id === item.parentId);
      if (!item.enabled || !parent?.context || parent.context.external) return [];
      const { skill: _skill, external: _external, ...context } = parent.context;
      return [{ id: item.id, kind: "text", version: 1, locator: `user:${item.id}`, digest: contextContentDigest(item.content),
        context: { ...context, type: item.kind === "knowledge" ? "knowledge" : "skill", summary: item.title,
          phaseIds: item.phases.length ? item.phases : context.phaseIds, readerRoles: item.roles } } satisfies ScenarioPackageResource];
    });
  }

  read(runId: string, binding: ScenarioPackageBinding, effective: ScenarioPackageResource): string {
    const pkg = this.packages.list().find(p => key(this.packages.bindingFor(p)) === key(binding));
    if (!pkg) throw new Error("Package unavailable");
    this.packages.assertAvailable(pkg);
    const user = (this.forRun(runId, binding).userResources ?? []).find(r => r.id === effective.id);
    const original = pkg.resourceManifest?.resources.find(r => r.id === (user?.parentId ?? effective.id));
    if (!original) throw new Error("Resource unavailable");
    this.content.assertAvailable(binding, original);
    const selected = this.resource(runId, binding, original);
    if (user) {
      if (!user.enabled || !selected || effective.digest !== contextContentDigest(user.content)) throw new Error("User resource unavailable");
      return user.content;
    }
    if (!selected || selected.digest !== effective.digest) throw new Error("Configuration resource identity mismatch");
    return this.forRun(runId, binding).resources.find(r => r.id === original.id)?.content ?? this.content.read(binding, original);
  }

  assertMcp(runId: string, binding: ScenarioPackageBinding, source: string, digest: string, tool: string): void {
    const choice = this.forRun(runId, binding).mcp.find(item => item.source === source);
    if (choice && (choice.profileDigest !== digest || !choice.enabled || !choice.tools.includes(tool))) throw new Error("MCP tool disabled in Run configuration");
  }

  toolAllowed(runId: string, source: string, tool: string): boolean {
    const server = this.mcp.find(m => m.source === source);
    if (!server) return true;
    try {
      const pin = this.sqlite.prepare("SELECT binding FROM desktop_configuration_runs WHERE run_id=?").get(runId) as { binding: string } | undefined;
      if (!pin) return false;
      const [id, version, schemaRevision] = JSON.parse(pin.binding);
      this.assertMcp(runId, { id, version, schemaRevision }, source, mcpToolProfileDigest(server), tool); return true;
    }
    catch { return false; }
  }
}

export function registerDesktopConfigurationRoutes(app: FastifyInstance, store: DesktopConfigurationStore) {
  app.get("/api/desktop/configuration", async () => store.snapshot());
  app.post("/api/desktop/configuration/import",async(request,reply)=>{try{return store.previewImport(request.body);}catch{return reply.code(409).send({error:"旧版本配置无法导入，请重新读取并核对版本。"});}});
  app.post("/api/desktop/configuration", { bodyLimit: 600 * 1024 }, async (request, reply) => {
    try { return store.save(request.body); }
    catch (error) { return reply.code(409).send({ error: error instanceof Error ? error.message : "Configuration could not be saved" }); }
  });
}
