import { createHash, randomUUID, verify } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, win32 } from "node:path";
import type Database from "better-sqlite3";
import type { FastifyInstance, FastifyReply } from "fastify";
import {
  assessToolProviderCompatibility,
  validateToolProviderSpec,
  type ExecutionToolDiscoverySource,
  type ExecutionToolSpec,
  type ToolProviderCompatibilityReport,
  type ToolProviderContractSnapshot,
  type ToolInvocationBindingStore,
} from "@traceforge/worker-runtime";
import { ManagedToolProviderPackageStore } from "./tool-provider-package-store.js";

export const TOOL_PROVIDER_MANIFEST_VERSION = 1 as const;
export const TOOL_PROVIDER_PROTOCOL_VERSION = 1 as const;

export type ToolProviderInstallState =
  | "installed"
  | "enabled"
  | "draining"
  | "disabled"
  | "quarantined"
  | "failed"
  | "collected";

export interface ToolProviderManifest {
  schemaVersion: typeof TOOL_PROVIDER_MANIFEST_VERSION;
  providerId: string;
  source: string;
  version: string;
  protocolVersion: typeof TOOL_PROVIDER_PROTOCOL_VERSION;
  entrypoint: {
    executable: string;
    arguments: string[];
    workingDirectory: string;
  };
  artifact: { sha256: string; packageSha256: string };
  capabilities: string[];
  tools: ExecutionToolSpec[];
  permissions: {
    network: "deny" | "brokered";
    filesystem: "none" | "read_only" | "scoped_write";
    process: "sandboxed";
    secrets: "none" | "handles_only";
  };
  resources: {
    cpuTimeMs: number;
    memoryBytes: number;
    maximumProcesses: number;
    maximumWriteBytes: number;
  };
  platforms: string[];
}

export interface ToolProviderSignature {
  algorithm: "ed25519";
  keyId: string;
  value: string;
}

export interface ToolProviderInstallation {
  manifest: ToolProviderManifest;
  packageRoot: string;
  manifestFingerprint: string;
  signerId: string;
  signature: ToolProviderSignature;
  state: ToolProviderInstallState;
  stateReason: string | null;
  installedAt: string;
  updatedAt: string;
}

export interface ToolProviderAuditEvent {
  id: string;
  sequence: number;
  providerId: string;
  version: string;
  type: "installed" | "enabled" | "draining" | "disabled" | "quarantined" | "failed" | "rolled_back" | "collected";
  fromState: ToolProviderInstallState | null;
  toState: ToolProviderInstallState;
  reason: string | null;
  actor: string;
  commandId: string;
  createdAt: string;
}

export interface ToolProviderCompatibilityAudit {
  id: string;
  commandId: string;
  actor: string;
  assessedAt: string;
  report: ToolProviderCompatibilityReport;
}

export interface ToolProviderRuntimeBinding {
  activate(installation: ToolProviderInstallation): Promise<{ drained: Promise<void> } | void>;
  deactivate(source: string): Promise<void>;
  drain(source: string): Promise<void>;
}

interface ManifestRow {
  provider_id: string;
  version: string;
  manifest_json: string;
  package_root: string;
  manifest_fingerprint: string;
  signer_id: string;
  signature_base64: string;
  state: ToolProviderInstallState;
  state_reason: string | null;
  installed_at: string;
  updated_at: string;
}

interface EventRow {
  sequence: number;
  id: string;
  provider_id: string;
  version: string;
  event_type: ToolProviderAuditEvent["type"];
  from_state: ToolProviderInstallState | null;
  to_state: ToolProviderInstallState;
  reason: string | null;
  actor: string;
  command_id: string;
  created_at: string;
}

interface CompatibilityRow {
  id: string;
  provider_id: string;
  from_version: string;
  to_version: string;
  classification: ToolProviderCompatibilityReport["classification"];
  report_fingerprint: string;
  report_json: string;
  command_id: string;
  actor: string;
  assessed_at: string;
}

export class ToolProviderControlError extends Error {
  constructor(message: string, readonly statusCode: 400 | 404 | 409 = 400) {
    super(message);
    this.name = "ToolProviderControlError";
  }
}

export class SqliteToolProviderControlStore {
  constructor(private readonly sqlite: Database.Database) {}

  list(): ToolProviderInstallation[] {
    return (this.sqlite.prepare(`
      SELECT provider_id, version, manifest_json, package_root, manifest_fingerprint, signer_id, signature_base64,
             state, state_reason, installed_at, updated_at
      FROM tool_provider_manifests ORDER BY provider_id ASC, installed_at DESC, version DESC
    `).all() as ManifestRow[]).map(parseInstallation);
  }

  get(providerId: string, version: string): ToolProviderInstallation | null {
    const row = this.sqlite.prepare(`
      SELECT provider_id, version, manifest_json, package_root, manifest_fingerprint, signer_id, signature_base64,
             state, state_reason, installed_at, updated_at
      FROM tool_provider_manifests WHERE provider_id = ? AND version = ?
    `).get(providerId, version) as ManifestRow | undefined;
    return row ? parseInstallation(row) : null;
  }

  listEvents(providerId?: string): ToolProviderAuditEvent[] {
    const rows = (providerId
      ? this.sqlite.prepare(`SELECT * FROM tool_provider_events WHERE provider_id = ? ORDER BY sequence ASC`).all(providerId)
      : this.sqlite.prepare(`SELECT * FROM tool_provider_events ORDER BY sequence ASC`).all()) as EventRow[];
    return rows.map(parseEvent);
  }

  listCompatibility(providerId?: string): ToolProviderCompatibilityAudit[] {
    const rows = (providerId
      ? this.sqlite.prepare("SELECT * FROM tool_provider_compatibility_audits WHERE provider_id = ? ORDER BY assessed_at ASC, id ASC").all(providerId)
      : this.sqlite.prepare("SELECT * FROM tool_provider_compatibility_audits ORDER BY assessed_at ASC, id ASC").all()) as CompatibilityRow[];
    return rows.map(parseCompatibilityAudit);
  }

  recordCompatibility(report: ToolProviderCompatibilityReport, commandId: string, actor: string, assessedAt: string): ToolProviderCompatibilityAudit {
    const reportJson = canonicalJson(report);
    const reportFingerprint = fingerprint(report);
    const existing = this.sqlite.prepare("SELECT * FROM tool_provider_compatibility_audits WHERE command_id = ?").get(commandId) as CompatibilityRow | undefined;
    if (existing) {
      if (existing.report_fingerprint !== reportFingerprint) {
        throw new ToolProviderControlError(`Compatibility command ${commandId} was already used with a different report`, 409);
      }
      return parseCompatibilityAudit(existing);
    }
    const id = randomUUID();
    this.sqlite.prepare(`
      INSERT INTO tool_provider_compatibility_audits
        (id, provider_id, from_version, to_version, classification, report_fingerprint, report_json, command_id, actor, assessed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, report.providerId, report.fromVersion, report.toVersion, report.classification,
      reportFingerprint, reportJson, commandId, required(actor, "actor"), assessedAt,
    );
    return this.listCompatibility(report.providerId).find((audit) => audit.id === id)!;
  }

  findCommand(commandId: string): ToolProviderInstallation | null {
    const row = this.sqlite.prepare(`
      SELECT m.provider_id, m.version, m.manifest_json, m.package_root, m.manifest_fingerprint, m.signer_id,
             m.signature_base64, m.state, m.state_reason, m.installed_at, m.updated_at
      FROM tool_provider_commands c
      JOIN tool_provider_manifests m ON m.provider_id = c.provider_id AND m.version = c.version
      WHERE c.command_id = ?
    `).get(commandId) as ManifestRow | undefined;
    if (!row) return null;
    const installation = parseInstallation(row);
    const event = this.sqlite.prepare(`
      SELECT to_state, reason, created_at FROM tool_provider_events WHERE command_id = ?
    `).get(commandId) as { to_state: ToolProviderInstallState; reason: string | null; created_at: string } | undefined;
    return event ? { ...installation, state: event.to_state, stateReason: event.reason, updatedAt: event.created_at } : installation;
  }

  commandFingerprint(commandId: string): string | null {
    return (this.sqlite.prepare("SELECT fingerprint FROM tool_provider_commands WHERE command_id = ?").get(commandId) as { fingerprint: string } | undefined)?.fingerprint ?? null;
  }

  install(input: {
    manifest: ToolProviderManifest;
    packageRoot: string;
    fingerprint: string;
    signature: ToolProviderSignature;
    commandFingerprint: string;
    actor: string;
    commandId: string;
    at: string;
  }): ToolProviderInstallation {
    const existing = this.get(input.manifest.providerId, input.manifest.version);
    if (existing) {
      if (existing.manifestFingerprint !== input.fingerprint || existing.signature.value !== input.signature.value || existing.packageRoot !== input.packageRoot) {
        throw new ToolProviderControlError(`Provider ${input.manifest.providerId} version ${input.manifest.version} is already installed with different content`, 409);
      }
      this.sqlite.transaction(() => {
        if (existing.state === "collected") {
          this.sqlite.prepare(`
            UPDATE tool_provider_manifests SET state = 'installed', state_reason = NULL, updated_at = ?
            WHERE provider_id = ? AND version = ?
          `).run(input.at, input.manifest.providerId, input.manifest.version);
        }
        this.recordCommand(input.commandId, input.commandFingerprint, input.manifest.providerId, input.manifest.version, input.at);
        this.appendEvent(
          input.manifest.providerId, input.manifest.version, "installed", existing.state,
          existing.state === "collected" ? "installed" : existing.state,
          existing.state === "collected" ? "identical signed package restored after collection" : "identical signed manifest already installed",
          input.actor, input.commandId, input.at,
        );
      })();
      return this.get(input.manifest.providerId, input.manifest.version)!;
    }
    const sourceOwner = this.sqlite.prepare(`
      SELECT provider_id FROM tool_provider_manifests WHERE json_extract(manifest_json, '$.source') = ? LIMIT 1
    `).get(input.manifest.source) as { provider_id: string } | undefined;
    if (sourceOwner && sourceOwner.provider_id !== input.manifest.providerId) {
      throw new ToolProviderControlError(`Provider source ${input.manifest.source} is already owned by ${sourceOwner.provider_id}`, 409);
    }
    this.sqlite.transaction(() => {
      this.sqlite.prepare(`
        INSERT INTO tool_provider_manifests
          (provider_id, version, manifest_json, package_root, manifest_fingerprint, signer_id, signature_base64,
           state, state_reason, installed_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'installed', NULL, ?, ?)
      `).run(
        input.manifest.providerId, input.manifest.version, canonicalJson(input.manifest), input.packageRoot, input.fingerprint,
        input.signature.keyId, input.signature.value, input.at, input.at,
      );
      this.recordCommand(input.commandId, input.commandFingerprint, input.manifest.providerId, input.manifest.version, input.at);
      this.appendEvent(input.manifest.providerId, input.manifest.version, "installed", null, "installed", null, input.actor, input.commandId, input.at);
    })();
    return this.get(input.manifest.providerId, input.manifest.version)!;
  }

  activateVersion(input: {
    providerId: string;
    version: string;
    previous: ToolProviderInstallation[];
    eventType: "enabled" | "rolled_back";
    reason: string | null;
    actor: string;
    commandId: string;
    fingerprint: string;
    at: string;
  }): ToolProviderInstallation {
    const target = this.get(input.providerId, input.version);
    if (!target) throw new ToolProviderControlError(`Unknown Provider ${input.providerId} version ${input.version}`, 404);
    this.sqlite.transaction(() => {
      for (const previous of input.previous) {
        const willDrain = previous.state === "enabled";
        const commandId = `${input.commandId}:${willDrain ? "drain" : "retire"}:${previous.manifest.version}`;
        const reason = input.eventType === "rolled_back"
          ? `rollback to ${input.version}: ${input.reason ?? "operator requested"}`
          : `superseded by ${input.version}`;
        this.sqlite.prepare(`
          UPDATE tool_provider_manifests SET state = ?, state_reason = ?, updated_at = ?
          WHERE provider_id = ? AND version = ?
        `).run(willDrain ? "draining" : "disabled", reason, input.at, input.providerId, previous.manifest.version);
        this.recordCommand(commandId, fingerprint({ action: willDrain ? "activation-drain" : "activation-retire", parent: input.fingerprint, version: previous.manifest.version }), input.providerId, previous.manifest.version, input.at);
        this.appendEvent(
          input.providerId, previous.manifest.version, willDrain ? "draining" : "disabled", previous.state, willDrain ? "draining" : "disabled",
          reason, input.actor, commandId, input.at,
        );
      }
      this.sqlite.prepare(`
        UPDATE tool_provider_manifests SET state = 'enabled', state_reason = ?, updated_at = ?
        WHERE provider_id = ? AND version = ?
      `).run(input.reason, input.at, input.providerId, input.version);
      this.recordCommand(input.commandId, input.fingerprint, input.providerId, input.version, input.at);
      this.appendEvent(
        input.providerId, input.version, input.eventType, target.state, "enabled",
        input.reason, input.actor, input.commandId, input.at,
      );
    })();
    return this.get(input.providerId, input.version)!;
  }

  transition(input: {
    providerId: string;
    version: string;
    toState: ToolProviderInstallState;
    eventType: ToolProviderAuditEvent["type"];
    reason: string | null;
    actor: string;
    commandId: string;
    fingerprint: string;
    at: string;
  }): ToolProviderInstallation {
    const current = this.get(input.providerId, input.version);
    if (!current) throw new ToolProviderControlError(`Unknown Provider ${input.providerId} version ${input.version}`, 404);
    this.sqlite.transaction(() => {
      this.sqlite.prepare(`
        UPDATE tool_provider_manifests SET state = ?, state_reason = ?, updated_at = ?
        WHERE provider_id = ? AND version = ?
      `).run(input.toState, input.reason, input.at, input.providerId, input.version);
      this.recordCommand(input.commandId, input.fingerprint, input.providerId, input.version, input.at);
      this.appendEvent(
        input.providerId, input.version, input.eventType, current.state, input.toState,
        input.reason, input.actor, input.commandId, input.at,
      );
    })();
    return this.get(input.providerId, input.version)!;
  }

  markPackageCollected(providerId: string, version: string, packageRoot: string, reason: string, at: string): ToolProviderInstallation {
    const current = this.get(providerId, version);
    if (!current) throw new ToolProviderControlError(`Unknown Provider ${providerId} version ${version}`, 404);
    if (current.packageRoot !== packageRoot) throw new ToolProviderControlError("Tool Provider package collection target changed", 409);
    if (current.state === "collected") return current;
    if (current.state !== "disabled" && current.state !== "failed") {
      throw new ToolProviderControlError(`Provider ${providerId}@${version} cannot collect package from state ${current.state}`, 409);
    }
    const commandId = `provider-gc:${providerId}:${version}:${createHash("sha256").update(`${packageRoot}\0${at}`).digest("hex")}`;
    return this.transition({
      providerId, version, toState: "collected", eventType: "collected", reason,
      actor: "provider-garbage-collector", commandId,
      fingerprint: fingerprint({ action: "collect-package", providerId, version, packageRoot, at }), at,
    });
  }

  private recordCommand(commandId: string, fingerprint: string, providerId: string, version: string, at: string): void {
    this.sqlite.prepare(`
      INSERT INTO tool_provider_commands (command_id, fingerprint, provider_id, version, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(commandId, fingerprint, providerId, version, at);
  }

  private appendEvent(
    providerId: string,
    version: string,
    type: ToolProviderAuditEvent["type"],
    fromState: ToolProviderInstallState | null,
    toState: ToolProviderInstallState,
    reason: string | null,
    actor: string,
    commandId: string,
    at: string,
  ): void {
    this.sqlite.prepare(`
      INSERT INTO tool_provider_events
        (id, provider_id, version, event_type, from_state, to_state, reason, actor, command_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), providerId, version, type, fromState, toState, reason, actor, commandId, at);
  }
}

export class ToolProviderControlPlane {
  private readonly operationTails = new Map<string, Promise<void>>();

  constructor(
    private readonly store: SqliteToolProviderControlStore,
    private readonly trustRoots: ReadonlyMap<string, string>,
    private readonly runtime: ToolProviderRuntimeBinding,
    private readonly packages: ManagedToolProviderPackageStore,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly invocationBindings?: Pick<ToolInvocationBindingStore, "hasOpenBindings" | "closeAdmission" | "openAdmission">,
  ) {}

  list(): ToolProviderInstallation[] { return this.store.list(); }
  listEvents(providerId?: string): ToolProviderAuditEvent[] { return this.store.listEvents(providerId); }
  listCompatibility(providerId?: string): ToolProviderCompatibilityAudit[] { return this.store.listCompatibility(providerId); }

  async recover(): Promise<{ enabled: string[]; failed: string[] }> {
    const enabled: string[] = [];
    const failed: string[] = [];
    const interruptedDrains = this.store.list().filter((entry) => entry.state === "draining");
    const recoverable: ToolProviderInstallation[] = [];
    const grouped = new Map<string, ToolProviderInstallation[]>();
    for (const installation of this.store.list().filter((entry) => entry.state === "enabled")) {
      const versions = grouped.get(installation.manifest.providerId) ?? [];
      versions.push(installation);
      grouped.set(installation.manifest.providerId, versions);
    }
    for (const versions of grouped.values()) {
      versions.sort((left, right) => compareVersions(right.manifest.version, left.manifest.version));
      recoverable.push(versions[0]!);
      for (const duplicate of versions.slice(1)) {
        const reason = `multiple enabled versions detected; ${versions[0]!.manifest.version} retained`;
        await this.closeAdmission(duplicate, reason);
        this.store.transition({
          providerId: duplicate.manifest.providerId, version: duplicate.manifest.version,
          toState: "failed", eventType: "failed", reason, actor: "startup-recovery",
          commandId: randomUUID(), fingerprint: fingerprint({ action: "recovery-duplicate", reason }), at: this.now(),
        });
        failed.push(`${duplicate.manifest.providerId}@${duplicate.manifest.version}`);
      }
    }
    for (const installation of recoverable) {
      try {
        this.verifyInstallation(installation.manifest, installation.signature, installation.packageRoot);
        await this.openAdmission(installation);
        const activation = await this.runtime.activate(installation);
        await activation?.drained;
        enabled.push(`${installation.manifest.providerId}@${installation.manifest.version}`);
      } catch (error) {
        await this.closeAdmission(installation, "startup activation failed");
        const reason = message(error);
        this.store.transition({
          providerId: installation.manifest.providerId, version: installation.manifest.version,
          toState: "failed", eventType: "failed", reason, actor: "startup-recovery",
          commandId: randomUUID(), fingerprint: fingerprint({ action: "recovery-failed", reason }), at: this.now(),
        });
        failed.push(`${installation.manifest.providerId}@${installation.manifest.version}`);
      }
    }
    for (const installation of interruptedDrains) {
      const reason = "startup recovery reconciled an interrupted drain; no invocation process is adopted across host restart";
      await this.closeAdmission(installation, reason);
      this.store.transition({
        providerId: installation.manifest.providerId, version: installation.manifest.version,
        toState: "disabled", eventType: "disabled", reason, actor: "startup-recovery",
        commandId: randomUUID(), fingerprint: fingerprint({ action: "recovery-drain", reason }), at: this.now(),
      });
    }
    return { enabled, failed };
  }

  install(manifestValue: unknown, signatureValue: unknown, packageRootValue: unknown, actor: string, commandId: string): ToolProviderInstallation {
    const replay = this.replay(commandId, { action: "install", manifestValue, signatureValue, packageRootValue });
    if (replay) return replay;
    const manifest = validateToolProviderManifest(manifestValue);
    const signature = validateToolProviderSignature(signatureValue);
    const importRoot = validatePackageRoot(packageRootValue);
    const manifestFingerprint = this.verifyInstallation(manifest, signature, importRoot);
    const packageRoot = this.packages.publish(
      importRoot, manifest.providerId, manifest.version, manifest.artifact.packageSha256,
    );
    this.verifyInstallation(manifest, signature, packageRoot);
    return this.store.install({
      manifest, packageRoot, fingerprint: manifestFingerprint, signature, actor: required(actor, "actor"),
      commandId: required(commandId, "commandId"),
      commandFingerprint: fingerprint({ action: "install", manifestValue, signatureValue, packageRootValue }), at: this.now(),
    });
  }

  async enable(providerId: string, version: string, actor: string, commandId: string): Promise<ToolProviderInstallation> {
    return this.serialize(providerId, () => this.enableLocked(providerId, version, actor, commandId));
  }

  private async enableLocked(providerId: string, version: string, actor: string, commandId: string): Promise<ToolProviderInstallation> {
    const command = { action: "enable", providerId, version };
    const replay = this.replay(commandId, command);
    if (replay) return replay;
    const installation = this.require(providerId, version);
    if (installation.state === "quarantined") throw new ToolProviderControlError("A quarantined Provider must be explicitly reinstalled or rolled back", 409);
    if (!["installed", "disabled", "failed", "draining", "enabled"].includes(installation.state)) {
      throw new ToolProviderControlError(`Provider ${providerId}@${version} cannot be enabled from state ${installation.state}`, 409);
    }
    const newer = this.store.list().find((entry) =>
      entry.manifest.providerId === providerId && compareVersions(entry.manifest.version, version) > 0,
    );
    if (newer) throw new ToolProviderControlError(`Refusing implicit downgrade from ${newer.manifest.version} to ${version}; use rollback`, 409);
    this.verifyInstallation(installation.manifest, installation.signature, installation.packageRoot);
    const previous = this.store.list().filter((entry) =>
      entry.manifest.providerId === providerId && entry.manifest.version !== version && entry.state === "enabled",
    );
    const fenced: ToolProviderInstallation[] = [];
    try {
      for (const current of previous) {
        await this.fenceAndAssertNoOpenBindings(current, "upgrade");
        fenced.push(current);
        const report = assessToolProviderCompatibility(manifestContract(current.manifest), manifestContract(installation.manifest));
        this.store.recordCompatibility(
          report, `${required(commandId, "commandId")}:compatibility:${current.manifest.version}`, required(actor, "actor"), this.now(),
        );
        if (report.classification === "breaking") {
          const breaking = report.changes.filter((change) => change.classification === "breaking").map((change) => change.code).join(", ");
          throw new ToolProviderControlError(`Provider upgrade is contract-breaking: ${breaking}`, 409);
        }
      }
    } catch (error) {
      await this.reopenAdmissions(fenced);
      throw error;
    }
    let activation: { drained: Promise<void> } | void;
    try {
      await this.openAdmission(installation);
      activation = await this.runtime.activate(installation);
    } catch (error) {
      await this.closeAdmission(installation, "activation failed");
      await this.reopenAdmissions(fenced);
      return this.failActivation(installation, actor, commandId, command, message(error));
    }
    const at = this.now();
    const enabled = this.store.activateVersion({
      providerId, version, previous, eventType: "enabled", reason: null,
      actor: required(actor, "actor"), commandId: required(commandId, "commandId"), fingerprint: fingerprint(command), at,
    });
    await this.finishDrain(previous, activation?.drained ?? Promise.resolve(), actor, commandId, command, `superseded by ${version}`);
    return enabled;
  }

  async drain(providerId: string, version: string, reason: string, actor: string, commandId: string): Promise<ToolProviderInstallation> {
    return this.serialize(providerId, () => this.changeState(
      "drain", providerId, version, "draining", "draining", reason, actor, commandId,
      async (installation) => {
        await this.fenceAndAssertNoOpenBindings(installation, "drain");
        try { await this.runtime.drain(installation.manifest.source); }
        catch (error) { await this.openAdmission(installation); throw error; }
      },
    ));
  }

  async disable(providerId: string, version: string, reason: string, actor: string, commandId: string): Promise<ToolProviderInstallation> {
    return this.serialize(providerId, () => this.changeState(
      "disable", providerId, version, "disabled", "disabled", reason, actor, commandId,
      async (installation) => {
        if (installation.state === "enabled" || installation.state === "draining") {
          await this.fenceAndAssertNoOpenBindings(installation, "disable");
          try { await this.runtime.deactivate(installation.manifest.source); }
          catch (error) { await this.openAdmission(installation); throw error; }
        }
      },
    ));
  }

  async quarantine(providerId: string, version: string, reason: string, actor: string, commandId: string): Promise<ToolProviderInstallation> {
    return this.serialize(providerId, () => this.changeState(
      "quarantine", providerId, version, "quarantined", "quarantined", reason, actor, commandId,
      async (installation) => {
        await this.closeAdmission(installation, `quarantine: ${reason}`);
        if (installation.state === "enabled" || installation.state === "draining") {
          await this.runtime.deactivate(installation.manifest.source);
        }
      },
    ));
  }

  async rollback(providerId: string, fromVersion: string, toVersion: string, reason: string, actor: string, commandId: string): Promise<ToolProviderInstallation> {
    return this.serialize(providerId, () => this.rollbackLocked(providerId, fromVersion, toVersion, reason, actor, commandId));
  }

  private async rollbackLocked(providerId: string, fromVersion: string, toVersion: string, reason: string, actor: string, commandId: string): Promise<ToolProviderInstallation> {
    const command = { action: "rollback", providerId, fromVersion, toVersion, reason };
    const replay = this.replay(commandId, command);
    if (replay) return replay;
    const current = this.require(providerId, fromVersion);
    const target = this.require(providerId, toVersion);
    if (compareVersions(fromVersion, toVersion) <= 0) throw new ToolProviderControlError("Rollback target must be an older Provider version", 409);
    if (current.state !== "enabled" && current.state !== "failed" && current.state !== "quarantined") {
      throw new ToolProviderControlError(`Provider ${providerId}@${fromVersion} cannot be rolled back from state ${current.state}`, 409);
    }
    if (target.state !== "installed" && target.state !== "disabled") {
      throw new ToolProviderControlError(`Rollback target ${providerId}@${toVersion} is not eligible from state ${target.state}`, 409);
    }
    this.verifyInstallation(target.manifest, target.signature, target.packageRoot);
    await this.fenceAndAssertNoOpenBindings(current, "rollback");
    const report = assessToolProviderCompatibility(manifestContract(current.manifest), manifestContract(target.manifest));
    this.store.recordCompatibility(
      report, `${required(commandId, "commandId")}:compatibility:${fromVersion}`, required(actor, "actor"), this.now(),
    );
    let activation: { drained: Promise<void> } | void;
    try {
      await this.openAdmission(target);
      activation = await this.runtime.activate(target);
    } catch (error) {
      await this.closeAdmission(target, "rollback activation failed");
      if (current.state === "enabled") await this.openAdmission(current);
      throw error;
    }
    const at = this.now();
    const rolledBack = this.store.activateVersion({
      providerId, version: toVersion, previous: [current], eventType: "rolled_back", reason: required(reason, "reason"),
      actor: required(actor, "actor"), commandId: required(commandId, "commandId"), fingerprint: fingerprint(command), at,
    });
    await this.finishDrain(current.state === "enabled" ? [current] : [], activation?.drained ?? Promise.resolve(), actor, commandId, command, reason);
    return rolledBack;
  }

  private async finishDrain(
    previous: ToolProviderInstallation[],
    drained: Promise<void>,
    actor: string,
    commandId: string,
    command: Record<string, unknown>,
    reason: string,
  ): Promise<void> {
    if (!previous.length) return;
    try {
      await drained;
      for (const installation of previous) {
        this.store.transition({
          providerId: installation.manifest.providerId, version: installation.manifest.version,
          toState: "disabled", eventType: "disabled", reason,
          actor: required(actor, "actor"), commandId: `${commandId}:drained:${installation.manifest.version}`,
          fingerprint: fingerprint({ ...command, drained: installation.manifest.version }), at: this.now(),
        });
      }
    } catch (error) {
      const failure = `Provider drain cleanup failed: ${message(error)}`;
      for (const installation of previous) {
        this.store.transition({
          providerId: installation.manifest.providerId, version: installation.manifest.version,
          toState: "failed", eventType: "failed", reason: failure,
          actor: required(actor, "actor"), commandId: `${commandId}:drain-failed:${installation.manifest.version}`,
          fingerprint: fingerprint({ ...command, drainFailed: installation.manifest.version, failure }), at: this.now(),
        });
      }
      throw new ToolProviderControlError(failure, 409);
    }
  }

  private async serialize<T>(providerId: string, operation: () => Promise<T>): Promise<T> {
    const key = required(providerId, "providerId");
    const previous = this.operationTails.get(key) ?? Promise.resolve();
    const current = previous.then(operation, operation);
    const tail = current.then(() => undefined, () => undefined);
    this.operationTails.set(key, tail);
    try { return await current; }
    finally {
      if (this.operationTails.get(key) === tail) this.operationTails.delete(key);
    }
  }

  private async changeState(
    action: string,
    providerId: string,
    version: string,
    state: ToolProviderInstallState,
    eventType: ToolProviderAuditEvent["type"],
    reason: string,
    actor: string,
    commandId: string,
    effect: (installation: ToolProviderInstallation) => Promise<void>,
  ): Promise<ToolProviderInstallation> {
    const command = { action, providerId, version, reason };
    const replay = this.replay(commandId, command);
    if (replay) return replay;
    const current = this.require(providerId, version);
    if (action === "drain" && current.state !== "enabled") {
      throw new ToolProviderControlError(`Provider ${providerId}@${version} can only drain from enabled state`, 409);
    }
    if (action === "disable" && current.state === "quarantined") {
      throw new ToolProviderControlError(`Quarantined Provider ${providerId}@${version} cannot be disabled without remediation`, 409);
    }
    await effect(current);
    return this.store.transition({
      providerId, version, toState: state, eventType, reason: required(reason, "reason"), actor: required(actor, "actor"),
      commandId: required(commandId, "commandId"), fingerprint: fingerprint(command), at: this.now(),
    });
  }

  private failActivation(
    installation: ToolProviderInstallation,
    actor: string,
    commandId: string,
    command: Record<string, unknown>,
    reason: string,
  ): ToolProviderInstallation {
    return this.store.transition({
      providerId: installation.manifest.providerId, version: installation.manifest.version,
      toState: "failed", eventType: "failed", reason, actor: required(actor, "actor"),
      commandId: required(commandId, "commandId"), fingerprint: fingerprint(command), at: this.now(),
    });
  }

  private async fenceAndAssertNoOpenBindings(installation: ToolProviderInstallation, action: string): Promise<void> {
    await this.closeAdmission(installation, `${action} admission fence`);
    if (await this.invocationBindings?.hasOpenBindings(installation.manifest.source, installation.manifest.version)) {
      await this.openAdmission(installation);
      throw new ToolProviderControlError(
        `Provider ${installation.manifest.providerId}@${installation.manifest.version} has unfinished Tool Invocation bindings and cannot ${action}`,
        409,
      );
    }
  }

  private async closeAdmission(installation: ToolProviderInstallation, reason: string): Promise<void> {
    await this.invocationBindings?.closeAdmission(installation.manifest.source, installation.manifest.version, reason);
  }

  private async openAdmission(installation: ToolProviderInstallation): Promise<void> {
    await this.invocationBindings?.openAdmission(installation.manifest.source, installation.manifest.version);
  }

  private async reopenAdmissions(installations: ToolProviderInstallation[]): Promise<void> {
    await Promise.all(installations.map((installation) => this.openAdmission(installation)));
  }

  private replay(commandId: string, command: unknown): ToolProviderInstallation | null {
    required(commandId, "commandId");
    const existing = this.store.findCommand(commandId);
    if (!existing) return null;
    const expected = fingerprint(command);
    const recorded = this.store.commandFingerprint(commandId);
    if (recorded !== expected) throw new ToolProviderControlError(`Command ${commandId} was already used with different input`, 409);
    return existing;
  }

  private require(providerId: string, version: string): ToolProviderInstallation {
    const installation = this.store.get(required(providerId, "providerId"), required(version, "version"));
    if (!installation) throw new ToolProviderControlError(`Unknown Provider ${providerId} version ${version}`, 404);
    return installation;
  }

  private verifyInstallation(manifest: ToolProviderManifest, signature: ToolProviderSignature, packageRoot: string): string {
    const key = this.trustRoots.get(signature.keyId);
    if (!key) throw new ToolProviderControlError(`Unknown Tool Provider signing key ${signature.keyId}`);
    if (!manifest.platforms.includes(process.platform)) {
      throw new ToolProviderControlError(`Tool Provider does not support platform ${process.platform}`);
    }
    const bytes = Buffer.from(canonicalJson(manifest), "utf8");
    let signatureBytes: Buffer;
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(signature.value) || signature.value.length % 4 !== 0) {
      throw new ToolProviderControlError("Tool Provider signature is not valid base64");
    }
    signatureBytes = Buffer.from(signature.value, "base64");
    if (!signatureBytes.length || !verify(null, bytes, key, signatureBytes)) throw new ToolProviderControlError("Tool Provider manifest signature verification failed");
    let file: Buffer;
    try {
      const entrypoint = resolveToolProviderEntrypoint(manifest, packageRoot);
      const executable = statSync(entrypoint.executable);
      if (!executable.isFile()) throw new Error("executable is not a file");
      if (process.platform !== "win32" && (executable.mode & 0o111) === 0) throw new Error("executable permission is missing");
      if (!statSync(entrypoint.workingDirectory).isDirectory()) throw new Error("working directory is not a directory");
      file = readFileSync(entrypoint.executable);
    } catch (error) {
      throw new ToolProviderControlError(`Tool Provider entrypoint cannot be verified: ${message(error)}`);
    }
    const actualHash = createHash("sha256").update(file).digest("hex");
    if (actualHash !== manifest.artifact.sha256) throw new ToolProviderControlError("Tool Provider executable hash does not match the signed manifest");
    const packageInventory = this.packages.inspect(packageRoot);
    if (packageInventory.digest !== manifest.artifact.packageSha256) {
      throw new ToolProviderControlError("Tool Provider package digest does not match the signed manifest");
    }
    return createHash("sha256").update(bytes).digest("hex");
  }
}

export function registerToolProviderControlRoutes(
  app: FastifyInstance,
  control: ToolProviderControlPlane,
  options: { allowLocalPackageInstall?: boolean } = {},
): void {
  app.get("/api/security-tools/providers", async () => ({ providers: control.list() }));
  app.get("/api/security-tools/providers/events", async (request) => {
    const providerId = (request.query as { providerId?: string }).providerId;
    return { events: control.listEvents(providerId) };
  });
  app.get("/api/security-tools/providers/compatibility", async (request) => {
    const providerId = (request.query as { providerId?: string }).providerId;
    return { audits: control.listCompatibility(providerId) };
  });
  if (options.allowLocalPackageInstall) {
    app.post("/api/security-tools/providers/install", async (request, reply) => {
      try {
        const body = request.body as { manifest?: unknown; signature?: unknown; packageRoot?: unknown; actor?: string; commandId?: string };
        return reply.code(201).send(control.install(body.manifest, body.signature, body.packageRoot, body.actor ?? "", body.commandId ?? ""));
      } catch (error) { return controlError(reply, error); }
    });
  }
  for (const action of ["enable", "drain", "disable", "quarantine"] as const) {
    app.post(`/api/security-tools/providers/:providerId/versions/:version/${action}`, async (request, reply) => {
      try {
        const { providerId, version } = request.params as { providerId: string; version: string };
        const body = request.body as { actor?: string; commandId?: string; reason?: string };
        const result = action === "enable"
          ? await control.enable(providerId, version, body.actor ?? "", body.commandId ?? "")
          : await control[action](providerId, version, body.reason ?? "", body.actor ?? "", body.commandId ?? "");
        return reply.send(result);
      } catch (error) { return controlError(reply, error); }
    });
  }
  app.post("/api/security-tools/providers/:providerId/rollback", async (request, reply) => {
    try {
      const { providerId } = request.params as { providerId: string };
      const body = request.body as { fromVersion?: string; toVersion?: string; actor?: string; commandId?: string; reason?: string };
      return reply.send(await control.rollback(
        providerId, body.fromVersion ?? "", body.toVersion ?? "", body.reason ?? "", body.actor ?? "", body.commandId ?? "",
      ));
    } catch (error) { return controlError(reply, error); }
  });
}

export function createToolProviderRuntimeBinding(
  activateSource: (source: ExecutionToolDiscoverySource) => Promise<{ drained: Promise<void> } | void>,
  deactivateSource: (source: string) => Promise<void>,
  drainSource: (source: string) => void,
  sourceFactory?: (installation: ToolProviderInstallation) => Promise<ExecutionToolDiscoverySource> | ExecutionToolDiscoverySource,
): ToolProviderRuntimeBinding {
  return {
    async activate(installation) {
      if (!sourceFactory) throw new Error("No managed Tool Provider source factory is configured");
      const { manifest } = installation;
      const source = await sourceFactory(installation);
      if (source.source !== manifest.source) throw new Error(`Managed Tool Provider source must be ${manifest.source}`);
      const constrained: ExecutionToolDiscoverySource = {
        source: source.source,
        async discover() {
          const tools = await source.discover();
          for (const tool of tools) {
            if (tool.source !== manifest.source || tool.version !== manifest.version) {
              throw new Error(`Tool ${tool.name} does not match its signed Provider identity`);
            }
            const undeclared = tool.providedCapabilities.filter((capability) => !manifest.capabilities.includes(capability));
            if (undeclared.length) throw new Error(`Tool ${tool.name} exposes undeclared capabilities: ${undeclared.join(", ")}`);
            assertToolPermissions(tool.name, tool.permissionRequirements, manifest);
          }
          return tools;
        },
        close: () => source.close?.() ?? Promise.resolve(),
        diagnostics: () => source.diagnostics?.() ?? {},
      };
      return await activateSource(constrained);
    },
    deactivate: deactivateSource,
    async drain(source) { drainSource(source); },
  };
}

export function loadToolProviderTrustRoots(path: string): ReadonlyMap<string, string> {
  if (!existsSync(path)) return new Map();
  const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!isRecord(value) || !isRecord(value.keys)) throw new ToolProviderControlError("Tool Provider trust root file must contain a keys object");
  const roots = new Map<string, string>();
  for (const [keyId, publicKey] of Object.entries(value.keys)) {
    roots.set(identifier(keyId, "trust root key id"), requiredString(publicKey, `trust root ${keyId}`));
  }
  return roots;
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new ToolProviderControlError("Manifest contains a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  throw new ToolProviderControlError("Manifest contains an unsupported value");
}

export function validateToolProviderManifest(value: unknown): ToolProviderManifest {
  if (!isRecord(value)) throw new ToolProviderControlError("Tool Provider manifest is required");
  if (value.schemaVersion !== TOOL_PROVIDER_MANIFEST_VERSION || value.protocolVersion !== TOOL_PROVIDER_PROTOCOL_VERSION) {
    throw new ToolProviderControlError("Tool Provider manifest or protocol version is incompatible");
  }
  const providerId = identifier(value.providerId, "providerId");
  const source = identifier(value.source, "source");
  const version = requiredString(value.version, "version");
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new ToolProviderControlError("Tool Provider version must use semantic versioning");
  if (!isRecord(value.entrypoint)) throw new ToolProviderControlError("Tool Provider entrypoint is required");
  const executable = requiredString(value.entrypoint.executable, "entrypoint.executable");
  const workingDirectory = requiredString(value.entrypoint.workingDirectory, "entrypoint.workingDirectory");
  const normalizedExecutable = packageRelativePath(executable, "entrypoint.executable", false);
  const normalizedWorkingDirectory = packageRelativePath(workingDirectory, "entrypoint.workingDirectory", true);
  const args = stringArray(value.entrypoint.arguments, "entrypoint.arguments", true);
  if (!isRecord(value.artifact)
    || typeof value.artifact.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.artifact.sha256)
    || typeof value.artifact.packageSha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.artifact.packageSha256)) {
    throw new ToolProviderControlError("Tool Provider artifact requires lowercase executable and package SHA-256 digests");
  }
  const capabilities = stringArray(value.capabilities, "capabilities");
  if (!isRecord(value.permissions)
    || !["deny", "brokered"].includes(String(value.permissions.network))
    || !["none", "read_only", "scoped_write"].includes(String(value.permissions.filesystem))
    || value.permissions.process !== "sandboxed"
    || !["none", "handles_only"].includes(String(value.permissions.secrets))) {
    throw new ToolProviderControlError("Tool Provider permissions are invalid or exceed managed Provider policy");
  }
  const permissions = value.permissions as unknown as ToolProviderManifest["permissions"];
  if (!Array.isArray(value.tools) || !value.tools.length) throw new ToolProviderControlError("Tool Provider manifest requires a signed tool catalog");
  const tools = value.tools.map((toolValue) => {
    let tool: ExecutionToolSpec;
    try { tool = validateToolProviderSpec(toolValue); }
    catch (error) { throw new ToolProviderControlError(`Tool Provider manifest contains an invalid tool: ${message(error)}`); }
    if (tool.source !== source || tool.version !== version) {
      throw new ToolProviderControlError(`Tool ${tool.name} does not match its Provider source and version`);
    }
    const undeclared = tool.providedCapabilities.filter((capability) => !capabilities.includes(capability));
    if (undeclared.length) throw new ToolProviderControlError(`Tool ${tool.name} exposes undeclared capabilities: ${undeclared.join(", ")}`);
    try { assertToolPermissions(tool.name, tool.permissionRequirements, { permissions }); }
    catch (error) { throw new ToolProviderControlError(message(error)); }
    return tool;
  });
  if (new Set(tools.map((tool) => tool.name)).size !== tools.length) throw new ToolProviderControlError("Tool Provider manifest contains duplicate tool names");
  const platforms = stringArray(value.platforms, "platforms");
  if (!isRecord(value.resources)) throw new ToolProviderControlError("Tool Provider resources are required");
  const resources = {
    cpuTimeMs: positiveInteger(value.resources.cpuTimeMs, "resources.cpuTimeMs"),
    memoryBytes: positiveInteger(value.resources.memoryBytes, "resources.memoryBytes"),
    maximumProcesses: positiveInteger(value.resources.maximumProcesses, "resources.maximumProcesses"),
    maximumWriteBytes: positiveInteger(value.resources.maximumWriteBytes, "resources.maximumWriteBytes"),
  };
  return {
    schemaVersion: TOOL_PROVIDER_MANIFEST_VERSION, providerId, source, version,
    protocolVersion: TOOL_PROVIDER_PROTOCOL_VERSION,
    entrypoint: { executable: normalizedExecutable, arguments: args, workingDirectory: normalizedWorkingDirectory },
    artifact: { sha256: value.artifact.sha256, packageSha256: value.artifact.packageSha256 }, capabilities, tools,
    permissions, resources, platforms,
  };
}

export function validateToolProviderSignature(value: unknown): ToolProviderSignature {
  if (!isRecord(value) || value.algorithm !== "ed25519") throw new ToolProviderControlError("Tool Provider signature must use Ed25519");
  return { algorithm: "ed25519", keyId: identifier(value.keyId, "signature.keyId"), value: requiredString(value.value, "signature.value") };
}

function assertToolPermissions(
  toolName: string,
  requirements: {
    filesystem?: { read?: unknown[]; write?: unknown[] };
    network?: string;
    process?: string;
    interactiveProcess?: boolean;
    backgroundProcess?: boolean;
    secrets?: string;
  },
  manifest: Pick<ToolProviderManifest, "permissions">,
): void {
  if (requirements.network === "direct" || (requirements.network === "brokered" && manifest.permissions.network !== "brokered")) {
    throw new Error(`Tool ${toolName} requests network access beyond its signed manifest`);
  }
  if (requirements.process === "unrestricted" || requirements.interactiveProcess || requirements.backgroundProcess) {
    throw new Error(`Tool ${toolName} requests process access beyond managed Provider policy`);
  }
  if (requirements.secrets === "plaintext" || (requirements.secrets === "handles_only" && manifest.permissions.secrets !== "handles_only")) {
    throw new Error(`Tool ${toolName} requests secret access beyond its signed manifest`);
  }
  if ((requirements.filesystem?.read?.length ?? 0) > 0 && manifest.permissions.filesystem === "none") {
    throw new Error(`Tool ${toolName} requests filesystem read access beyond its signed manifest`);
  }
  if ((requirements.filesystem?.write?.length ?? 0) > 0 && manifest.permissions.filesystem !== "scoped_write") {
    throw new Error(`Tool ${toolName} requests filesystem write access beyond its signed manifest`);
  }
}

function parseInstallation(row: ManifestRow): ToolProviderInstallation {
  return {
    manifest: JSON.parse(row.manifest_json) as ToolProviderManifest,
    packageRoot: row.package_root,
    manifestFingerprint: row.manifest_fingerprint,
    signerId: row.signer_id,
    signature: { algorithm: "ed25519", keyId: row.signer_id, value: row.signature_base64 },
    state: row.state, stateReason: row.state_reason, installedAt: row.installed_at, updatedAt: row.updated_at,
  };
}

export function resolveToolProviderEntrypoint(
  manifest: ToolProviderManifest,
  packageRoot: string,
): { executable: string; workingDirectory: string } {
  const root = realpathSync(packageRoot);
  const resolveInside = (value: string) => {
    const target = realpathSync(resolve(root, ...value.split("/")));
    const pathFromRoot = relative(root, target);
    if (pathFromRoot === ".." || pathFromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(pathFromRoot)) {
      throw new ToolProviderControlError("Tool Provider entrypoint escapes its package root");
    }
    return target;
  };
  return {
    executable: resolveInside(manifest.entrypoint.executable),
    workingDirectory: resolveInside(manifest.entrypoint.workingDirectory),
  };
}

function parseEvent(row: EventRow): ToolProviderAuditEvent {
  return {
    id: row.id, sequence: row.sequence, providerId: row.provider_id, version: row.version,
    type: row.event_type, fromState: row.from_state, toState: row.to_state, reason: row.reason,
    actor: row.actor, commandId: row.command_id, createdAt: row.created_at,
  };
}

function manifestContract(manifest: ToolProviderManifest): ToolProviderContractSnapshot {
  return {
    providerId: manifest.providerId,
    version: manifest.version,
    source: manifest.source,
    protocolVersion: manifest.protocolVersion,
    capabilities: [...manifest.capabilities],
    permissions: { ...manifest.permissions },
    resources: { ...manifest.resources },
    platforms: [...manifest.platforms],
    executionFingerprint: fingerprint({ entrypoint: manifest.entrypoint, artifact: manifest.artifact }),
    tools: manifest.tools.map((tool) => structuredClone(tool)),
  };
}

function parseCompatibilityAudit(row: CompatibilityRow): ToolProviderCompatibilityAudit {
  let value: unknown;
  try { value = JSON.parse(row.report_json); }
  catch { throw new ToolProviderControlError(`Tool Provider compatibility audit ${row.id} contains invalid JSON`, 409); }
  if (!isRecord(value)
    || value.schemaVersion !== 1
    || value.providerId !== row.provider_id
    || value.fromVersion !== row.from_version
    || value.toVersion !== row.to_version
    || value.classification !== row.classification
    || !["compatible", "requires_drain", "breaking"].includes(String(value.classification))
    || typeof value.fromFingerprint !== "string"
    || typeof value.toFingerprint !== "string"
    || !Array.isArray(value.changes)
    || value.changes.some((change) => !isRecord(change)
      || typeof change.code !== "string" || typeof change.path !== "string" || typeof change.summary !== "string"
      || !["compatible", "requires_drain", "breaking"].includes(String(change.classification)))) {
    throw new ToolProviderControlError(`Tool Provider compatibility audit ${row.id} is invalid`, 409);
  }
  if (fingerprint(value) !== row.report_fingerprint) {
    throw new ToolProviderControlError(`Tool Provider compatibility audit ${row.id} fingerprint does not match`, 409);
  }
  return {
    id: row.id,
    commandId: row.command_id,
    actor: row.actor,
    assessedAt: row.assessed_at,
    report: value as unknown as ToolProviderCompatibilityReport,
  };
}

function compareVersions(left: string, right: string): number {
  const [leftCore, leftPre] = left.split("-", 2);
  const [rightCore, rightPre] = right.split("-", 2);
  const leftParts = leftCore.split(".").map(Number);
  const rightParts = rightCore.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) return leftParts[index] - rightParts[index];
  }
  if (leftPre === rightPre) return 0;
  if (leftPre === undefined) return 1;
  if (rightPre === undefined) return -1;
  return leftPre.localeCompare(rightPre);
}

function fingerprint(value: unknown): string { return createHash("sha256").update(canonicalJson(value)).digest("hex"); }
function validatePackageRoot(value: unknown): string {
  const path = requiredString(value, "packageRoot");
  if (!isAbsolute(path)) throw new ToolProviderControlError("packageRoot must be absolute");
  try {
    const canonical = realpathSync(path);
    if (!statSync(canonical).isDirectory()) throw new Error("not a directory");
    return canonical;
  } catch (error) {
    throw new ToolProviderControlError(`Tool Provider packageRoot cannot be verified: ${message(error)}`);
  }
}
function packageRelativePath(value: string, label: string, allowRoot: boolean): string {
  if (isAbsolute(value) || win32.isAbsolute(value) || value.includes("\\") || value.includes(":")) {
    throw new ToolProviderControlError(`${label} must be a portable package-relative path`);
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment === "" || segment === "..")) {
    throw new ToolProviderControlError(`${label} escapes or ambiguously addresses the package root`);
  }
  const normalized = segments.filter((segment) => segment !== ".").join("/");
  if (!normalized && !allowRoot) throw new ToolProviderControlError(`${label} must name a file inside the package`);
  return normalized || ".";
}
function identifier(value: unknown, label: string): string {
  const result = requiredString(value, label);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(result)) throw new ToolProviderControlError(`${label} contains unsupported characters`);
  return result;
}
function required(value: string, label: string): string { return requiredString(value, label); }
function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new ToolProviderControlError(`${label} is required`);
  return value.trim();
}
function stringArray(value: unknown, label: string, allowEmpty = false): string[] {
  if (!Array.isArray(value) || (!allowEmpty && !value.length) || value.some((entry) => typeof entry !== "string" || !entry.trim())) {
    throw new ToolProviderControlError(`${label} must contain named values`);
  }
  const result = value.map((entry) => String(entry).trim());
  if (new Set(result).size !== result.length) throw new ToolProviderControlError(`${label} contains duplicates`);
  return result;
}
function positiveInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || Number(value) < 1) throw new ToolProviderControlError(`${label} must be a positive integer`);
  return Number(value);
}
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function message(error: unknown): string { return error instanceof Error ? error.message : "Tool Provider operation failed"; }
function controlError(reply: FastifyReply, error: unknown) {
  const status = error instanceof ToolProviderControlError ? error.statusCode : 400;
  return reply.code(status).send({ error: message(error) });
}
