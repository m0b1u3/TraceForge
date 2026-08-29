import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type Database from "better-sqlite3";
import type { ExecutionToolRuntimeSnapshot } from "@traceforge/worker-runtime";
import { ManagedToolProviderPackageStore } from "./tool-provider-package-store.js";
import { SqliteToolProviderControlStore, type ToolProviderInstallation } from "./tool-provider-control-plane.js";

export interface ToolProviderGarbageCollectionPolicy {
  gracePeriodMs?: number;
  maximumDeletesPerRun?: number;
}

export interface ToolProviderGarbageCollectionCandidate {
  kind: "package" | "scratch";
  path: string;
  providerId: string | null;
  providerVersion: string | null;
  decision: "eligible" | "skipped" | "deleted" | "failed";
  reason: string;
  bytes: number;
}

export interface ToolProviderGarbageCollectionReport {
  id: string;
  dryRun: boolean;
  cutoffAt: string;
  examined: number;
  eligible: number;
  deleted: number;
  reclaimedBytes: number;
  failures: number;
  startedAt: string;
  completedAt: string;
  candidates: ToolProviderGarbageCollectionCandidate[];
}

const DEFAULT_GRACE_PERIOD_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_MAXIMUM_DELETES = 50;

export class ToolProviderGarbageCollector {
  private readonly workRoot: string;
  private readonly gracePeriodMs: number;
  private readonly maximumDeletesPerRun: number;

  constructor(
    private readonly sqlite: Database.Database,
    private readonly control: SqliteToolProviderControlStore,
    private readonly packages: ManagedToolProviderPackageStore,
    workRootValue: string,
    private readonly runtimeSnapshot: () => ExecutionToolRuntimeSnapshot,
    policy: ToolProviderGarbageCollectionPolicy = {},
    private readonly now: () => string = () => new Date().toISOString(),
  ) {
    if (!isAbsolute(workRootValue)) throw new Error("Tool Provider garbage collection work root must be absolute");
    mkdirSync(workRootValue, { recursive: true, mode: 0o700 });
    this.workRoot = realpathSync(workRootValue);
    this.gracePeriodMs = positive(policy.gracePeriodMs ?? DEFAULT_GRACE_PERIOD_MS, "grace period");
    this.maximumDeletesPerRun = positive(policy.maximumDeletesPerRun ?? DEFAULT_MAXIMUM_DELETES, "delete batch");
  }

  collect(input: { dryRun: boolean; at?: string }): ToolProviderGarbageCollectionReport {
    const startedAt = timestamp(input.at ?? this.now(), "collection timestamp");
    const cutoffAt = new Date(Date.parse(startedAt) - this.gracePeriodMs).toISOString();
    const runtimeOwned = new Set(this.runtimeSnapshot().providers
      .filter((provider) => provider.lifecycle !== "retired")
      .map((provider) => `${provider.tool.source}\0${provider.tool.version}`));
    const prepared = this.sqlite.prepare(`
      SELECT tool_source, tool_version, run_id, work_id, idempotency_key
      FROM tool_invocation_bindings WHERE status = 'prepared'
    `).all() as Array<{ tool_source: string; tool_version: string; run_id: string; work_id: string; idempotency_key: string }>;
    const preparedVersions = new Set(prepared.map((row) => `${row.tool_source}\0${row.tool_version}`));
    const protectedScratch = new Set(prepared.map((row) => invocationIdentity(row.run_id, row.work_id, row.idempotency_key)));
    const recoveryOwned = new Set((this.sqlite.prepare(`
      SELECT provider_id, version FROM tool_provider_recovery_states WHERE status != 'healthy'
    `).all() as Array<{ provider_id: string; version: string }>).map((row) => `${row.provider_id}\0${row.version}`));
    const installations = this.control.list();
    const candidates = [
      ...installations.map((installation) => this.packageCandidate(
        installation, cutoffAt, preparedVersions, runtimeOwned, recoveryOwned,
      )),
      ...this.orphanPackageCandidates(cutoffAt, new Set(installations.map((installation) => resolve(installation.packageRoot)))),
      ...this.scratchCandidates(cutoffAt, protectedScratch),
    ].sort((left, right) => left.kind.localeCompare(right.kind) || left.path.localeCompare(right.path));
    const eligible = candidates.filter((candidate) => candidate.decision === "eligible").length;
    let remainingDeletes = this.maximumDeletesPerRun;
    if (!input.dryRun) {
      for (const candidate of candidates) {
        if (candidate.decision !== "eligible") continue;
        if (remainingDeletes === 0) {
          candidate.decision = "skipped";
          candidate.reason = "delete_batch_limit";
          continue;
        }
        remainingDeletes -= 1;
        try {
          if (candidate.kind === "package") {
            const result = this.packages.collect(candidate.path);
            candidate.bytes = result.reclaimedBytes;
            if (candidate.providerId && candidate.providerVersion) {
              this.control.markPackageCollected(
                candidate.providerId, candidate.providerVersion, candidate.path,
                "managed package payload removed after ownership-safe garbage collection", startedAt,
              );
            }
          } else {
            candidate.bytes = removeScratch(this.workRoot, candidate.path);
          }
          candidate.decision = "deleted";
          candidate.reason = "collected";
        } catch {
          candidate.decision = "failed";
          candidate.reason = "collection_failed";
        }
      }
    }
    const report: ToolProviderGarbageCollectionReport = {
      id: randomUUID(), dryRun: input.dryRun, cutoffAt, examined: candidates.length, eligible,
      deleted: candidates.filter((candidate) => candidate.decision === "deleted").length,
      reclaimedBytes: candidates.filter((candidate) => candidate.decision === "deleted").reduce((total, candidate) => total + candidate.bytes, 0),
      failures: candidates.filter((candidate) => candidate.decision === "failed").length,
      startedAt, completedAt: timestamp(this.now(), "completion timestamp"), candidates,
    };
    this.persist(report);
    return report;
  }

  private packageCandidate(
    installation: ToolProviderInstallation,
    cutoffAt: string,
    prepared: Set<string>,
    runtime: Set<string>,
    recovery: Set<string>,
  ): ToolProviderGarbageCollectionCandidate {
    const base = {
      kind: "package" as const, path: installation.packageRoot,
      providerId: installation.manifest.providerId, providerVersion: installation.manifest.version,
      bytes: 0,
    };
    const skip = (reason: string): ToolProviderGarbageCollectionCandidate => ({ ...base, decision: "skipped", reason });
    if (installation.state === "collected") return skip("already_collected");
    if (installation.state !== "disabled" && installation.state !== "failed") return skip(`lifecycle_${installation.state}`);
    if (installation.updatedAt > cutoffAt) return skip("grace_period");
    const contract = `${installation.manifest.source}\0${installation.manifest.version}`;
    if (prepared.has(contract)) return skip("prepared_binding");
    if (runtime.has(contract)) return skip("runtime_generation");
    if (recovery.has(`${installation.manifest.providerId}\0${installation.manifest.version}`)) return skip("recovery_ownership");
    try {
      const bytes = existsSync(installation.packageRoot) ? this.packages.inspect(installation.packageRoot).bytes : 0;
      return { ...base, bytes, decision: "eligible", reason: "ownership_clear" };
    } catch {
      return skip("unsafe_or_unreadable_path");
    }
  }

  private scratchCandidates(cutoffAt: string, protectedIdentities: Set<string>): ToolProviderGarbageCollectionCandidate[] {
    const candidates: ToolProviderGarbageCollectionCandidate[] = [];
    for (const shard of readdirSync(this.workRoot).sort()) {
      const shardPath = join(this.workRoot, shard);
      const shardStats = lstatSync(shardPath);
      if (!/^[a-f0-9]{2}$/.test(shard) || shardStats.isSymbolicLink() || !shardStats.isDirectory()) {
        candidates.push({ kind: "scratch", path: shardPath, providerId: null, providerVersion: null, decision: "skipped", reason: "invalid_layout", bytes: 0 });
        continue;
      }
      for (const identity of readdirSync(shardPath).sort()) {
        const path = join(shardPath, identity);
        const base = { kind: "scratch" as const, path, providerId: null, providerVersion: null };
        if (!/^[a-f0-9]{64}$/.test(identity) || !identity.startsWith(shard) || lstatSync(path).isSymbolicLink()) {
          candidates.push({ ...base, decision: "skipped", reason: "invalid_layout", bytes: 0 });
          continue;
        }
        if (protectedIdentities.has(identity)) {
          candidates.push({ ...base, decision: "skipped", reason: "prepared_binding", bytes: 0 });
          continue;
        }
        try {
          const inventory = scratchInventory(path);
          candidates.push({ ...base, decision: inventory.updatedAt > cutoffAt ? "skipped" : "eligible", reason: inventory.updatedAt > cutoffAt ? "grace_period" : "ownership_clear", bytes: inventory.bytes });
        } catch {
          candidates.push({ ...base, decision: "skipped", reason: "unsafe_or_unreadable_path", bytes: 0 });
        }
      }
    }
    return candidates;
  }

  private orphanPackageCandidates(cutoffAt: string, referenced: Set<string>): ToolProviderGarbageCollectionCandidate[] {
    const candidates: ToolProviderGarbageCollectionCandidate[] = [];
    for (const provider of readdirSync(this.packages.root).sort()) {
      const providerRoot = join(this.packages.root, provider);
      const providerStats = lstatSync(providerRoot);
      if (providerStats.isSymbolicLink() || !providerStats.isDirectory()) {
        candidates.push({ kind: "package", path: providerRoot, providerId: null, providerVersion: null, decision: "skipped", reason: "invalid_layout", bytes: 0 });
        continue;
      }
      for (const name of readdirSync(providerRoot).sort()) {
        const path = join(providerRoot, name);
        if (referenced.has(resolve(path))) continue;
        try {
          const inventory = scratchInventory(path);
          candidates.push({
            kind: "package", path, providerId: null, providerVersion: null, bytes: inventory.bytes,
            decision: inventory.updatedAt > cutoffAt ? "skipped" : "eligible",
            reason: inventory.updatedAt > cutoffAt ? "grace_period" : "orphaned_package_payload",
          });
        } catch {
          candidates.push({ kind: "package", path, providerId: null, providerVersion: null, decision: "skipped", reason: "unsafe_or_unreadable_path", bytes: 0 });
        }
      }
    }
    return candidates;
  }

  private persist(report: ToolProviderGarbageCollectionReport): void {
    this.sqlite.transaction(() => {
      this.sqlite.prepare(`
        INSERT INTO tool_provider_gc_runs
          (id, dry_run, cutoff_at, examined, eligible, deleted, reclaimed_bytes, failures, started_at, completed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(report.id, report.dryRun ? 1 : 0, report.cutoffAt, report.examined, report.eligible, report.deleted, report.reclaimedBytes, report.failures, report.startedAt, report.completedAt);
      const insert = this.sqlite.prepare(`
        INSERT INTO tool_provider_gc_candidates
          (run_id, sequence, kind, path, provider_id, provider_version, decision, reason, bytes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      report.candidates.forEach((candidate, index) => insert.run(
        report.id, index, candidate.kind, candidate.path, candidate.providerId, candidate.providerVersion,
        candidate.decision, candidate.reason, candidate.bytes,
      ));
    })();
  }
}

function invocationIdentity(runId: string, workId: string, idempotencyKey: string): string {
  return createHash("sha256").update(`${runId}\0${workId}\0${idempotencyKey}`).digest("hex");
}

function scratchInventory(root: string): { bytes: number; updatedAt: string } {
  const rootStats = lstatSync(root);
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) throw new Error("Scratch candidate must be a directory");
  let bytes = 0;
  let updated = rootStats.mtimeMs;
  const visit = (directory: string) => {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      const stats = lstatSync(path);
      if (stats.isSymbolicLink()) throw new Error("Scratch candidate contains a symbolic link");
      updated = Math.max(updated, stats.mtimeMs);
      if (stats.isDirectory()) visit(path);
      else if (stats.isFile()) bytes += stats.size;
      else throw new Error("Scratch candidate contains an unsupported entry");
    }
  };
  visit(root);
  return { bytes, updatedAt: new Date(updated).toISOString() };
}

function removeScratch(root: string, candidate: string): number {
  const target = resolve(candidate);
  if (!inside(root, target) || target === root) throw new Error("Scratch collection target escapes its managed root");
  const inventory = scratchInventory(target);
  makeWritable(target);
  rmSync(target, { recursive: true, force: true });
  return inventory.bytes;
}

function makeWritable(root: string): void {
  const stats = lstatSync(root);
  if (stats.isSymbolicLink()) throw new Error("Refusing to modify a symbolic link");
  if (stats.isDirectory()) for (const name of readdirSync(root)) makeWritable(join(root, name));
  chmodSync(root, stats.isDirectory() ? 0o700 : 0o600);
}

function inside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

function positive(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Tool Provider garbage collection ${label} must be a positive integer`);
  return value;
}

function timestamp(value: string, label: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`Tool Provider garbage collection ${label} must be an ISO timestamp`);
  return new Date(parsed).toISOString();
}
