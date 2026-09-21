import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { bundledBrowserInstallation } from "./bundled-browser.js";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "traceforge-bundled-browser-")); roots.push(root);
  const resources = join(root, "resources"), browser = join(resources, "browser-runtime"), user = join(root, "user");
  await mkdir(join(browser, "release"), { recursive: true }); await mkdir(user);
  const metadata = { format: 1, platform: process.platform, architecture: process.arch,
    nodeSha256: "a".repeat(64), expectedSandboxBackend: "fixture", expectedBackendMeasurement: "b".repeat(64),
    resources: { cpuTimeMs: 1000, memoryBytes: 1000000, maximumProcesses: 10, writeBytes: 1000 } };
  await writeFile(join(browser, "installation.json"), JSON.stringify(metadata));
  await writeFile(join(browser, "source-authority.json"), "{}");
  await writeFile(join(browser, process.platform === "win32" ? "node.exe" : "node"), "fixture only");
  return { resources, browser, user, metadata };
}
describe("application-owned browser assembly", () => {
  it("resolves fixed bundled materials and separate private scratch without searching local browsers", async () => {
    const f = await fixture(), installation = await bundledBrowserInstallation(f.resources, f.user);
    expect(installation).toMatchObject({ isolation: "chromium", nodeSha256: f.metadata.nodeSha256, expectedSandboxBackend: "fixture" });
    expect(installation?.releaseDirectory).toContain("browser-runtime/release");
    expect(installation?.scratchDirectory).toContain("user/browser-scratch");
  });
  it("rejects missing material instead of falling back to an installed Chrome", async () => {
    const f = await fixture(); await rm(join(f.browser, "source-authority.json"));
    await expect(bundledBrowserInstallation(f.resources, f.user)).rejects.toThrow();
  });
  it("rejects foreign platform and external path injection", async () => {
    const f = await fixture();
    await writeFile(join(f.browser, "installation.json"), JSON.stringify({ ...f.metadata, executable: "/Applications/Chrome" }));
    await expect(bundledBrowserInstallation(f.resources, f.user)).rejects.toThrow("incompatible");
    await writeFile(join(f.browser, "installation.json"), JSON.stringify({ ...f.metadata, platform: "foreign" }));
    await expect(bundledBrowserInstallation(f.resources, f.user)).rejects.toThrow("incompatible");
  });
  it("rejects symlink escapes and a redirected scratch directory", async () => {
    const f = await fixture(), node = join(f.browser, process.platform === "win32" ? "node.exe" : "node");
    await rm(node); await writeFile(join(f.user, "outside-node"), "fixture"); await symlink(join(f.user, "outside-node"), node);
    await expect(bundledBrowserInstallation(f.resources, f.user)).rejects.toThrow("escapes");
    await rm(node); await writeFile(node, "fixture"); await symlink(f.resources, join(f.user, "browser-scratch"));
    await expect(bundledBrowserInstallation(f.resources, f.user)).rejects.toThrow("private");
  });
  it("uses Electron-owned embedded assembly instead of the retired standalone bundle and keeps release gates enabled", () => {
    const main = readFileSync(new URL("./main.ts", import.meta.url), "utf8");
    expect(main).toContain("const embeddedBrowser = new EmbeddedBrowser()");
    expect(main).toContain("embeddedBrowser: artifacts => embeddedBrowser.deployment(artifacts)");
    expect(main).not.toContain("bundledBrowserInstallation");
    const embedded = readFileSync(new URL("./embedded-browser.ts", import.meta.url), "utf8");
    expect(embedded).toContain("new WebContentsView");
    expect(embedded).toContain("sandbox: true");
    expect(embedded).toContain("nodeIntegration: false");
    expect(embedded).not.toContain("--no-sandbox");
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(pkg.build.extraResources).not.toContainEqual({ from: "runtime/browser-runtime", to: "browser-runtime", filter: ["**/*"] });
    expect(pkg.scripts.pack).toContain("desktop-release-unavailable");
  });
});
