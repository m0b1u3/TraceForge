import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ensureDesktopData, resolveDesktopPaths } from "./desktop-paths.js";

describe("desktop data lifecycle", () => {
  it("keeps mutable data outside the application bundle without seeding legacy MCP config", () => {
    const root = mkdtempSync(join(tmpdir(), "traceforge-desktop-"));
    const paths = resolveDesktopPaths(root);
    ensureDesktopData(paths);
    expect(paths.database.startsWith(root)).toBe(true);
    expect(paths.llmSecrets.startsWith(paths.configDirectory)).toBe(true);
    expect(existsSync(paths.mcpConfig)).toBe(false);
  });

  it("keeps management credentials inside fixed host IPC and never attaches them to renderer networking", () => {
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "main.ts"), "utf8");
    expect(source).toContain("foundationHostControl(server).management()");
    expect(source).not.toContain("onBeforeSendHeaders");
    expect(source).toContain("server.inject(");
    expect(source).toContain("createConversationBridge(");
    expect(source).not.toMatch(/loadURL\([^)]*(?:authorization|tfh_)/i);
  });
});
