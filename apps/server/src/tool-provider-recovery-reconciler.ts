import type {
  ToolProviderRecoverySnapshot,
  ToolProviderRecoveryStatePort,
} from "@traceforge/worker-runtime";
import type { ToolProviderInstallState } from "./tool-provider-control-plane.js";

interface RecoveryControlInstallation {
  manifest: { providerId: string; version: string };
  state: ToolProviderInstallState;
  stateReason: string | null;
}

export interface ToolProviderRecoveryControlPort {
  list(): RecoveryControlInstallation[];
  quarantine(
    providerId: string,
    version: string,
    reason: string,
    actor: string,
    commandId: string,
  ): Promise<unknown>;
}

export interface ToolProviderRecoveryReconciliationReport {
  projectedToControl: string[];
  projectedToRecovery: string[];
  consistent: string[];
}

/** Reconciles durable recovery and control-plane quarantine without activating a Provider. */
export class ToolProviderRecoveryReconciler {
  constructor(
    private readonly state: ToolProviderRecoveryStatePort,
    private readonly control: ToolProviderRecoveryControlPort,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async reconcile(): Promise<ToolProviderRecoveryReconciliationReport> {
    const installations = this.control.list()
      .sort((left, right) => identity(left).localeCompare(identity(right)));
    const loaded = await Promise.all(installations.map(async (installation) => ({
      installation,
      snapshot: await this.state.load({
        providerId: installation.manifest.providerId,
        version: installation.manifest.version,
      }),
    })));
    const report: ToolProviderRecoveryReconciliationReport = {
      projectedToControl: [], projectedToRecovery: [], consistent: [],
    };
    for (const { installation, snapshot } of loaded) {
      const key = identity(installation);
      if (snapshot?.status === "quarantined") {
        if (installation.state === "quarantined") {
          report.consistent.push(key);
          continue;
        }
        await this.control.quarantine(
          installation.manifest.providerId,
          installation.manifest.version,
          snapshot.quarantineReason ?? "Provider recovery state requires quarantine",
          "provider-recovery-reconciler",
          commandId(snapshot),
        );
        report.projectedToControl.push(key);
        continue;
      }
      if (installation.state !== "quarantined") continue;
      await this.state.save(quarantinedSnapshot(installation, snapshot, this.now()));
      report.projectedToRecovery.push(key);
    }
    return report;
  }
}

function quarantinedSnapshot(
  installation: RecoveryControlInstallation,
  current: ToolProviderRecoverySnapshot | undefined,
  at: Date,
): ToolProviderRecoverySnapshot {
  return {
    schemaVersion: 1,
    identity: {
      providerId: installation.manifest.providerId,
      version: installation.manifest.version,
    },
    status: "quarantined",
    revision: (current?.revision ?? 0) + 1,
    failures: current?.failures.map((failure) => ({ ...failure })) ?? [],
    nextAttemptAt: null,
    stabilityDeadlineAt: null,
    quarantineReason: installation.stateReason?.trim() || "Tool Provider control plane requires quarantine",
    updatedAt: at.toISOString(),
  };
}

function identity(installation: RecoveryControlInstallation): string {
  return `${installation.manifest.providerId}@${installation.manifest.version}`;
}

function commandId(snapshot: ToolProviderRecoverySnapshot): string {
  return `provider-recovery:${snapshot.identity.providerId}:${snapshot.identity.version}:${snapshot.revision}`;
}
