import { createHash, randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { constants, closeSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { z } from "zod";
import { canonicalJson } from "@traceforge/orchestration-core";
import { waitForCancellation } from "@traceforge/worker-runtime";

const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const text = z.string().trim().min(1).max(1024);
const secretReference = z.string().regex(/^host-secret:\/\/[a-zA-Z0-9][a-zA-Z0-9_./-]{0,255}$/);
const componentKind = z.enum([
  "foundation", "database_schema", "native_helper", "trust_root", "scenario_package", "skill",
  "knowledge_resource", "mcp_provider", "extension_assembly", "model_configuration", "capacity_policy", "recovery_identity",
]);
const componentSchema = z.object({ kind: componentKind, id, version: text, digest, required: z.boolean() }).strict();
export const foundationDeploymentInventorySchema = z.object({
  components: z.array(componentSchema).min(1).max(4096),
  secretReferences: z.array(secretReference).max(256),
}).strict().superRefine((value, context) => {
  const identities = new Set<string>();
  for (const component of value.components) {
    const identity = `${component.kind}:${component.id}`;
    if (identities.has(identity)) context.addIssue({ code: "custom", message: `Duplicate deployment component ${identity}` });
    identities.add(identity);
  }
  if (new Set(value.secretReferences).size !== value.secretReferences.length) context.addIssue({ code: "custom", message: "Duplicate deployment secret reference" });
});
export type FoundationDeploymentInventory = z.infer<typeof foundationDeploymentInventorySchema>;
export const foundationDeploymentManifestSchema = z.object({
  format: z.literal(1), profile: z.literal("traceforge-foundation-deployment-v1"), releaseId: id,
  deploymentGeneration: z.number().int().positive(), createdAt: z.string().datetime(), inventory: foundationDeploymentInventorySchema,
  migration: z.object({ fromSchemaRevision: z.number().int().nonnegative(), toSchemaRevision: z.number().int().nonnegative(),
    planDigest: digest, rollbackCompatible: z.boolean() }).strict(),
}).strict().superRefine((value, context) => {
  for (const kind of componentKind.options) if (!value.inventory.components.some(component => component.kind === kind)) context.addIssue({ code: "custom", message: `Deployment manifest omits ${kind}` });
  const schemas = value.inventory.components.filter(component => component.kind === "database_schema");
  if (schemas.length !== 1 || schemas[0]!.version !== String(value.migration.toSchemaRevision)) context.addIssue({ code: "custom", message: "Deployment database component must exactly match the migration target revision" });
});
export type FoundationDeploymentManifest = z.infer<typeof foundationDeploymentManifestSchema>;

const stageRequestSchema = z.object({ operation: z.literal("stage"), commandId: id, manifest: foundationDeploymentManifestSchema, actor: text, reason: text }).strict();
const switchRequestSchema = z.object({ operation: z.enum(["activate", "rollback"]), commandId: id, releaseId: id,
  deploymentGeneration: z.number().int().positive(), expectedSwitchGeneration: z.number().int().nonnegative(), planFingerprint: digest, actor: text, reason: text }).strict();
export const foundationDeploymentRequestSchema = z.discriminatedUnion("operation", [stageRequestSchema, switchRequestSchema]);
export type FoundationDeploymentRequest = z.infer<typeof foundationDeploymentRequestSchema>;
type DeploymentContext = { databasePath: string; activeCandidate?: { candidateId: string; provenanceDigest: string; generation: number } };
export interface FoundationDeploymentOptions {
  auditDb: Database.Database;
  controlRoot: string;
  authorizer?: { authorize(input: FoundationDeploymentRequest): Promise<{ decision: "allowed"; authorizationRef: string; expiresAt: string } | { decision: "denied" }> };
  currentInventory: (manifest: FoundationDeploymentManifest, context: DeploymentContext) => FoundationDeploymentInventory;
  maximumReleases?: number;
  startupContext?: DeploymentContext;
}
const pointerTargetSchema = z.object({ releaseId: id, deploymentGeneration: z.number().int().positive(), manifestDigest: digest }).strict();
const pointerSchema = z.object({ format: z.literal(1), switchGeneration: z.number().int().positive(), active: pointerTargetSchema,
  previous: pointerTargetSchema.nullable(), switchedAt: z.string().datetime() }).strict();
export type FoundationDeploymentPointer = z.infer<typeof pointerSchema>;
export interface FoundationDeploymentPreflight {
  ready: boolean;
  manifestDigest: string;
  releaseId: string;
  deploymentGeneration: number;
  missing: string[];
  unexpected: string[];
  drifted: { identity: string; expectedVersion: string; actualVersion: string; expectedDigest: string; actualDigest: string }[];
  secretReferencesMissing: string[];
}

const hash = (value: unknown) => createHash("sha256").update(typeof value === "string" || Buffer.isBuffer(value) ? value : canonicalJson(value)).digest("hex");
function privateDirectory(path: string) {
  const absolute = resolve(path); let current = absolute;
  while (true) { try { if (lstatSync(current).isSymbolicLink()) throw new Error("Deployment control root cannot contain symlinks"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const parent = resolve(current, ".."); if (parent === current) break; current = parent; }
  mkdirSync(absolute, { recursive: true, mode: 0o700 });
  if (!lstatSync(absolute).isDirectory()) throw new Error("Deployment control root must be a directory");
  if (process.platform !== "win32" && (lstatSync(absolute).mode & 0o077) !== 0) throw new Error("Deployment control root must be private (0700)");
  return realpathSync(absolute);
}
function bounded(path: string, maximum: number) { const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { const stat = fstatSync(fd); if (!stat.isFile() || stat.size > maximum) throw new Error("Deployment publication file invalid"); return readFileSync(fd); }
  finally { closeSync(fd); } }
function sync(path: string) { const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); try { fsyncSync(fd); } finally { closeSync(fd); } }
function durable(path: string, body: string) { writeFileSync(path, body, { flag: "wx", mode: 0o600 }); sync(path); }
function normalizeInventory(value: unknown): FoundationDeploymentInventory {
  const inventory = foundationDeploymentInventorySchema.parse(structuredClone(value));
  return { components: [...inventory.components].sort((a, b) => `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`)), secretReferences: [...inventory.secretReferences].sort() };
}
function preflight(manifest: FoundationDeploymentManifest, actualValue: unknown): FoundationDeploymentPreflight {
  const expected = normalizeInventory(manifest.inventory), actual = normalizeInventory(actualValue);
  const wanted = new Map(expected.components.map(component => [`${component.kind}:${component.id}`, component]));
  const found = new Map(actual.components.map(component => [`${component.kind}:${component.id}`, component]));
  const missing = [...wanted].filter(([key, component]) => component.required && !found.has(key)).map(([key]) => key);
  const unexpected = [...found.keys()].filter(key => !wanted.has(key));
  const drifted = [...wanted].flatMap(([identity, component]) => { const current = found.get(identity); return !current || (current.version === component.version && current.digest === component.digest) ? [] : [{ identity,
    expectedVersion: component.version, actualVersion: current.version, expectedDigest: component.digest, actualDigest: current.digest }]; });
  const actualSecrets = new Set(actual.secretReferences), secretReferencesMissing = expected.secretReferences.filter(reference => !actualSecrets.has(reference));
  const manifestDigest = hash(canonicalJson(manifest));
  return { ready: !missing.length && !unexpected.length && !drifted.length && !secretReferencesMissing.length, manifestDigest,
    releaseId: manifest.releaseId, deploymentGeneration: manifest.deploymentGeneration, missing, unexpected, drifted, secretReferencesMissing };
}

export class FoundationDeploymentControl {
  private readonly root: string; private readonly maximumReleases: number; private busy = false;
  constructor(private readonly options: FoundationDeploymentOptions, private readonly now = () => new Date().toISOString()) {
    if (options.auditDb.readonly) throw new Error("Deployment control requires a writable audit database");
    this.root = privateDirectory(options.controlRoot); this.maximumReleases = options.maximumReleases ?? 32;
    if (!Number.isSafeInteger(this.maximumReleases) || this.maximumReleases < 2 || this.maximumReleases > 1024) throw new Error("Invalid deployment release capacity");
    options.auditDb.exec(`CREATE TABLE IF NOT EXISTS foundation_deployment_operations(command_id TEXT PRIMARY KEY,request_hash TEXT NOT NULL,request_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS foundation_deployment_events(sequence INTEGER PRIMARY KEY,release_id TEXT NOT NULL,revision INTEGER NOT NULL,command_id TEXT NOT NULL UNIQUE,event_type TEXT NOT NULL,audit_json TEXT NOT NULL,UNIQUE(release_id,revision));
      CREATE TRIGGER IF NOT EXISTS foundation_deployment_operation_capacity BEFORE INSERT ON foundation_deployment_operations BEGIN SELECT CASE WHEN (SELECT count(*) FROM foundation_deployment_operations)>=10000 THEN RAISE(ABORT,'Deployment command capacity exceeded') END;END;
      CREATE TRIGGER IF NOT EXISTS foundation_deployment_event_capacity BEFORE INSERT ON foundation_deployment_events BEGIN SELECT CASE WHEN (SELECT count(*) FROM foundation_deployment_events)>=50000 OR length(CAST(NEW.audit_json AS BLOB))>65536 THEN RAISE(ABORT,'Deployment audit capacity exceeded') END;END;`);
    for (const table of ["foundation_deployment_operations", "foundation_deployment_events"]) for (const operation of ["UPDATE", "DELETE"])
      options.auditDb.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_${operation} BEFORE ${operation} ON ${table} BEGIN SELECT RAISE(ABORT,'Deployment history is immutable');END;`);
  }
  inspect() { const active = this.pointer(); return { enabled: true, active, staged: this.releases(), limits: { maximumReleases: this.maximumReleases }, secretValuesPersisted: false }; }
  audit(commandId: string) { id.parse(commandId); const row = this.options.auditDb.prepare("SELECT audit_json FROM foundation_deployment_events WHERE command_id=? OR substr(command_id,1,length(?)+1)=?||':' ORDER BY sequence DESC LIMIT 1").get(commandId, commandId, commandId) as { audit_json: string } | undefined;
    if (!row) throw new Error("Deployment audit missing"); return JSON.parse(row.audit_json); }
  preview(value: unknown, context = this.options.startupContext ?? { databasePath: ":unknown:" }) {
    const input = z.object({ operation: z.enum(["activate", "rollback"]), releaseId: id, deploymentGeneration: z.number().int().positive(), expectedSwitchGeneration: z.number().int().nonnegative() }).strict().parse(value);
    const manifest = this.manifest(input.releaseId, input.deploymentGeneration), pointer = this.pointer(), switchGeneration = pointer?.switchGeneration ?? 0;
    if (switchGeneration !== input.expectedSwitchGeneration) throw new Error("Deployment preview generation changed");
    const target = { releaseId: manifest.releaseId, deploymentGeneration: manifest.deploymentGeneration, manifestDigest: hash(canonicalJson(manifest)) };
    if (input.operation === "activate" && pointer?.active.manifestDigest === target.manifestDigest) throw new Error("Deployment release is already active");
    if (input.operation === "rollback" && canonicalJson(pointer?.previous) !== canonicalJson(target)) throw new Error("Rollback target is not the immediately previous deployment");
    if (input.operation === "activate" && pointer) {
      const current = this.manifest(pointer.active.releaseId, pointer.active.deploymentGeneration);
      if (manifest.deploymentGeneration !== current.deploymentGeneration + 1 || manifest.migration.fromSchemaRevision !== current.migration.toSchemaRevision) throw new Error("Deployment generation or database migration chain is not contiguous");
    }
    if (input.operation === "rollback" && pointer) {
      const current = this.manifest(pointer.active.releaseId, pointer.active.deploymentGeneration);
      if (!current.migration.rollbackCompatible || manifest.migration.toSchemaRevision !== current.migration.fromSchemaRevision) throw new Error("Deployment database migration is not rollback compatible");
    }
    const report = preflight(manifest, this.options.currentInventory(manifest, context)); if (!report.ready) throw new Error("Deployment preflight blocked by missing or drifted host material");
    const plan = { operation: input.operation, target, current: pointer?.active ?? null, expectedSwitchGeneration: switchGeneration,
      nextSwitchGeneration: switchGeneration + 1, migration: manifest.migration, preflightDigest: hash(report) };
    return { ...plan, planFingerprint: hash(plan), preflight: report };
  }
  startup(context: DeploymentContext): { pointer: FoundationDeploymentPointer; manifest: FoundationDeploymentManifest; preflight: FoundationDeploymentPreflight } {
    const pointer = this.pointer(); if (!pointer) throw new Error("Trusted host deployment has no active manifest");
    const manifest = this.manifest(pointer.active.releaseId, pointer.active.deploymentGeneration);
    if (hash(canonicalJson(manifest)) !== pointer.active.manifestDigest) throw new Error("Active deployment manifest digest mismatch");
    const report = preflight(manifest, this.options.currentInventory(manifest, context));
    if (!report.ready) throw new Error(`Trusted host deployment preflight failed: ${JSON.stringify({ missing: report.missing, unexpected: report.unexpected, drifted: report.drifted.map(item => item.identity), secretReferencesMissing: report.secretReferencesMissing })}`);
    return { pointer, manifest, preflight: report };
  }
  async execute(value: unknown, context = this.options.startupContext ?? { databasePath: ":unknown:" }) {
    const input = foundationDeploymentRequestSchema.parse(structuredClone(value)), requestDigest = hash(input);
    const old = this.options.auditDb.prepare("SELECT request_hash FROM foundation_deployment_operations WHERE command_id=?").get(input.commandId) as { request_hash: string } | undefined;
    if (old && old.request_hash !== requestDigest) throw new Error("Deployment command conflict");
    const grant = structuredClone(await waitForCancellation(() => this.options.authorizer?.authorize(structuredClone(input)) ?? Promise.resolve({ decision: "denied" as const }), AbortSignal.timeout(10_000)));
    if (grant.decision !== "allowed" || !grant.authorizationRef?.trim() || grant.authorizationRef.length > 1024 || Date.parse(grant.expiresAt) <= Date.parse(this.now())) throw new Error("Deployment authorization denied or expired");
    if (old) {
      if (input.operation === "stage" && !existsSync(this.releaseRoot(input.manifest.releaseId, input.manifest.deploymentGeneration))) return this.stage(input, grant, true);
      return this.replay(input, context);
    }
    if (this.busy) throw new Error("Deployment control busy"); this.busy = true;
    try { return input.operation === "stage" ? this.stage(input, grant) : this.switch(input, grant, context); } finally { this.busy = false; }
  }
  private stage(input: z.infer<typeof stageRequestSchema>, grant: { decision: "allowed"; authorizationRef: string; expiresAt: string }, recovering = false) {
    const manifest = foundationDeploymentManifestSchema.parse(structuredClone(input.manifest)), pointer = this.pointer();
    if (pointer && manifest.deploymentGeneration <= pointer.active.deploymentGeneration) throw new Error("Staged deployment generation must advance the active deployment");
    const releases = this.releases();
    if (releases.length >= this.maximumReleases) throw new Error("Deployment release capacity exceeded");
    if (releases.some(release => release.releaseId === manifest.releaseId || ("deploymentGeneration" in release && release.deploymentGeneration === manifest.deploymentGeneration))) throw new Error("Deployment release id and generation must be unique");
    const directory = this.releaseRoot(manifest.releaseId, manifest.deploymentGeneration); if (existsSync(directory)) throw new Error("Deployment release already exists");
    const started = { operation: "stage", releaseId: manifest.releaseId, deploymentGeneration: manifest.deploymentGeneration, authorizationRef: grant.authorizationRef, at: this.now() };
    if (!recovering) this.options.auditDb.transaction(() => { this.operation(input); this.event(manifest.releaseId, input.commandId, "stage_started", started); })();
    const temporary = join(this.root, `.release-${input.commandId}-${randomUUID()}.tmp`); mkdirSync(temporary, { mode: 0o700 });
    const body = canonicalJson(manifest); durable(join(temporary, "manifest.json"), body); durable(join(temporary, "READY"), hash(body)); sync(temporary); renameSync(temporary, directory); sync(this.root);
    const audit = { ...started, status: "staged", manifestDigest: hash(body), secretReferences: manifest.inventory.secretReferences, secretValuesPersisted: false, at: this.now() };
    this.event(manifest.releaseId, `${input.commandId}:staged`, recovering ? "staged_reconciled" : "staged", audit); return { audit, replayed: recovering, ...this.inspect() };
  }
  private switch(input: z.infer<typeof switchRequestSchema>, grant: { decision: "allowed"; authorizationRef: string; expiresAt: string }, context: DeploymentContext) {
    const preview = this.preview({ operation: input.operation, releaseId: input.releaseId, deploymentGeneration: input.deploymentGeneration,
      expectedSwitchGeneration: input.expectedSwitchGeneration }, context); if (preview.planFingerprint !== input.planFingerprint) throw new Error("Deployment switch plan changed");
    const pointer: FoundationDeploymentPointer = { format: 1, switchGeneration: preview.nextSwitchGeneration, active: preview.target,
      previous: preview.current, switchedAt: this.now() };
    const prepared = { operation: input.operation, releaseId: input.releaseId, deploymentGeneration: input.deploymentGeneration,
      authorizationRef: grant.authorizationRef, status: "switch_prepared", planFingerprint: input.planFingerprint, at: this.now() };
    this.options.auditDb.transaction(() => { this.operation(input); this.event(input.releaseId, input.commandId, "switch_prepared", prepared); })();
    const current = preflight(this.manifest(input.releaseId, input.deploymentGeneration), this.options.currentInventory(this.manifest(input.releaseId, input.deploymentGeneration), context));
    if (!current.ready || hash(current) !== preview.preflightDigest) throw new Error("Deployment material changed after authorization");
    this.writePointer(pointer, input.commandId); const audit = { ...prepared, status: "completed", switchGeneration: pointer.switchGeneration, restartRequired: true, at: this.now() };
    this.event(input.releaseId, `${input.commandId}:completed`, "switch_completed", audit); return { audit, replayed: false, ...this.inspect() };
  }
  private replay(input: FoundationDeploymentRequest, context: DeploymentContext) {
    if (input.operation === "stage") { const manifest = this.manifest(input.manifest.releaseId, input.manifest.deploymentGeneration);
      if (hash(canonicalJson(manifest)) !== hash(canonicalJson(input.manifest))) throw new Error("Published deployment no longer matches stage command");
      const audit = { operation: "stage", releaseId: manifest.releaseId, deploymentGeneration: manifest.deploymentGeneration, status: "staged", manifestDigest: hash(canonicalJson(manifest)), secretReferences: manifest.inventory.secretReferences, secretValuesPersisted: false, at: this.now() };
      try { const latest = this.audit(input.commandId) as { status?: string }; if (latest.status === "staged") return { audit: latest, replayed: true, ...this.inspect() }; }
      catch { /* The durable release is authoritative; append the missing terminal audit below. */ }
      this.event(manifest.releaseId, `${input.commandId}:staged`, "staged_reconciled", audit); return { audit, replayed: true, ...this.inspect() }; }
    const pointer = this.pointer(), target = { releaseId: input.releaseId, deploymentGeneration: input.deploymentGeneration,
      manifestDigest: hash(canonicalJson(this.manifest(input.releaseId, input.deploymentGeneration))) };
    if (pointer?.active.manifestDigest !== target.manifestDigest) {
      const preview = this.preview({ operation: input.operation, releaseId: input.releaseId, deploymentGeneration: input.deploymentGeneration,
        expectedSwitchGeneration: input.expectedSwitchGeneration }, context); if (preview.planFingerprint !== input.planFingerprint) throw new Error("Deployment replay plan changed");
      const current = preflight(this.manifest(input.releaseId, input.deploymentGeneration), this.options.currentInventory(this.manifest(input.releaseId, input.deploymentGeneration), context));
      if (!current.ready || hash(current) !== preview.preflightDigest) throw new Error("Deployment material changed during switch recovery");
      this.writePointer({ format: 1, switchGeneration: preview.nextSwitchGeneration, active: preview.target, previous: preview.current, switchedAt: this.now() }, input.commandId);
    }
    try { const latest = this.audit(input.commandId) as { status?: string }; if (latest.status === "completed") return { audit: latest, replayed: true, ...this.inspect() }; }
    catch { /* The durable pointer is authoritative; append the missing terminal audit below. */ }
    const active = this.pointer()!, audit = { operation: input.operation, releaseId: input.releaseId, deploymentGeneration: input.deploymentGeneration,
      status: "completed", switchGeneration: active.switchGeneration, restartRequired: true, at: this.now() };
    this.event(input.releaseId, `${input.commandId}:completed`, "switch_completed_reconciled", audit); return { audit, replayed: true, ...this.inspect() };
  }
  private releases() { return readdirSync(this.root).filter(name => name.startsWith("release-")).slice(0, this.maximumReleases + 1).map(name => { try { const manifest = this.readManifest(join(this.root, name));
      const manifestDigest = hash(canonicalJson(manifest));
      return { releaseId: manifest.releaseId, deploymentGeneration: manifest.deploymentGeneration, manifestDigest, status: this.pointer()?.active.manifestDigest === manifestDigest ? "active" : "staged" }; }
    catch { return { releaseId: name, status: "quarantined" as const }; } }); }
  private releaseRoot(releaseId: string, generation: number) { const path = resolve(this.root, `release-${generation}-${releaseId}`); if (!path.startsWith(this.root + sep)) throw new Error("Deployment release escaped control root"); return path; }
  private manifest(releaseId: string, generation: number) { return this.readManifest(this.releaseRoot(releaseId, generation)); }
  private readManifest(directory: string) { const body = bounded(join(directory, "manifest.json"), 1024 * 1024), manifest = foundationDeploymentManifestSchema.parse(JSON.parse(body.toString()));
    if (bounded(join(directory, "READY"), 64).toString() !== hash(body) || JSON.stringify(readdirSync(directory).sort()) !== JSON.stringify(["READY", "manifest.json"])) throw new Error("Deployment release publication is incomplete or contains unexpected files"); return manifest; }
  private pointer() { const path = join(this.root, "ACTIVE.json"); if (!existsSync(path)) return null; return pointerSchema.parse(JSON.parse(bounded(path, 8192).toString())); }
  private writePointer(pointer: FoundationDeploymentPointer, commandId: string) { this.manifest(pointer.active.releaseId, pointer.active.deploymentGeneration);
    const temporary = join(this.root, `.ACTIVE-${commandId}-${randomUUID()}.tmp`); durable(temporary, canonicalJson(pointer)); renameSync(temporary, join(this.root, "ACTIVE.json")); sync(this.root); }
  private operation(input: FoundationDeploymentRequest) { this.options.auditDb.prepare("INSERT INTO foundation_deployment_operations VALUES (?,?,?)").run(input.commandId, hash(input), canonicalJson(input)); }
  private revision(releaseId: string) { return (this.options.auditDb.prepare("SELECT count(*) count FROM foundation_deployment_events WHERE release_id=?").get(releaseId) as { count: number }).count; }
  private event(releaseId: string, commandId: string, eventType: string, audit: unknown) { this.options.auditDb.prepare("INSERT INTO foundation_deployment_events(release_id,revision,command_id,event_type,audit_json) VALUES (?,?,?,?,?)")
    .run(releaseId, this.revision(releaseId) + 1, commandId, eventType, canonicalJson(audit)); }
}

export function resolveFoundationDeployment(options: FoundationDeploymentOptions | undefined, context: DeploymentContext) {
  if (!options) return undefined; return new FoundationDeploymentControl(options).startup(context);
}
export function registerFoundationDeploymentRoutes(app: FastifyInstance, control: FoundationDeploymentControl) {
  app.get("/api/foundation/deployment", async () => control.inspect());
  app.get("/api/foundation/deployment/audit", async (request, reply) => { try { return control.audit(z.object({ commandId: id }).strict().parse(request.query).commandId); }
    catch (error) { return reply.code(error instanceof z.ZodError ? 400 : 409).send({ error: error instanceof Error ? error.message.slice(0, 512) : "Deployment audit failed" }); } });
  app.post("/api/foundation/deployment/preview", async (request, reply) => { try { return control.preview(request.body); }
    catch (error) { return reply.code(error instanceof z.ZodError ? 400 : 409).send({ error: error instanceof Error ? error.message.slice(0, 512) : "Deployment preview failed" }); } });
  app.post("/api/foundation/deployment/execute", async (request, reply) => { try { return await control.execute(request.body); }
    catch (error) { return reply.code(error instanceof z.ZodError ? 400 : 409).send({ error: error instanceof Error ? error.message.slice(0, 512) : "Deployment operation failed" }); } });
}
