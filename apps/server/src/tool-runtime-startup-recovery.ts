import type { ToolProviderRecoveryReconciliationReport } from "./tool-provider-recovery-reconciler.js";

export interface ToolRuntimeStartupPort {
  restore(): Promise<void>;
  refresh(): Promise<void>;
}

export interface ToolProviderStartupReconcilerPort {
  reconcile(): Promise<ToolProviderRecoveryReconciliationReport>;
}

export interface ToolProviderStartupControlPort {
  recover(): Promise<{ enabled: string[]; failed: string[] }>;
}

export interface ToolRuntimeStartupRecoveryReport {
  reconciliation: ToolProviderRecoveryReconciliationReport;
  providers: { enabled: string[]; failed: string[] };
}

/** Strict startup ordering: restore metadata, reconcile quarantine, recover sources, then refresh catalogs. */
export async function recoverToolRuntimeStartup(
  runtime: ToolRuntimeStartupPort,
  reconciler: ToolProviderStartupReconcilerPort,
  control: ToolProviderStartupControlPort,
): Promise<ToolRuntimeStartupRecoveryReport> {
  await runtime.restore();
  const reconciliation = await reconciler.reconcile();
  const providers = await control.recover();
  await runtime.refresh();
  return { reconciliation, providers };
}
