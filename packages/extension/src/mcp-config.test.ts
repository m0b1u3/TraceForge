import { describe, it, expect } from "vitest";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMcpConfig } from "./mcp-config.js";

function tmpConfig(obj: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "mcpcfg-"));
  const p = join(dir, "mcp.json");
  writeFileSync(p, JSON.stringify(obj));
  return p;
}

describe("loadMcpConfig", () => {
  it("returns [] when file is missing", () => {
    expect(loadMcpConfig(join(tmpdir(), "does-not-exist-xyz.json"))).toEqual([]);
  });

  it("parses a valid server config with defaults", () => {
    const p = tmpConfig({ servers: [{ name: "filesystem", command: "npx", args: ["-y", "srv"] }] });
    const cfg = loadMcpConfig(p);
    expect(cfg).toHaveLength(1);
    expect(cfg[0].name).toBe("filesystem");
    expect(cfg[0].trustLevel).toBe("command"); // 默认
    expect(cfg[0].args).toEqual(["-y", "srv"]);
  });

  it("defaults args to [] when omitted", () => {
    const p = tmpConfig({ servers: [{ name: "s", command: "run" }] });
    expect(loadMcpConfig(p)[0].args).toEqual([]);
  });

  it("accepts trustLevel normal and optional env", () => {
    const p = tmpConfig({ servers: [{ name: "s", command: "run", trustLevel: "normal", env: { K: "v" } }] });
    const c = loadMcpConfig(p)[0];
    expect(c.trustLevel).toBe("normal");
    expect(c.env).toEqual({ K: "v" });
  });

  it("rejects an invalid name (returns [] on schema failure)", () => {
    const p = tmpConfig({ servers: [{ name: "Bad Name!", command: "run" }] });
    expect(loadMcpConfig(p)).toEqual([]);
  });

  it("returns [] on malformed json", () => {
    const dir = mkdtempSync(join(tmpdir(), "mcpcfg-"));
    const p = join(dir, "mcp.json");
    writeFileSync(p, "{ not json");
    expect(loadMcpConfig(p)).toEqual([]);
  });
});
