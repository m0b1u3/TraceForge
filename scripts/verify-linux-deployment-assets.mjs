import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(".");
const packagingRoot = resolve(root, "packages/linux-sandbox-helper/packaging");
const launcherPath = resolve(packagingRoot, "traceforge-sandboxed");
const installPath = resolve(packagingRoot, "deb-after-install.sh");
const removePath = resolve(packagingRoot, "deb-after-remove.sh");
const profilePath = resolve(packagingRoot, "apparmor/usr.lib.traceforge.traceforge-linux-sandbox");

for (const path of [launcherPath, installPath, removePath, profilePath]) {
  if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`Linux deployment asset is missing: ${path}`);
}
for (const path of [launcherPath, installPath, removePath]) {
  if ((statSync(path).mode & 0o111) === 0) throw new Error(`Linux deployment script is not executable: ${path}`);
  const syntax = spawnSync("sh", ["-n", path], { encoding: "utf8" });
  if (syntax.error) throw syntax.error;
  if (syntax.status !== 0) throw new Error(`Linux deployment script syntax failed: ${path}: ${syntax.stderr.trim()}`);
}

const desktop = JSON.parse(readFileSync(resolve(root, "apps/desktop/package.json"), "utf8"));
if (JSON.stringify(desktop.build?.linux?.target) !== JSON.stringify(["deb"])) {
  throw new Error("The supported Linux Desktop release must be DEB-only until another installer can provision the same OS policy");
}
if (desktop.build?.linux?.executableName !== "traceforge-desktop"
  || desktop.build?.linux?.desktop?.entry?.Exec !== "/usr/bin/traceforge %U") {
  throw new Error("The Linux desktop entry must use the delegated TraceForge launcher");
}
const linuxResources = JSON.stringify(desktop.build?.linux?.extraResources ?? []);
if (!linuxResources.includes("packages/execution-node/native")
  || !linuxResources.includes("packages/linux-sandbox-helper/packaging")) {
  throw new Error("The Linux DEB must carry both measured native and reviewed deployment assets");
}
for (const dependency of ["apparmor", "libsecret-1-0", "systemd"]) {
  if (!desktop.build?.deb?.depends?.includes(dependency)) throw new Error(`Linux DEB dependency is missing: ${dependency}`);
}
if (desktop.build?.deb?.afterInstall !== "../../packages/linux-sandbox-helper/packaging/deb-after-install.sh"
  || desktop.build?.deb?.afterRemove !== "../../packages/linux-sandbox-helper/packaging/deb-after-remove.sh") {
  throw new Error("Linux DEB lifecycle hooks are not wired to the reviewed deployment scripts");
}

const launcher = readFileSync(launcherPath, "utf8");
for (const required of [
  "/usr/lib/traceforge/traceforge-linux-sandbox",
  "/usr/lib/traceforge/release.json",
  "systemd-run --user --scope",
  "--property=Delegate=yes",
  "+cpu +io +memory +pids",
  "TRACEFORGE_LINUX_DEPLOYMENT_MODE",
  "TRACEFORGE_LINUX_CGROUP_ROOT",
  "TRACEFORGE_LINUX_SANDBOX_SCRATCH_ROOT",
]) {
  if (!launcher.includes(required)) throw new Error(`Linux delegated launcher is missing: ${required}`);
}
const install = readFileSync(installPath, "utf8");
if (!install.includes("apparmor_parser -r") || !install.includes("/usr/bin/traceforge")
  || !install.includes("/usr/lib/traceforge") || !install.includes("rollback") || !install.includes("mktemp -d")) {
  throw new Error("Linux DEB install hook does not install and load the fixed native security boundary");
}
const remove = readFileSync(removePath, "utf8");
if (!remove.includes("apparmor_parser -R") || !remove.includes("upgrade|failed-upgrade")) {
  throw new Error("Linux DEB removal hook does not preserve upgrades and unload policy on uninstall");
}
const profile = readFileSync(profilePath, "utf8");
if (!profile.includes("/usr/lib/traceforge/traceforge-linux-sandbox") || !/\buserns\b/.test(profile)) {
  throw new Error("AppArmor policy is not attached to the fixed helper path with user namespace permission");
}

console.log("Verified Linux DEB deployment assets, delegated launcher, AppArmor lifecycle and fail-closed package boundary.");
