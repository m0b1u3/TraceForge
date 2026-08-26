import { describe, expect, it } from "vitest";
import {
  allowsFileSystemPath,
  intersectPermissionProfiles,
  satisfiesPermissionRequirements,
  type PermissionProfile,
} from "./permissions.js";

function profile(patch: Partial<PermissionProfile> = {}): PermissionProfile {
  return {
    version: 1,
    platform: "windows",
    filesystem: { read: [], write: [], deny: [] },
    network: "deny",
    process: { access: "deny", interactive: false, background: false },
    secrets: "deny",
    ...patch,
  };
}

describe("permission profile intersection", () => {
  it("takes the narrowest path grants and unions explicit denies", () => {
    const effective = intersectPermissionProfiles([
      { source: "system", profile: profile({
        filesystem: {
          read: [{ path: "C:\\cases", scope: "tree" }],
          write: [{ path: "C:\\cases", scope: "tree" }],
          deny: [{ path: "C:\\cases\\secrets", scope: "tree" }],
        },
        network: "direct",
        process: { access: "unrestricted", interactive: true, background: true },
        secrets: "plaintext",
      }) },
      { source: "work", profile: profile({
        filesystem: {
          read: [{ path: "C:\\cases\\case-1", scope: "tree" }],
          write: [{ path: "C:\\cases\\case-1\\output", scope: "tree" }],
          deny: [{ path: "C:\\cases\\case-1\\output\\locked.txt", scope: "exact" }],
        },
        network: "brokered",
        process: { access: "sandboxed", interactive: true, background: false },
        secrets: "handles_only",
      }) },
    ]);

    expect(effective.sources).toEqual(["system", "work"]);
    expect(effective.network).toBe("brokered");
    expect(effective.process).toEqual({ access: "sandboxed", interactive: true, background: false });
    expect(effective.secrets).toBe("handles_only");
    expect(effective.filesystem.read).toEqual([{ path: "C:\\cases\\case-1", scope: "tree" }]);
    expect(allowsFileSystemPath(effective, "write", "C:\\cases\\case-1\\output\\report.json")).toBe(true);
    expect(allowsFileSystemPath(effective, "write", "C:\\cases\\case-1\\output\\locked.txt")).toBe(false);
    expect(allowsFileSystemPath(effective, "read", "C:\\cases\\secrets\\token.txt")).toBe(false);
    expect(allowsFileSystemPath(effective, "read", "C:\\other\\file.txt")).toBe(false);
  });

  it("fails closed for relative paths and mixed executor platforms", () => {
    expect(() => intersectPermissionProfiles([{ source: "bad", profile: profile({
      filesystem: { read: [{ path: "relative", scope: "tree" }], write: [], deny: [] },
    }) }])).toThrow(/must be absolute/);
    expect(() => intersectPermissionProfiles([
      { source: "windows", profile: profile() },
      { source: "linux", profile: profile({ platform: "linux" }) },
    ])).toThrow(/different executor platforms/);
  });

  it("checks complete tree requirements against nested deny rules", () => {
    const effective = intersectPermissionProfiles([{ source: "run", profile: profile({
      filesystem: {
        read: [{ path: "C:\\case", scope: "tree" }],
        write: [],
        deny: [{ path: "C:\\case\\private", scope: "tree" }],
      },
      network: "brokered",
    }) }]);
    expect(satisfiesPermissionRequirements(effective, {
      network: "brokered",
      filesystem: { read: [{ path: "C:\\case\\public", scope: "tree" }] },
    })).toBe(true);
    expect(satisfiesPermissionRequirements(effective, {
      filesystem: { read: [{ path: "C:\\case", scope: "tree" }] },
    })).toBe(false);
    expect(satisfiesPermissionRequirements(effective, { network: "direct" })).toBe(false);
  });
});
