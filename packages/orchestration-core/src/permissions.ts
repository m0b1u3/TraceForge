import { posix, win32 } from "node:path";

export type ExecutorPlatform = "windows" | "linux" | "darwin";
export type PermissionPathScope = "exact" | "tree";
export type NetworkPermission = "deny" | "brokered" | "direct";
export type ProcessPermission = "deny" | "sandboxed" | "unrestricted";
export type SecretPermission = "deny" | "handles_only" | "plaintext";

export interface PermissionPathGrant {
  path: string;
  scope: PermissionPathScope;
}

export interface FileSystemPermissionProfile {
  read: PermissionPathGrant[];
  write: PermissionPathGrant[];
  deny: PermissionPathGrant[];
}

export interface EffectivePermissionProfile {
  version: 1;
  platform: ExecutorPlatform;
  filesystem: FileSystemPermissionProfile;
  network: NetworkPermission;
  process: {
    access: ProcessPermission;
    interactive: boolean;
    background: boolean;
  };
  secrets: SecretPermission;
  sources: string[];
}

export interface PermissionProfile extends Omit<EffectivePermissionProfile, "sources"> {}

export interface PermissionProfileLayer {
  source: string;
  profile: PermissionProfile;
}

export interface PermissionRequirements {
  filesystem?: Partial<Pick<FileSystemPermissionProfile, "read" | "write">>;
  network?: Exclude<NetworkPermission, "deny">;
  process?: Exclude<ProcessPermission, "deny">;
  interactiveProcess?: boolean;
  backgroundProcess?: boolean;
  secrets?: Exclude<SecretPermission, "deny">;
}

const networkRank: Record<NetworkPermission, number> = { deny: 0, brokered: 1, direct: 2 };
const processRank: Record<ProcessPermission, number> = { deny: 0, sandboxed: 1, unrestricted: 2 };
const secretRank: Record<SecretPermission, number> = { deny: 0, handles_only: 1, plaintext: 2 };

function pathApi(platform: ExecutorPlatform) {
  return platform === "windows" ? win32 : posix;
}

function normalizeGrant(grant: PermissionPathGrant, platform: ExecutorPlatform): PermissionPathGrant {
  if (grant.scope !== "exact" && grant.scope !== "tree") throw new Error(`Unsupported permission path scope ${String(grant.scope)}`);
  const api = pathApi(platform);
  if (!grant.path.trim() || !api.isAbsolute(grant.path)) {
    throw new Error(`Permission path must be absolute for ${platform}: ${grant.path}`);
  }
  return { path: api.normalize(grant.path), scope: grant.scope };
}

function pathKey(value: string, platform: ExecutorPlatform): string {
  const normalized = pathApi(platform).normalize(value);
  return platform === "windows" ? normalized.toLocaleLowerCase("en-US") : normalized;
}

function sameGrant(left: PermissionPathGrant, right: PermissionPathGrant, platform: ExecutorPlatform): boolean {
  return left.scope === right.scope && pathKey(left.path, platform) === pathKey(right.path, platform);
}

function containsPath(grant: PermissionPathGrant, candidatePath: string, platform: ExecutorPlatform): boolean {
  const root = pathKey(grant.path, platform);
  const candidate = pathKey(candidatePath, platform);
  if (root === candidate) return true;
  if (grant.scope === "exact") return false;
  const separator = pathApi(platform).sep;
  const prefix = root.endsWith(separator) ? root : `${root}${separator}`;
  return candidate.startsWith(prefix);
}

function containsGrant(container: PermissionPathGrant, candidate: PermissionPathGrant, platform: ExecutorPlatform): boolean {
  if (!containsPath(container, candidate.path, platform)) return false;
  return container.scope === "tree" || candidate.scope === "exact";
}

function grantsOverlap(left: PermissionPathGrant, right: PermissionPathGrant, platform: ExecutorPlatform): boolean {
  return containsPath(left, right.path, platform) || containsPath(right, left.path, platform);
}

function compactGrants(grants: PermissionPathGrant[], platform: ExecutorPlatform): PermissionPathGrant[] {
  const unique: PermissionPathGrant[] = [];
  for (const raw of grants) {
    const grant = normalizeGrant(raw, platform);
    if (!unique.some((candidate) => sameGrant(candidate, grant, platform))) unique.push(grant);
  }
  return unique
    .filter((grant, index) => !unique.some((candidate, candidateIndex) => candidateIndex !== index && containsGrant(candidate, grant, platform)))
    .sort((left, right) => pathKey(left.path, platform).localeCompare(pathKey(right.path, platform)) || left.scope.localeCompare(right.scope));
}

function intersectGrant(left: PermissionPathGrant, right: PermissionPathGrant, platform: ExecutorPlatform): PermissionPathGrant | undefined {
  if (containsGrant(left, right, platform)) return right;
  if (containsGrant(right, left, platform)) return left;
  return undefined;
}

function intersectGrantSets(left: PermissionPathGrant[], right: PermissionPathGrant[], platform: ExecutorPlatform): PermissionPathGrant[] {
  const intersections: PermissionPathGrant[] = [];
  for (const leftGrant of left) {
    for (const rightGrant of right) {
      const intersection = intersectGrant(leftGrant, rightGrant, platform);
      if (intersection) intersections.push(intersection);
    }
  }
  return compactGrants(intersections, platform);
}

function normalizeProfile(profile: PermissionProfile): PermissionProfile {
  if (profile.version !== 1) throw new Error(`Unsupported permission profile version ${String(profile.version)}`);
  if (!(["windows", "linux", "darwin"] as const).includes(profile.platform)) {
    throw new Error(`Unsupported executor platform ${String(profile.platform)}`);
  }
  if (!(profile.network in networkRank)) throw new Error(`Unsupported network permission ${String(profile.network)}`);
  if (!(profile.process.access in processRank)) throw new Error(`Unsupported process permission ${String(profile.process.access)}`);
  if (!(profile.secrets in secretRank)) throw new Error(`Unsupported secret permission ${String(profile.secrets)}`);
  if (profile.process.access === "deny" && (profile.process.interactive || profile.process.background)) {
    throw new Error("A denied process profile cannot allow interactive or background processes");
  }
  return {
    version: 1,
    platform: profile.platform,
    filesystem: {
      read: compactGrants(profile.filesystem.read, profile.platform),
      write: compactGrants(profile.filesystem.write, profile.platform),
      deny: compactGrants(profile.filesystem.deny, profile.platform),
    },
    network: profile.network,
    process: { ...profile.process },
    secrets: profile.secrets,
  };
}

function lowerPermission<T extends string>(left: T, right: T, ranks: Record<T, number>): T {
  return ranks[left] <= ranks[right] ? left : right;
}

function fullyDenied(grant: PermissionPathGrant, denies: PermissionPathGrant[], platform: ExecutorPlatform): boolean {
  return denies.some((deny) => containsGrant(deny, grant, platform));
}

export function intersectPermissionProfiles(layers: PermissionProfileLayer[]): EffectivePermissionProfile {
  if (layers.length === 0) throw new Error("At least one permission profile layer is required");
  const normalizedLayers = layers.map((layer) => {
    if (!layer.source.trim()) throw new Error("Permission profile layer source is required");
    return { source: layer.source, profile: normalizeProfile(layer.profile) };
  });
  const platform = normalizedLayers[0]!.profile.platform;
  if (normalizedLayers.some((layer) => layer.profile.platform !== platform)) {
    throw new Error("Permission profiles for different executor platforms cannot be intersected");
  }

  let read = normalizedLayers[0]!.profile.filesystem.read;
  let write = normalizedLayers[0]!.profile.filesystem.write;
  let deny = normalizedLayers[0]!.profile.filesystem.deny;
  let network = normalizedLayers[0]!.profile.network;
  let processAccess = normalizedLayers[0]!.profile.process.access;
  let interactive = normalizedLayers[0]!.profile.process.interactive;
  let background = normalizedLayers[0]!.profile.process.background;
  let secrets = normalizedLayers[0]!.profile.secrets;

  for (const layer of normalizedLayers.slice(1)) {
    read = intersectGrantSets(read, layer.profile.filesystem.read, platform);
    write = intersectGrantSets(write, layer.profile.filesystem.write, platform);
    deny = compactGrants([...deny, ...layer.profile.filesystem.deny], platform);
    network = lowerPermission(network, layer.profile.network, networkRank);
    processAccess = lowerPermission(processAccess, layer.profile.process.access, processRank);
    interactive = interactive && layer.profile.process.interactive;
    background = background && layer.profile.process.background;
    secrets = lowerPermission(secrets, layer.profile.secrets, secretRank);
  }

  read = read.filter((grant) => !fullyDenied(grant, deny, platform));
  write = write.filter((grant) => !fullyDenied(grant, deny, platform));
  if (processAccess === "deny") {
    interactive = false;
    background = false;
  }
  return {
    version: 1,
    platform,
    filesystem: { read, write, deny },
    network,
    process: { access: processAccess, interactive, background },
    secrets,
    sources: normalizedLayers.map((layer) => layer.source),
  };
}

export function allowsFileSystemPath(
  profile: EffectivePermissionProfile,
  access: "read" | "write",
  candidatePath: string,
): boolean {
  const candidate = normalizeGrant({ path: candidatePath, scope: "exact" }, profile.platform);
  return profile.filesystem[access].some((grant) => containsGrant(grant, candidate, profile.platform))
    && !profile.filesystem.deny.some((grant) => containsGrant(grant, candidate, profile.platform));
}

function allowsGrant(profile: EffectivePermissionProfile, access: "read" | "write", requirement: PermissionPathGrant): boolean {
  const normalized = normalizeGrant(requirement, profile.platform);
  return profile.filesystem[access].some((grant) => containsGrant(grant, normalized, profile.platform))
    && !profile.filesystem.deny.some((grant) => grantsOverlap(grant, normalized, profile.platform));
}

export function satisfiesPermissionRequirements(
  profile: EffectivePermissionProfile,
  requirements: PermissionRequirements,
): boolean {
  if (requirements.network && networkRank[profile.network] < networkRank[requirements.network]) return false;
  if (requirements.process && processRank[profile.process.access] < processRank[requirements.process]) return false;
  if (requirements.interactiveProcess && !profile.process.interactive) return false;
  if (requirements.backgroundProcess && !profile.process.background) return false;
  if (requirements.secrets && secretRank[profile.secrets] < secretRank[requirements.secrets]) return false;
  if (requirements.filesystem?.read?.some((grant) => !allowsGrant(profile, "read", grant))) return false;
  if (requirements.filesystem?.write?.some((grant) => !allowsGrant(profile, "write", grant))) return false;
  return true;
}
