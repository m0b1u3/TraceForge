import { describe, expect, it } from "vitest";
import {
  createNativeHelperReleaseManifest,
  parseNativeHelperReleaseManifest,
  verifyNativeHelperRelease,
} from "./native-helper-release.js";

describe("native helper release manifest", () => {
  it("binds one installed helper to its platform, protocol and bytes", () => {
    const bytes = Buffer.from("reviewed-helper");
    const manifest = createNativeHelperReleaseManifest({ platform: "linux", protocol: 1, bytes });
    expect(verifyNativeHelperRelease(manifest, {
      platform: "linux", architecture: "x64", backend: "traceforge-linux-native",
      executable: "traceforge-linux-sandbox", protocol: 1, bytes,
    })).toEqual(manifest);
    expect(() => verifyNativeHelperRelease(manifest, {
      platform: "linux", architecture: "x64", backend: "traceforge-linux-native",
      executable: "traceforge-linux-sandbox", protocol: 1, bytes: Buffer.from("replaced-helper"),
    })).toThrow("digest");
  });

  it("rejects cross-platform, unknown-field and malformed manifests", () => {
    const manifest = createNativeHelperReleaseManifest({ platform: "windows", protocol: 4, bytes: Buffer.from("helper") });
    expect(() => verifyNativeHelperRelease(manifest, {
      platform: "linux", architecture: "x64", backend: "traceforge-linux-native",
      executable: "traceforge-linux-sandbox", protocol: 1, bytes: Buffer.from("helper"),
    })).toThrow("host contract");
    expect(() => parseNativeHelperReleaseManifest({ ...manifest, unreviewed: true })).toThrow("unknown fields");
    expect(() => parseNativeHelperReleaseManifest({ ...manifest, sha256: "invalid" })).toThrow("digest");
  });
});
