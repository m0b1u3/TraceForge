import type { MacosSystemServicePolicy } from "@traceforge/execution-node";

/** Browser-only compatibility subset of openai/codex seatbelt_base_policy.sbpl.
 * Class-level power-client access, NOT a read-only notification guarantee.
 * No blanket Mach lookup, filesystem expansion or network access. */
export const MACOS_BROWSER_SYSTEM_SERVICES: Readonly<MacosSystemServicePolicy> = Object.freeze({
  standardIoDevices: true,
  iokitRegistryClasses: Object.freeze(["RootDomainUserClient"]),
  machRendezvousPrefixes: Object.freeze(["org.chromium.Chromium.MachPortRendezvousServer."]),
  iokitUserClientClasses: Object.freeze([]),
  iokitServiceClasses: Object.freeze([]),
  machLookupServices: Object.freeze(["com.apple.PowerManagement.control", "com.apple.system.opendirectoryd.libinfo", "com.apple.bsd.dirhelper"]),
});
