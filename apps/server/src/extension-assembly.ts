import { createHash } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { canonicalJson, type ScenarioPackageBinding } from "@traceforge/orchestration-core";
import type { ScenarioPackageRegistry } from "@traceforge/scenario-sdk";
import { waitForCancellation, type ScenarioProcessLaunch } from "@traceforge/worker-runtime";
import type { FoundationMcpContextServer } from "./mcp-context-loader.js";
import { mcpContextProfileDigest } from "./mcp-context-loader.js";
import type { FoundationMcpServer } from "./mcp-execution-source.js";
import { mcpToolProfileDigest } from "./mcp-execution-source.js";
import type { SqlitePackageContextStore } from "./package-context-resources.js";
import { scenarioPackageContractDigest } from "./scenario-package-trust.js";
import type { ToolProviderInstallation } from "./tool-provider-control-plane.js";

type AssemblyUnitKind = "package" | "skill" | "knowledge" | "mcp_tool_profile" | "mcp_context_profile" | "process_provider" | "managed_provider";
interface AssemblyUnit {
  id: string;
  kind: AssemblyUnitKind;
  package: ScenarioPackageBinding | null;
  identityDigest: string;
  dependencies: string[];
}
interface AssemblyManifest { format: "traceforge.extension-assembly.v1"; units: AssemblyUnit[] }

const text = z.string().trim().min(1).max(256);
const profileKind = z.enum(["mcp_tool", "mcp_context"]);
const profileDigest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const revokeProfileSchema = z.object({ commandId: text, kind: profileKind, source: text, profileDigest,
  actor: text, reason: z.string().trim().min(1).max(1024) }).strict();
const archiveHistorySchema = z.object({ commandId: text, throughGeneration: z.number().int().positive(), actor: text,
  reason: z.string().trim().min(1).max(1024) }).strict();
export type ExtensionAssemblyArchiveRequest = z.infer<typeof archiveHistorySchema>;
export type ExtensionProfileRevocationRequest = z.infer<typeof revokeProfileSchema>;
export interface ExtensionProfileRollbackRequest {
  kind: "mcp_tool" | "mcp_context";
  source: string;
  fromReviewVersion: number;
  fromProfileDigest: string;
  toReviewVersion: number;
  toProfileDigest: string;
}
export interface ExtensionAssemblyOptions {
  revokeAuthorizer?: { authorize(request: ExtensionProfileRevocationRequest): Promise<
    { decision: "allowed"; authorizationRef: string; expiresAt: string } | { decision: "denied" }> };
  archiveAuthorizer?: { authorize(request: ExtensionAssemblyArchiveRequest): Promise<
    { decision: "allowed"; authorizationRef: string; expiresAt: string } | { decision: "denied" }> };
  /** Synchronous trusted-host attestation, normally backed by the active whole-deployment rollback. */
  authorizeProfileRollback?: (request: ExtensionProfileRollbackRequest) =>
    { authorizationRef: string; deploymentRef: string } | undefined;
  /** Exact trusted-host launch material selected for Package process manifests. Values are represented only by digest. */
  scenarioProcessLaunches?: Readonly<Record<string, ScenarioProcessLaunch>>;
  /** Current durable Managed Provider control-plane inventory, projected without package paths. */
  managedProviders?: readonly ToolProviderInstallation[];
}

export interface ExtensionAssemblySnapshot {
  schemaVersion: 1;
  state: "ready" | "unavailable";
  generation: number;
  digest: string;
  previousDigest: string | null;
  createdAt: string;
  unitCounts: Record<AssemblyUnitKind, number>;
  reason: string | null;
  deploymentComponent: ExtensionAssemblyDeploymentComponent;
}
export interface ExtensionAssemblyDeploymentComponent {
  kind: "extension_assembly";
  id: "active";
  version: string;
  digest: string;
  required: true;
}

const digest = (value: unknown) => `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
const bindingKey = (binding: ScenarioPackageBinding) => `${binding.id}@${binding.version}#${binding.schemaRevision}`;
const sameBinding = (left: ScenarioPackageBinding, right: ScenarioPackageBinding) => canonicalJson(left) === canonicalJson(right);

/**
 * Persists the exact, secret-free extension dependency closure selected by the trusted Host.
 * It never loads code or grants execution; Package trust, Scope and Gateway checks remain authoritative.
 */
export class ExtensionAssemblyControl {
  private readonly baseManifest: AssemblyManifest;
  private manifest: AssemblyManifest;
  private activation: { generation: number; digest: string; previousDigest: string | null; createdAt: string };
  private managedProviderInventory: (() => readonly ToolProviderInstallation[]) | undefined;
  private archiveMutation = false;

  constructor(
    private readonly sqlite: Database.Database,
    private readonly packages: ScenarioPackageRegistry,
    private readonly contextStore: SqlitePackageContextStore,
    private readonly mcpTools: readonly FoundationMcpServer[],
    private readonly mcpContext: readonly FoundationMcpContextServer[],
    private readonly options: ExtensionAssemblyOptions = {},
    private readonly now: () => string = () => new Date().toISOString(),
  ) {
    this.sqlite.function("extension_assembly_archive_mode", () => this.archiveMutation ? 1 : 0);
    this.initialize();
    this.baseManifest = this.buildManifest();
    this.manifest = this.composeManifest(options.managedProviders ?? []);
    this.activation = this.persist(this.manifest);
  }

  snapshot(): ExtensionAssemblySnapshot {
    let state: ExtensionAssemblySnapshot["state"] = "ready", reason: string | null = null;
    try {
      if (this.managedProviderInventory) this.reconcileManagedProviders(this.managedProviderInventory());
      const base = this.buildManifest();
      if (digest(base) !== digest(this.baseManifest) || canonicalJson(base) !== canonicalJson(this.baseManifest)) {
        throw new Error("Static extension assembly changed after startup");
      }
      const current = this.manifest;
      if (digest(current) !== this.activation.digest || canonicalJson(current) !== canonicalJson(this.manifest)) {
        throw new Error("Active extension assembly changed after startup");
      }
      this.validateCurrent(current);
      this.verifyStored();
    } catch (error) {
      state = "unavailable";
      reason = (error instanceof Error ? error.message : "Extension assembly unavailable").slice(0, 512);
    }
    const unitCounts = Object.fromEntries((["package", "skill", "knowledge", "mcp_tool_profile", "mcp_context_profile", "process_provider", "managed_provider"] as const)
      .map((kind) => [kind, this.manifest.units.filter((unit) => unit.kind === kind).length])) as Record<AssemblyUnitKind, number>;
    return { schemaVersion: 1, state, ...this.activation, unitCounts, reason, deploymentComponent: this.deploymentComponent() };
  }

  deploymentComponent(): ExtensionAssemblyDeploymentComponent {
    return { kind: "extension_assembly", id: "active", version: String(this.activation.generation),
      digest: this.activation.digest.slice("sha256:".length), required: true };
  }

  attachManagedProviderInventory(load: () => readonly ToolProviderInstallation[]): void {
    if (this.managedProviderInventory) throw new Error("Managed Provider inventory is already attached");
    this.managedProviderInventory = load;
    this.reconcileManagedProviders(load());
  }

  reconcileManagedProviders(installations: readonly ToolProviderInstallation[]): void {
    if (installations.length > 1024) throw new Error("Managed Provider assembly capacity exceeded");
    const next = this.composeManifest(installations);
    if (canonicalJson(next) === canonicalJson(this.manifest)) return;
    const activation = this.persist(next);
    this.manifest = next;
    this.activation = activation;
  }

  assertProfileAvailable(kind: "mcp_tool" | "mcp_context", source: string, value: string): void {
    profileKind.parse(kind); text.parse(source); profileDigest.parse(value);
    const row = this.sqlite.prepare(`SELECT reason FROM extension_assembly_profile_revocations
      WHERE kind=? AND source=? AND profile_digest=?`).get(kind, source, value) as { reason: string } | undefined;
    if (row) throw new Error(`Extension profile is revoked: ${row.reason}`);
    const configured = kind === "mcp_tool" ? this.mcpTools.some((item) => item.source === source && mcpToolProfileDigest(item) === value)
      : this.mcpContext.some((item) => item.source === source && mcpContextProfileDigest(item) === value);
    if (!configured) throw new Error("Extension profile is not in the active assembly");
    const unitKind: AssemblyUnitKind = kind === "mcp_tool" ? "mcp_tool_profile" : "mcp_context_profile";
    if (!this.manifest.units.some((unit) => unit.kind === unitKind && unit.identityDigest === value
      && unit.id === `${kind === "mcp_tool" ? "mcp-tool" : "mcp-context"}:${source}:${value}`)) {
      throw new Error("Extension profile identity changed after activation");
    }
    this.verifyStored();
  }

  inspectRevocation(commandId: string) {
    const row = this.sqlite.prepare(`SELECT request_hash,audit_json FROM extension_assembly_profile_revocations WHERE command_id=?`)
      .get(text.parse(commandId)) as { request_hash: string; audit_json: string } | undefined;
    if (!row) throw new Error("Extension profile revocation audit not found");
    const audit = JSON.parse(row.audit_json);
    const { authorizationRef: _authorizationRef, revokedAt: _revokedAt, automaticResume: _automaticResume, ...request } = audit;
    if (digest(request) !== row.request_hash) throw new Error("Extension profile revocation audit is corrupt");
    return audit;
  }

  async revokeProfile(value: unknown) {
    const input = revokeProfileSchema.parse(structuredClone(value));
    const exists = this.sqlite.prepare(`SELECT 1 FROM extension_assembly_profiles
      WHERE kind=? AND source=? AND profile_digest=?`).get(input.kind, input.source, input.profileDigest);
    if (!exists) throw new Error("Reviewed extension profile not found");
    const requestHash = digest(input);
    const old = this.sqlite.prepare(`SELECT request_hash,audit_json FROM extension_assembly_profile_revocations WHERE command_id=?`)
      .get(input.commandId) as { request_hash: string; audit_json: string } | undefined;
    if (old && old.request_hash !== requestHash) throw new Error("Extension profile revocation command conflicts");
    const grant = structuredClone(await waitForCancellation(() => this.options.revokeAuthorizer?.authorize(structuredClone(input))
      ?? Promise.resolve({ decision: "denied" as const }), AbortSignal.timeout(10_000)));
    if (grant.decision !== "allowed" || !grant.authorizationRef.trim() || !(Date.parse(grant.expiresAt) > Date.parse(this.now()))) {
      throw new Error("Extension profile revocation authorization denied or expired");
    }
    if (old) return { audit: this.inspectRevocation(input.commandId), replayed: true };
    return this.sqlite.transaction(() => {
      const concurrent = this.sqlite.prepare(`SELECT request_hash,audit_json FROM extension_assembly_profile_revocations WHERE command_id=?`)
        .get(input.commandId) as { request_hash: string; audit_json: string } | undefined;
      if (concurrent) {
        if (concurrent.request_hash !== requestHash) throw new Error("Extension profile revocation command conflicts");
        return { audit: this.inspectRevocation(input.commandId), replayed: true };
      }
      if (!(Date.parse(grant.expiresAt) > Date.parse(this.now()))) throw new Error("Extension profile revocation authorization expired");
      const audit = { ...input, authorizationRef: grant.authorizationRef, revokedAt: this.now(), automaticResume: false };
      const auditJson = canonicalJson(audit);
      this.sqlite.prepare(`INSERT INTO extension_assembly_profile_revocations
        (kind,source,profile_digest,command_id,request_hash,reason,audit_json) VALUES (?,?,?,?,?,?,?)`)
        .run(input.kind, input.source, input.profileDigest, input.commandId, requestHash, input.reason, auditJson);
      return { audit, replayed: false };
    })();
  }

  async archiveHistory(value: unknown) {
    const input = archiveHistorySchema.parse(structuredClone(value)), requestHash = digest(input);
    const old = this.sqlite.prepare("SELECT request_hash,audit_json FROM extension_assembly_archives WHERE command_id=?")
      .get(input.commandId) as { request_hash: string; audit_json: string } | undefined;
    if (old && old.request_hash !== requestHash) throw new Error("Extension assembly archive command conflicts");
    const grant = structuredClone(await waitForCancellation(() => this.options.archiveAuthorizer?.authorize(structuredClone(input))
      ?? Promise.resolve({ decision: "denied" as const }), AbortSignal.timeout(10_000)));
    if (grant.decision !== "allowed" || !grant.authorizationRef.trim() || !(Date.parse(grant.expiresAt) > Date.parse(this.now()))) {
      throw new Error("Extension assembly archive authorization denied or expired");
    }
    if (old) return { audit: this.verifyArchiveAudit(old.audit_json, old.request_hash), replayed: true };
    const activeGeneration = this.activation.generation;
    const rows = this.sqlite.prepare(`SELECT generation,snapshot_digest,previous_digest,created_at FROM extension_assembly_activations
      WHERE generation<=? AND generation<? ORDER BY generation`).all(input.throughGeneration, Math.max(1, activeGeneration - 31)) as
      Array<{ generation: number; snapshot_digest: string; previous_digest: string | null; created_at: string }>;
    if (!rows.length) throw new Error("No inactive extension assembly history is eligible for archive");
    const generations = rows.map((row) => row.generation), firstGeneration = generations[0]!, lastGeneration = generations.at(-1)!;
    const snapshotDigests = [...new Set(rows.map((row) => row.snapshot_digest))];
    const snapshots = snapshotDigests.map((value) => {
      const row = this.sqlite.prepare("SELECT digest,manifest_json,created_at FROM extension_assembly_snapshots WHERE digest=?").get(value) as
        { digest: string; manifest_json: string; created_at: string } | undefined;
      if (!row || digest(JSON.parse(row.manifest_json)) !== row.digest) throw new Error("Extension assembly archive source is corrupt");
      return { digest: row.digest, manifest: JSON.parse(row.manifest_json), createdAt: row.created_at };
    });
    const body = canonicalJson({ format: "traceforge.extension-assembly-archive.v1", activations: rows.map((row) => ({
      generation: row.generation, snapshotDigest: row.snapshot_digest, previousDigest: row.previous_digest, createdAt: row.created_at,
    })), snapshots });
    const bodyBytes = Buffer.byteLength(body), compressed = gzipSync(body, { level: 9 });
    if (bodyBytes > 16 * 1024 * 1024 || compressed.length > 4 * 1024 * 1024) throw new Error("Extension assembly archive exceeds bounded size");
    const bodyDigest = digest(JSON.parse(body)), createdAt = this.now();
    const audit = { ...input, firstGeneration, lastGeneration, generations: generations.length, snapshots: snapshots.length,
      bodyDigest, bodyBytes, compressedBytes: compressed.length, authorizationRef: grant.authorizationRef, archivedAt: createdAt };
    const auditJson = canonicalJson(audit);
    this.archiveMutation = true;
    try {
      return this.sqlite.transaction(() => {
        if (!(Date.parse(grant.expiresAt) > Date.parse(this.now()))) throw new Error("Extension assembly archive authorization expired");
        this.sqlite.prepare(`INSERT INTO extension_assembly_archives
          (command_id,request_hash,first_generation,last_generation,body_digest,body_bytes,compressed_body,audit_json,created_at)
          VALUES (?,?,?,?,?,?,?,?,?)`).run(input.commandId, requestHash, firstGeneration, lastGeneration, bodyDigest, bodyBytes, compressed, auditJson, createdAt);
        const index = this.sqlite.prepare("INSERT INTO extension_assembly_archive_index VALUES (?,?)");
        for (const generation of generations) index.run(generation, input.commandId);
        const removeActivation = this.sqlite.prepare("DELETE FROM extension_assembly_activations WHERE generation=?");
        for (const generation of generations) removeActivation.run(generation);
        const removeSnapshot = this.sqlite.prepare(`DELETE FROM extension_assembly_snapshots WHERE digest=?
          AND NOT EXISTS(SELECT 1 FROM extension_assembly_activations WHERE snapshot_digest=?)
          AND NOT EXISTS(SELECT 1 FROM extension_assembly_active WHERE snapshot_digest=?)`);
        for (const value of snapshotDigests) removeSnapshot.run(value, value, value);
        return { audit, replayed: false };
      })();
    } finally { this.archiveMutation = false; }
  }

  archivedGeneration(generation: number) {
    if (!Number.isSafeInteger(generation) || generation < 1) throw new Error("Invalid extension assembly generation");
    const row = this.sqlite.prepare(`SELECT a.body_digest,a.body_bytes,a.compressed_body FROM extension_assembly_archive_index i
      JOIN extension_assembly_archives a ON a.command_id=i.command_id WHERE i.generation=?`).get(generation) as
      { body_digest: string; body_bytes: number; compressed_body: Buffer } | undefined;
    if (!row) throw new Error("Archived extension assembly generation not found");
    const body = gunzipSync(row.compressed_body, { maxOutputLength: 16 * 1024 * 1024 });
    if (body.length !== row.body_bytes) throw new Error("Extension assembly archive length mismatch");
    const parsed = JSON.parse(body.toString("utf8"));
    if (canonicalJson(parsed) !== body.toString("utf8") || digest(parsed) !== row.body_digest) throw new Error("Extension assembly archive digest mismatch");
    const activation = parsed.activations.find((item: { generation: number }) => item.generation === generation);
    if (!activation) throw new Error("Extension assembly archive index mismatch");
    const snapshot = parsed.snapshots.find((item: { digest: string }) => item.digest === activation.snapshotDigest);
    if (!snapshot || digest(snapshot.manifest) !== snapshot.digest) throw new Error("Extension assembly archive snapshot mismatch");
    return { activation, snapshot };
  }

  historyGeneration(generation: number) {
    if (!Number.isSafeInteger(generation) || generation < 1) throw new Error("Invalid extension assembly generation");
    const row = this.sqlite.prepare(`SELECT a.generation,a.snapshot_digest,a.previous_digest,a.created_at AS activation_created_at,
      s.manifest_json,s.created_at AS snapshot_created_at FROM extension_assembly_activations a
      JOIN extension_assembly_snapshots s ON s.digest=a.snapshot_digest WHERE a.generation=?`).get(generation) as {
        generation: number; snapshot_digest: string; previous_digest: string | null; activation_created_at: string;
        manifest_json: string; snapshot_created_at: string;
      } | undefined;
    if (!row) return this.archivedGeneration(generation);
    const manifest = JSON.parse(row.manifest_json);
    if (canonicalJson(manifest) !== row.manifest_json || digest(manifest) !== row.snapshot_digest) {
      throw new Error("Extension assembly hot history is corrupt");
    }
    return { activation: { generation: row.generation, snapshotDigest: row.snapshot_digest,
      previousDigest: row.previous_digest, createdAt: row.activation_created_at },
    snapshot: { digest: row.snapshot_digest, manifest, createdAt: row.snapshot_created_at } };
  }

  private verifyArchiveAudit(value: string, requestHash: string) {
    const audit = JSON.parse(value);
    const { firstGeneration: _first, lastGeneration: _last, generations: _generations, snapshots: _snapshots,
      bodyDigest: _digest, bodyBytes: _bytes, compressedBytes: _compressed, authorizationRef: _authorization,
      archivedAt: _at, ...request } = audit;
    if (digest(request) !== requestHash) throw new Error("Extension assembly archive audit is corrupt");
    return audit;
  }

  private buildManifest(): AssemblyManifest {
    if (this.mcpTools.length > 128 || this.mcpContext.length > 128) throw new Error("Extension profile count exceeds limit");
    const toolSources = new Set<string>(), contextSources = new Set<string>();
    const units: AssemblyUnit[] = [], unitIds = new Set<string>();
    const add = (unit: AssemblyUnit) => {
      if (unitIds.has(unit.id)) throw new Error(`Duplicate extension assembly unit ${unit.id}`);
      unitIds.add(unit.id); units.push({ ...unit, dependencies: [...unit.dependencies].sort() });
    };
    const packageList = this.packages.list();
    let unavailablePackage = false;
    for (const pkg of packageList) {
      const binding = this.packages.bindingFor(pkg), packageId = `package:${bindingKey(binding)}`;
      const packageAvailable = this.packages.bindingStatus(binding, pkg.definition.kind, pkg.definition.version).status === "available";
      if (!packageAvailable) unavailablePackage = true;
      add({ id: packageId, kind: "package", package: binding, identityDigest: scenarioPackageContractDigest(pkg), dependencies: [] });
      for (const resource of pkg.resourceManifest?.resources ?? []) {
        if (!resource.context) continue;
        const external = resource.context.external;
        const profileId = external ? `mcp-context:${external.source}:${external.profileDigest}` : null;
        add({ id: `${resource.context.type}:${bindingKey(binding)}:${resource.id}`, kind: resource.context.type,
          package: binding, identityDigest: resource.digest, dependencies: [packageId, ...(profileId ? [profileId] : [])] });
      }
      if (pkg.runtime) {
        const launch = this.options.scenarioProcessLaunches?.[pkg.runtime.source];
        if (!launch && packageAvailable) throw new Error(`Scenario Process ${pkg.runtime.source} has no trusted launch profile in the extension assembly`);
        const processDigest = digest({ manifest: pkg.runtime, launch: launch ?? null });
        if (launch) this.persistProcessProfile(binding, pkg.runtime.source, processDigest);
        add({ id: `process-provider:${bindingKey(binding)}:${pkg.runtime.source}`, kind: "process_provider",
          package: binding, identityDigest: processDigest, dependencies: [packageId] });
      }
    }
    for (const config of this.mcpContext) {
      if (!config.source.trim() || contextSources.has(config.source)) throw new Error("Duplicate or invalid MCP context source");
      contextSources.add(config.source);
      const profileDigest = mcpContextProfileDigest(config);
      add({ id: `mcp-context:${config.source}:${profileDigest}`, kind: "mcp_context_profile", package: null,
        identityDigest: profileDigest, dependencies: [] });
      this.persistProfile("mcp_context", config.source, config.reviewVersion, profileDigest, []);
    }
    for (const config of this.mcpTools) {
      if (!config.source.trim() || toolSources.has(config.source) || !Number.isSafeInteger(config.reviewVersion) || config.reviewVersion < 1
        || !config.packages.length || config.packages.length > 64) throw new Error("Duplicate or invalid MCP tool profile");
      toolSources.add(config.source);
      const bindings = config.packages.map((binding) => {
        const installation = packageList.find((candidate) => sameBinding(this.packages.bindingFor(candidate), binding));
        if (!installation) throw new Error(`MCP Package binding ${bindingKey(binding)} is unavailable`);
        return this.packages.bindingFor(installation);
      });
      if (new Set(bindings.map(canonicalJson)).size !== bindings.length) throw new Error("Duplicate MCP Package binding");
      const profileDigest = mcpToolProfileDigest(config);
      add({ id: `mcp-tool:${config.source}:${profileDigest}`, kind: "mcp_tool_profile", package: null,
        identityDigest: profileDigest, dependencies: bindings.map((binding) => `package:${bindingKey(binding)}`) });
      this.persistProfile("mcp_tool", config.source, config.reviewVersion, profileDigest, bindings);
    }
    const processSources = new Set(packageList.flatMap((pkg) => pkg.runtime ? [pkg.runtime.source] : []));
    for (const source of Object.keys(this.options.scenarioProcessLaunches ?? {})) {
      if (!processSources.has(source) && !unavailablePackage) throw new Error(`Unknown Scenario Process launch profile ${source}`);
    }
    return { format: "traceforge.extension-assembly.v1", units: units.sort((left, right) => left.id.localeCompare(right.id)) };
  }

  private validateCurrent(manifest: AssemblyManifest): void {
    const ids = new Set(manifest.units.map((unit) => unit.id));
    for (const unit of manifest.units) for (const dependency of unit.dependencies) {
      if (!ids.has(dependency)) throw new Error(`Extension dependency ${dependency} is unavailable`);
    }
    for (const config of this.mcpTools) this.assertNotRevoked("mcp_tool", config.source, mcpToolProfileDigest(config));
    for (const config of this.mcpContext) this.assertNotRevoked("mcp_context", config.source, mcpContextProfileDigest(config));
    for (const pkg of this.packages.list()) {
      this.packages.assertAvailable(pkg);
      const binding = this.packages.bindingFor(pkg);
      for (const resource of pkg.resourceManifest?.resources ?? []) {
        if (!resource.context || resource.context.external) continue;
        this.contextStore.read(binding, resource);
      }
    }
  }

  private composeManifest(installations: readonly ToolProviderInstallation[]): AssemblyManifest {
    const units = [...this.baseManifest.units];
    const identities = new Set<string>();
    for (const installation of installations) {
      const { manifest, manifestFingerprint, signerId, signature, state, stateReason } = structuredClone(installation);
      const identity = `${manifest.providerId}@${manifest.version}`;
      if (identities.has(identity)) throw new Error(`Duplicate Managed Provider ${identity}`);
      identities.add(identity);
      units.push({ id: `managed-provider:${identity}`, kind: "managed_provider", package: null,
        identityDigest: digest({ manifest, manifestFingerprint, signerId, signature, state, stateReason }), dependencies: [] });
    }
    return { format: "traceforge.extension-assembly.v1", units: units.sort((left, right) => left.id.localeCompare(right.id)) };
  }

  private assertNotRevoked(kind: "mcp_tool" | "mcp_context", source: string, value: string): void {
    const row = this.sqlite.prepare(`SELECT reason FROM extension_assembly_profile_revocations
      WHERE kind=? AND source=? AND profile_digest=?`).get(kind, source, value) as { reason: string } | undefined;
    if (row) throw new Error(`Extension profile is revoked: ${row.reason}`);
  }

  private persistProfile(kind: string, source: string, reviewVersion: number, profileDigest: string, bindings: readonly ScenarioPackageBinding[]): void {
    if (!Number.isSafeInteger(reviewVersion) || reviewVersion < 1) throw new Error("Invalid extension review version");
    const bindingJson = canonicalJson([...bindings].sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right))));
    const existing = this.sqlite.prepare(`SELECT profile_digest,package_bindings_json FROM extension_assembly_profiles
      WHERE kind=? AND source=? AND review_version=?`).get(kind, source, reviewVersion) as { profile_digest: string; package_bindings_json: string } | undefined;
    if (existing) {
      if (existing.profile_digest !== profileDigest || existing.package_bindings_json !== bindingJson) {
        throw new Error("Reviewed extension profile version changed identity");
      }
    }
    const highest = this.sqlite.prepare(`SELECT review_version,profile_digest FROM extension_assembly_profiles
      WHERE kind=? AND source=? ORDER BY review_version DESC LIMIT 1`).get(kind, source) as
      { review_version: number; profile_digest: string } | undefined;
    if (highest && reviewVersion < highest.review_version) {
      const request: ExtensionProfileRollbackRequest = { kind: profileKind.parse(kind), source,
        fromReviewVersion: highest.review_version, fromProfileDigest: highest.profile_digest,
        toReviewVersion: reviewVersion, toProfileDigest: profileDigest };
      const requestHash = digest(request);
      const recorded = this.sqlite.prepare("SELECT request_hash FROM extension_assembly_profile_rollbacks WHERE request_hash=?")
        .get(requestHash) as { request_hash: string } | undefined;
      if (!recorded) {
        const grant: unknown = this.options.authorizeProfileRollback?.(structuredClone(request));
        if (grant && typeof (grant as Promise<unknown>).then === "function") {
          void Promise.resolve(grant).catch(() => undefined);
          throw new Error("Extension profile rollback authorization must be synchronous");
        }
        const parsed = z.object({ authorizationRef: text, deploymentRef: text }).strict().safeParse(grant);
        if (!parsed.success) throw new Error("Extension profile rollback requires an explicit control-plane operation");
        this.sqlite.prepare("INSERT INTO extension_assembly_profile_rollbacks VALUES (?,?,?,?,?,?,?,?,?)")
          .run(requestHash, kind, source, highest.review_version, highest.profile_digest, reviewVersion, profileDigest,
            parsed.data.authorizationRef, parsed.data.deploymentRef);
      }
    }
    if (existing) return;
    this.sqlite.prepare("INSERT INTO extension_assembly_profiles VALUES (?,?,?,?,?)")
      .run(kind, source, reviewVersion, profileDigest, bindingJson);
  }

  private persistProcessProfile(binding: ScenarioPackageBinding, source: string, value: string): void {
    const packageKey = bindingKey(binding);
    const existing = this.sqlite.prepare(`SELECT profile_digest FROM extension_assembly_process_profiles
      WHERE package_key=? AND source=?`).get(packageKey, source) as { profile_digest: string } | undefined;
    if (existing) {
      if (existing.profile_digest !== value) throw new Error("Scenario Process launch profile changed for an existing Package version");
      return;
    }
    this.sqlite.prepare("INSERT INTO extension_assembly_process_profiles VALUES (?,?,?)").run(packageKey, source, value);
  }

  private persist(manifest: AssemblyManifest) {
    const manifestJson = canonicalJson(manifest), manifestDigest = digest(manifest), createdAt = this.now();
    if (!Number.isFinite(Date.parse(createdAt)) || Buffer.byteLength(manifestJson) > 512 * 1024) throw new Error("Invalid extension assembly snapshot");
    return this.sqlite.transaction(() => {
      const saved = this.sqlite.prepare("SELECT manifest_json FROM extension_assembly_snapshots WHERE digest=?")
        .get(manifestDigest) as { manifest_json: string } | undefined;
      if (saved && saved.manifest_json !== manifestJson) throw new Error("Extension assembly digest collision");
      if (!saved) this.sqlite.prepare("INSERT INTO extension_assembly_snapshots VALUES (?,?,?)").run(manifestDigest, manifestJson, createdAt);
      const active = this.sqlite.prepare("SELECT generation,snapshot_digest FROM extension_assembly_active WHERE id=1")
        .get() as { generation: number; snapshot_digest: string } | undefined;
      if (active?.snapshot_digest === manifestDigest) {
        const row = this.sqlite.prepare("SELECT previous_digest,created_at FROM extension_assembly_activations WHERE generation=?")
          .get(active.generation) as { previous_digest: string | null; created_at: string };
        return { generation: active.generation, digest: manifestDigest, previousDigest: row.previous_digest, createdAt: row.created_at };
      }
      const generation = (active?.generation ?? 0) + 1, previousDigest = active?.snapshot_digest ?? null;
      this.sqlite.prepare("INSERT INTO extension_assembly_activations VALUES (?,?,?,?)")
        .run(generation, manifestDigest, previousDigest, createdAt);
      this.sqlite.prepare(`INSERT INTO extension_assembly_active VALUES (1,?,?)
        ON CONFLICT(id) DO UPDATE SET generation=excluded.generation,snapshot_digest=excluded.snapshot_digest`)
        .run(generation, manifestDigest);
      return { generation, digest: manifestDigest, previousDigest, createdAt };
    })();
  }

  private verifyStored(): void {
    const active = this.sqlite.prepare(`SELECT a.generation,a.snapshot_digest,s.manifest_json FROM extension_assembly_active a
      JOIN extension_assembly_snapshots s ON s.digest=a.snapshot_digest WHERE a.id=1`).get() as
      { generation: number; snapshot_digest: string; manifest_json: string } | undefined;
    if (!active || active.generation !== this.activation.generation || active.snapshot_digest !== this.activation.digest
      || digest(JSON.parse(active.manifest_json)) !== active.snapshot_digest || active.manifest_json !== canonicalJson(this.manifest)) {
      throw new Error("Extension assembly storage integrity mismatch");
    }
  }

  private initialize(): void {
    this.sqlite.exec(`CREATE TABLE IF NOT EXISTS extension_assembly_profiles (
      kind TEXT NOT NULL,source TEXT NOT NULL,review_version INTEGER NOT NULL,profile_digest TEXT NOT NULL,
      package_bindings_json TEXT NOT NULL,PRIMARY KEY(kind,source,review_version));
      CREATE TABLE IF NOT EXISTS extension_assembly_snapshots (
      digest TEXT PRIMARY KEY,manifest_json TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS extension_assembly_activations (
      generation INTEGER PRIMARY KEY,snapshot_digest TEXT NOT NULL REFERENCES extension_assembly_snapshots(digest),
      previous_digest TEXT,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS extension_assembly_active (
      id INTEGER PRIMARY KEY CHECK(id=1),generation INTEGER NOT NULL REFERENCES extension_assembly_activations(generation),
      snapshot_digest TEXT NOT NULL REFERENCES extension_assembly_snapshots(digest));
      CREATE TABLE IF NOT EXISTS extension_assembly_profile_revocations (
      kind TEXT NOT NULL,source TEXT NOT NULL,profile_digest TEXT NOT NULL,command_id TEXT NOT NULL UNIQUE,
      request_hash TEXT NOT NULL,reason TEXT NOT NULL,audit_json TEXT NOT NULL,PRIMARY KEY(kind,source,profile_digest));
      CREATE TABLE IF NOT EXISTS extension_assembly_profile_rollbacks (
      request_hash TEXT PRIMARY KEY,kind TEXT NOT NULL,source TEXT NOT NULL,from_review_version INTEGER NOT NULL,
      from_profile_digest TEXT NOT NULL,to_review_version INTEGER NOT NULL,to_profile_digest TEXT NOT NULL,
      authorization_ref TEXT NOT NULL,deployment_ref TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS extension_assembly_process_profiles (
      package_key TEXT NOT NULL,source TEXT NOT NULL,profile_digest TEXT NOT NULL,PRIMARY KEY(package_key,source));
      CREATE TABLE IF NOT EXISTS extension_assembly_archives (
      command_id TEXT PRIMARY KEY,request_hash TEXT NOT NULL,first_generation INTEGER NOT NULL,last_generation INTEGER NOT NULL,
      body_digest TEXT NOT NULL,body_bytes INTEGER NOT NULL,compressed_body BLOB NOT NULL,audit_json TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS extension_assembly_archive_index (
      generation INTEGER PRIMARY KEY,command_id TEXT NOT NULL REFERENCES extension_assembly_archives(command_id));
      DROP TRIGGER IF EXISTS extension_assembly_snapshots_delete;
      DROP TRIGGER IF EXISTS extension_assembly_activations_delete;
      CREATE TRIGGER IF NOT EXISTS extension_assembly_profiles_update BEFORE UPDATE ON extension_assembly_profiles BEGIN SELECT RAISE(ABORT,'Extension profile history is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS extension_assembly_profiles_delete BEFORE DELETE ON extension_assembly_profiles BEGIN SELECT RAISE(ABORT,'Extension profile history is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS extension_assembly_snapshots_update BEFORE UPDATE ON extension_assembly_snapshots BEGIN SELECT RAISE(ABORT,'Extension assembly history is immutable'); END;
      CREATE TRIGGER extension_assembly_snapshots_delete BEFORE DELETE ON extension_assembly_snapshots
        WHEN extension_assembly_archive_mode()=0 BEGIN SELECT RAISE(ABORT,'Extension assembly history is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS extension_assembly_activations_update BEFORE UPDATE ON extension_assembly_activations BEGIN SELECT RAISE(ABORT,'Extension assembly history is immutable'); END;
      CREATE TRIGGER extension_assembly_activations_delete BEFORE DELETE ON extension_assembly_activations
        WHEN extension_assembly_archive_mode()=0 BEGIN SELECT RAISE(ABORT,'Extension assembly history is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS extension_assembly_profile_revocations_update BEFORE UPDATE ON extension_assembly_profile_revocations BEGIN SELECT RAISE(ABORT,'Extension revocation history is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS extension_assembly_profile_revocations_delete BEFORE DELETE ON extension_assembly_profile_revocations BEGIN SELECT RAISE(ABORT,'Extension revocation history is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS extension_assembly_profile_rollbacks_update BEFORE UPDATE ON extension_assembly_profile_rollbacks BEGIN SELECT RAISE(ABORT,'Extension rollback history is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS extension_assembly_profile_rollbacks_delete BEFORE DELETE ON extension_assembly_profile_rollbacks BEGIN SELECT RAISE(ABORT,'Extension rollback history is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS extension_assembly_process_profiles_update BEFORE UPDATE ON extension_assembly_process_profiles BEGIN SELECT RAISE(ABORT,'Scenario Process profile history is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS extension_assembly_process_profiles_delete BEFORE DELETE ON extension_assembly_process_profiles BEGIN SELECT RAISE(ABORT,'Scenario Process profile history is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS extension_assembly_archives_update BEFORE UPDATE ON extension_assembly_archives BEGIN SELECT RAISE(ABORT,'Extension assembly archive is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS extension_assembly_archives_delete BEFORE DELETE ON extension_assembly_archives BEGIN SELECT RAISE(ABORT,'Extension assembly archive is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS extension_assembly_archive_index_update BEFORE UPDATE ON extension_assembly_archive_index BEGIN SELECT RAISE(ABORT,'Extension assembly archive index is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS extension_assembly_archive_index_delete BEFORE DELETE ON extension_assembly_archive_index BEGIN SELECT RAISE(ABORT,'Extension assembly archive index is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS extension_assembly_profiles_capacity BEFORE INSERT ON extension_assembly_profiles BEGIN
        SELECT CASE WHEN (SELECT count(*) FROM extension_assembly_profiles)>=2048 OR length(CAST(NEW.package_bindings_json AS BLOB))>65536
          THEN RAISE(ABORT,'Extension profile history capacity exceeded') END;
        SELECT execution_physical_admit(recovery_floor,maximum_database_bytes,maximum_wal_bytes,81920,'recovery') FROM execution_physical_policy WHERE id=1; END;
      CREATE TRIGGER IF NOT EXISTS extension_assembly_snapshots_capacity BEFORE INSERT ON extension_assembly_snapshots BEGIN
        SELECT CASE WHEN (SELECT count(*) FROM extension_assembly_snapshots)>=10000 OR length(CAST(NEW.manifest_json AS BLOB))>524288
          THEN RAISE(ABORT,'Extension assembly history capacity exceeded') END;
        SELECT execution_physical_admit(recovery_floor,maximum_database_bytes,maximum_wal_bytes,length(CAST(NEW.manifest_json AS BLOB))+16384,'recovery') FROM execution_physical_policy WHERE id=1; END;
      CREATE TRIGGER IF NOT EXISTS extension_assembly_activations_capacity BEFORE INSERT ON extension_assembly_activations BEGIN
        SELECT CASE WHEN (SELECT count(*) FROM extension_assembly_activations)>=10000 THEN RAISE(ABORT,'Extension activation history capacity exceeded') END;
        SELECT execution_physical_admit(recovery_floor,maximum_database_bytes,maximum_wal_bytes,16384,'recovery') FROM execution_physical_policy WHERE id=1; END;
      CREATE TRIGGER IF NOT EXISTS extension_assembly_profile_revocations_capacity BEFORE INSERT ON extension_assembly_profile_revocations BEGIN
        SELECT CASE WHEN (SELECT count(*) FROM extension_assembly_profile_revocations)>=4096 OR length(CAST(NEW.audit_json AS BLOB))>8192
          THEN RAISE(ABORT,'Extension revocation history capacity exceeded') END;
        SELECT execution_physical_admit(recovery_floor,maximum_database_bytes,maximum_wal_bytes,24576,'recovery') FROM execution_physical_policy WHERE id=1; END;
      CREATE TRIGGER IF NOT EXISTS extension_assembly_profile_rollbacks_capacity BEFORE INSERT ON extension_assembly_profile_rollbacks BEGIN
        SELECT CASE WHEN (SELECT count(*) FROM extension_assembly_profile_rollbacks)>=2048 THEN RAISE(ABORT,'Extension rollback history capacity exceeded') END;
        SELECT execution_physical_admit(recovery_floor,maximum_database_bytes,maximum_wal_bytes,16384,'recovery') FROM execution_physical_policy WHERE id=1; END;
      CREATE TRIGGER IF NOT EXISTS extension_assembly_process_profiles_capacity BEFORE INSERT ON extension_assembly_process_profiles BEGIN
        SELECT CASE WHEN (SELECT count(*) FROM extension_assembly_process_profiles)>=1024 THEN RAISE(ABORT,'Scenario Process profile capacity exceeded') END;
        SELECT execution_physical_admit(recovery_floor,maximum_database_bytes,maximum_wal_bytes,16384,'recovery') FROM execution_physical_policy WHERE id=1; END;
      CREATE TRIGGER IF NOT EXISTS extension_assembly_archives_capacity BEFORE INSERT ON extension_assembly_archives BEGIN
        SELECT CASE WHEN (SELECT count(*) FROM extension_assembly_archives)>=1024 OR NEW.body_bytes>16777216
          OR length(NEW.compressed_body)>4194304 OR length(CAST(NEW.audit_json AS BLOB))>16384
          THEN RAISE(ABORT,'Extension assembly archive capacity exceeded') END;
        SELECT execution_physical_admit(recovery_floor,maximum_database_bytes,maximum_wal_bytes,length(NEW.compressed_body)+32768,'recovery') FROM execution_physical_policy WHERE id=1; END;`);
  }
}

export function registerExtensionAssemblyRoutes(app: FastifyInstance, control: ExtensionAssemblyControl): void {
  app.get("/api/foundation/extension-assembly", async () => control.snapshot());
  app.get("/api/foundation/extension-assembly/history", async (request, reply) => {
    try {
      const { generation } = z.object({ generation: z.coerce.number().int().positive() }).strict().parse(request.query);
      return control.historyGeneration(generation);
    } catch (error) {
      return reply.code(error instanceof z.ZodError ? 400 : 409)
        .send({ error: error instanceof Error ? error.message : "Extension assembly archive unavailable" });
    }
  });
  app.get("/api/foundation/extension-assembly/profile-revocations", async (request, reply) => {
    try { return control.inspectRevocation(z.object({ commandId: text }).strict().parse(request.query).commandId); }
    catch (error) { return reply.code(error instanceof z.ZodError ? 400 : 409).send({ error: error instanceof Error ? error.message : "Extension revocation unavailable" }); }
  });
  app.post("/api/foundation/extension-assembly/profiles/revoke", async (request, reply) => {
    try { return await control.revokeProfile(request.body); }
    catch (error) { return reply.code(error instanceof z.ZodError ? 400 : 409).send({ error: error instanceof Error ? error.message : "Extension revocation failed" }); }
  });
  app.post("/api/foundation/extension-assembly/history/archive", async (request, reply) => {
    try { return await control.archiveHistory(request.body); }
    catch (error) { return reply.code(error instanceof z.ZodError ? 400 : 409).send({ error: error instanceof Error ? error.message : "Extension assembly archive failed" }); }
  });
}
