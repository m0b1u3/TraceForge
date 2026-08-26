import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ensureDesktopData, resolveDesktopPaths } from "./desktop-paths.js";

describe("desktop data lifecycle", () => {
  it("keeps mutable data outside the application bundle and seeds safe MCP config", () => {
    const root = mkdtempSync(join(tmpdir(), "traceforge-desktop-"));
    const paths = resolveDesktopPaths(root);
    ensureDesktopData(paths);
    expect(paths.database.startsWith(root)).toBe(true);
    expect(JSON.parse(readFileSync(paths.mcpConfig, "utf8"))).toEqual({ servers: [] });
  });
});
