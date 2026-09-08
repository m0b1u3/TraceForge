import { dirname, isAbsolute, normalize } from "node:path";
import { allowsFileSystemPath, type EffectivePermissionProfile, type PermissionPathGrant } from "@traceforge/orchestration-core";
import { permissionProfileFingerprint } from "./protocol.js";

/** Policy compilation is deliberately separate from ProcessEnforcementAttestation:
 * Seatbelt is not a process-tree resource limiter or a cleanup supervisor. */
export interface MacosSeatbeltPolicy {
  profile: string;
  permissionFingerprint: string;
  resourceLimitsApplied: false;
  processTreeCleanupProven: false;
}
/** Host-only OS service grants. Never populated from a task or RPC payload. */
export interface MacosSystemServicePolicy {
  /** Explicit host acceptance of class-level IOKit access, not read-only access. */
  iokitRegistryClasses?: readonly string[];
  iokitUserClientClasses: readonly string[];
  iokitServiceClasses: readonly string[];
  machLookupServices: readonly string[];
  machRendezvousPrefixes?: readonly string[];
  standardIoDevices?: boolean;
}
export function compileMacosSeatbeltPolicy(permissions: EffectivePermissionProfile, executable: string, cwd: string,
  services?: MacosSystemServicePolicy): MacosSeatbeltPolicy {
  if (permissions.platform !== "darwin" || permissions.process.access !== "sandboxed") throw new Error("macOS policy requires darwin sandboxed permissions");
  if (permissions.network !== "deny") throw new Error("macOS Seatbelt policy only supports network deny; use the host Broker");
  if (permissions.process.interactive || permissions.process.background) throw new Error("macOS interactive/background execution is not accepted");
  const path = (value: string) => {
    if (!isAbsolute(value) || normalize(value) !== value || /[\x00-\x1f\x7f]/.test(value) || value.length > 4096) throw new Error("macOS policy requires canonical absolute paths");
    return JSON.stringify(value);
  };
  path(executable); path(cwd);
  if (!allowsFileSystemPath(permissions, "read", executable) || !allowsFileSystemPath(permissions, "read", cwd)) throw new Error("macOS launch paths require read grants");
  const grants = [...permissions.filesystem.read, ...permissions.filesystem.write, ...permissions.filesystem.deny];
  if (grants.length > 256) throw new Error("macOS policy exceeds grant capacity");
  const filter = (grant: PermissionPathGrant) => {
    if (!["tree", "exact"].includes(grant.scope)) throw new Error("Invalid macOS path scope");
    return `(${grant.scope === "tree" ? "subpath" : "literal"} ${path(grant.path)})`;
  };
  const lines = ["(version 1)", "(deny default)", '(import "/System/Library/Sandbox/Profiles/dyld-support.sb")',
    "(allow process-exec)", "(allow process-fork)", "(allow sysctl-read)",
    "(deny syscall-unix (syscall-number SYS_setsid SYS_setpgid))"];
  if (services) {
    if (services.standardIoDevices) {
      lines.push('(allow file-read* file-write-data (require-all (literal "/dev/null" "/dev/zero") (vnode-type CHARACTER-DEVICE)))');
      lines.push('(allow file-read* (literal "/dev/random" "/dev/urandom"))');
      lines.push('(allow process-info* signal (target same-sandbox))');
    }
    for (const names of [services.machRendezvousPrefixes ?? [], services.iokitRegistryClasses ?? [], services.iokitUserClientClasses, services.iokitServiceClasses, services.machLookupServices]) {
      if (names.length > 16 || names.some(name => !/^[A-Za-z0-9_.-]{1,128}$/.test(name))) throw new Error("Invalid macOS system service grant");
    }
    for (const name of services.iokitRegistryClasses ?? []) lines.push(`(allow iokit-open (iokit-registry-entry-class ${JSON.stringify(name)}))`);
    for (const name of services.iokitServiceClasses) lines.push(`(allow iokit-open-service (iokit-registry-entry-class ${JSON.stringify(name)}))`);
    // Opening a notification client must not grant device/power control selectors.
    for (const name of services.iokitUserClientClasses) lines.push(`(allow iokit-open-user-client (iokit-user-client-class ${JSON.stringify(name)}) (apply-message-filter (deny iokit-external-method) (deny iokit-async-external-method)))`);
    for (const name of services.machLookupServices) lines.push(`(allow mach-lookup (global-name ${JSON.stringify(name)}))`);
    for (const prefix of services.machRendezvousPrefixes ?? []) {
      if (!prefix.endsWith(".") || prefix.length < 16) throw new Error("Invalid Mach rendezvous prefix");
      lines.push(`(allow mach-register mach-lookup (global-name-prefix ${JSON.stringify(prefix)}))`);
    }
  }
  // Host platform runtime only. No home, /private, /Library or broad Mach grants.
  lines.push('(allow file-read* file-map-executable (subpath "/System/Library") (subpath "/usr/lib"))');
  const ancestors = new Set<string>(["/"]);
  for (const grant of grants) {
    filter(grant);
    for (let parent = dirname(grant.path); ; parent = dirname(parent)) {
      ancestors.add(parent); if (parent === "/") break;
    }
  }
  for (const parent of [...ancestors].sort()) lines.push(`(allow file-read-metadata (literal ${path(parent)}))`);
  for (const grant of permissions.filesystem.read) lines.push(`(allow file-read* file-map-executable ${filter(grant)})`);
  for (const grant of permissions.filesystem.write) lines.push(`(allow file-write* ${filter(grant)})`);
  for (const grant of permissions.filesystem.deny) lines.push(`(deny file-read* file-write* file-map-executable ${filter(grant)})`);
  lines.push("(deny network*)");
  const profile = lines.join("\n");
  if (Buffer.byteLength(profile) > 65536) throw new Error("macOS policy exceeds byte capacity");
  return { profile, permissionFingerprint: permissionProfileFingerprint(permissions), resourceLimitsApplied: false, processTreeCleanupProven: false };
}
