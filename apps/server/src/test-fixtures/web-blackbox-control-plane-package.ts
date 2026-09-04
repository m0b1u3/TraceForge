import type { ScenarioPackageInstallation } from "@traceforge/scenario-sdk";
import { WEB_BLACKBOX_TEST_PACKAGE } from "./web-blackbox-descriptor.js";

/** Control-plane fixture derived from scenario.json, with no executable runtime or in-process tools. */
export function webBlackboxControlPlanePackage(): ScenarioPackageInstallation {
  const { runtime: _runtime, ...dataPackage } = WEB_BLACKBOX_TEST_PACKAGE;
  return { ...dataPackage, createToolSources: () => [] };
}
