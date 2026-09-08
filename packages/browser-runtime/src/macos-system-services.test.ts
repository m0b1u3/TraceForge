import { describe, expect, it } from "vitest";
import { MACOS_BROWSER_SYSTEM_SERVICES } from "./macos-system-services.js";
import { compileMacosSeatbeltPolicy } from "@traceforge/execution-node";

describe("Browser-only experimental macOS service policy", () => {
  it("is immutable and limits compatibility grants to named services", () => {
    expect(Object.isFrozen(MACOS_BROWSER_SYSTEM_SERVICES)).toBe(true);
    expect(Object.isFrozen(MACOS_BROWSER_SYSTEM_SERVICES.iokitUserClientClasses)).toBe(true);
    expect(MACOS_BROWSER_SYSTEM_SERVICES.machLookupServices).toEqual(["com.apple.PowerManagement.control", "com.apple.system.opendirectoryd.libinfo", "com.apple.bsd.dirhelper"]);
    const profile = compileMacosSeatbeltPolicy({ version: 1, platform: "darwin", network: "deny", secrets: "deny", sources: ["fixture"],
      process: { access: "sandboxed", interactive: false, background: false },
      filesystem: { read: [{ path: "/fixture", scope: "tree" }], write: [], deny: [] } }, "/fixture/browser", "/fixture", MACOS_BROWSER_SYSTEM_SERVICES).profile;
    expect(profile).not.toContain("apply-message-filter");
    expect(profile).toContain('(iokit-registry-entry-class "RootDomainUserClient")');
    expect(profile).toContain("(deny network*)");
    expect(profile).not.toContain("(allow mach-lookup)");
    expect(profile).toContain('(global-name-prefix "org.chromium.Chromium.MachPortRendezvousServer.")');
    expect(profile).not.toContain('(global-name-prefix "")');
  });
});
