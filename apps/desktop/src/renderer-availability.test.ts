import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { requireDesktopRenderer } from "./renderer-availability.js";

describe("legacy renderer retirement", () => {
  it("requires replacement renderer assets and never falls back to the old UI", () => {
    expect(() => requireDesktopRenderer("relative")).toThrow("尚未构建");
    expect(() => requireDesktopRenderer(resolve("missing-renderer-fixture"))).toThrow("尚未构建");
    expect(() => requireDesktopRenderer(resolve("apps/web/renderer"))).not.toThrow();
    const main = readFileSync(resolve("apps/desktop/src/main.ts"), "utf8");
    expect(main.indexOf("  requireDesktopRenderer(webRoot);")).toBeLessThan(main.indexOf("  ensureDesktopData(paths);"));
    expect(main).toContain("../../web/renderer/dist");
    expect(main).not.toMatch(/autoUpdater|configureUpdates/);
    expect(readFileSync(resolve("apps/desktop/src/preload.cts"), "utf8")).not.toContain("updates:");
  });
  it("fails explicitly instead of building or serving stale assets", () => {
    const result = spawnSync(process.execPath, [resolve("scripts/desktop-release-unavailable.mjs")], { encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Desktop release acceptance incomplete");
  });
  it("keeps legacy UI builds and production desktop packaging disabled", () => {
    const web = JSON.parse(readFileSync(resolve("apps/web/package.json"), "utf8"));
    const desktop = JSON.parse(readFileSync(resolve("apps/desktop/package.json"), "utf8"));
    expect(web.scripts.dev).toBeUndefined();
    expect(web.scripts.build).toBe("pnpm build:desktop-preview");
    for (const command of ["pack", "dist", "dist:win", "dist:mac", "dist:linux"].map(key => desktop.scripts[key])) {
      expect(command).toBe("node ../../scripts/desktop-release-unavailable.mjs");
    }
    expect(readFileSync(resolve("scripts/build-desktop-release.mts"), "utf8").startsWith('import "./desktop-release-unavailable.mjs";')).toBe(true);
  });
  it("removes the legacy UI and its client state rather than reusing it", () => {
    for (const file of ["index.html", "src/App.tsx", "src/api.ts", "src/store.ts", "src/styles/globals.css", "vite.config.ts"]) {
      expect(existsSync(resolve("apps/web", file))).toBe(false);
    }
  });
});
