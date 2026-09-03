import { createHash } from "node:crypto";

export const NATIVE_HELPER_RELEASE_PROFILE = "traceforge-native-helper-release-v1" as const;

export interface NativeHelperReleaseManifest {
  format: 1;
  profile: typeof NATIVE_HELPER_RELEASE_PROFILE;
  platform: "linux" | "windows";
  architecture: "x64";
  backend: "traceforge-linux-native" | "traceforge-windows-native";
  executable: "traceforge-linux-sandbox" | "traceforge-windows-sandbox.exe";
  protocol: number;
  sha256: string;
}

const keys = ["architecture", "backend", "executable", "format", "platform", "profile", "protocol", "sha256"];

export function nativeHelperSha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function parseNativeHelperReleaseManifest(value: unknown): NativeHelperReleaseManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Native helper release manifest must be an object");
  const manifest = value as Record<string, unknown>;
  if (JSON.stringify(Object.keys(manifest).sort()) !== JSON.stringify(keys)) throw new Error("Native helper release manifest has missing or unknown fields");
  if (manifest.format !== 1 || manifest.profile !== NATIVE_HELPER_RELEASE_PROFILE) throw new Error("Native helper release manifest profile is incompatible");
  if (manifest.platform !== "linux" && manifest.platform !== "windows") throw new Error("Native helper release manifest platform is invalid");
  if (manifest.architecture !== "x64") throw new Error("Native helper release manifest architecture is invalid");
  const expectedBackend = manifest.platform === "linux" ? "traceforge-linux-native" : "traceforge-windows-native";
  const expectedExecutable = manifest.platform === "linux" ? "traceforge-linux-sandbox" : "traceforge-windows-sandbox.exe";
  if (manifest.backend !== expectedBackend || manifest.executable !== expectedExecutable) throw new Error("Native helper release manifest identity is inconsistent");
  if (!Number.isSafeInteger(manifest.protocol) || (manifest.protocol as number) < 1) throw new Error("Native helper release manifest protocol is invalid");
  if (typeof manifest.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(manifest.sha256)) throw new Error("Native helper release manifest digest is invalid");
  return structuredClone(manifest) as unknown as NativeHelperReleaseManifest;
}

export function createNativeHelperReleaseManifest(input: {
  platform: NativeHelperReleaseManifest["platform"];
  protocol: number;
  bytes: Uint8Array;
}): NativeHelperReleaseManifest {
  return parseNativeHelperReleaseManifest({
    format: 1,
    profile: NATIVE_HELPER_RELEASE_PROFILE,
    platform: input.platform,
    architecture: "x64",
    backend: input.platform === "linux" ? "traceforge-linux-native" : "traceforge-windows-native",
    executable: input.platform === "linux" ? "traceforge-linux-sandbox" : "traceforge-windows-sandbox.exe",
    protocol: input.protocol,
    sha256: nativeHelperSha256(input.bytes),
  });
}

export function verifyNativeHelperRelease(
  value: unknown,
  expected: {
    platform: NativeHelperReleaseManifest["platform"];
    architecture: string;
    backend: string;
    executable: string;
    protocol: number;
    bytes: Uint8Array;
  },
): NativeHelperReleaseManifest {
  const manifest = parseNativeHelperReleaseManifest(value);
  if (manifest.platform !== expected.platform || manifest.architecture !== expected.architecture
    || manifest.backend !== expected.backend || manifest.executable !== expected.executable
    || manifest.protocol !== expected.protocol) throw new Error("Native helper release does not match the current host contract");
  if (manifest.sha256 !== nativeHelperSha256(expected.bytes)) throw new Error("Native helper release digest does not match the installed executable");
  return manifest;
}
