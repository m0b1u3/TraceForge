import { describe, expect, it } from "vitest";
import { buildServer, resolveListenConfig, trustedUiOrigin } from "./main.js";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { foundationHostControl } from "./foundation-host-control.js";
import { createDb, getSqliteClient } from "./db/client.js";
import { FoundationBackupControl } from "./foundation-backup.js";

describe("server listen configuration", () => {
  it("boots an isolated restore before model/MCP configuration or execution node startup", async () => {
    const root = mkdtempSync("/private/tmp/traceforge-main-restore-");
    const sqlite = getSqliteClient(createDb(join(root, "source.sqlite")));
    const options = { backupRoot: join(root, "backups"), restoreRoot: join(root, "restores"),
      authorizer: { async authorize() { return { decision: "allowed" as const, authorizationRef: "host-review", expiresAt: "2099-01-01T00:00:00.000Z" }; } } };
    try {
      const control = new FoundationBackupControl(sqlite, options);
      const saved = await control.execute({ commandId: "backup", operation: "backup", actor: "operator", reason: "Rehearsal" });
      await control.execute({ commandId: "restore", operation: "restore", backupId: "backup", manifestDigest: saved.manifestDigest, actor: "operator", reason: "Rehearsal" });
      const path = join(options.restoreRoot, "restore", "database.sqlite"), before = readFileSync(path);
      const invalid = join(root, "invalid.json"); writeFileSync(invalid, "not JSON");
      const app = await buildServer(path, invalid, invalid, join(root, "fresh-host"));
      try {
        expect((await app.inject({ url: "/api/health" })).json()).toMatchObject({ status: "inspection_only", executionNodeReady: false, mcpTools: 0 });
        const headers = foundationHostControl(app).management().headers();
        expect((await app.inject({ url: "/api/foundation/recovery", headers })).json()).toMatchObject({ automaticResume: false });
        expect((await app.inject({ url: "/api/config/llm", headers })).statusCode).toBe(404);
        expect(existsSync(join(root, "fresh-host", "data", "secrets", "vault.key"))).toBe(false);
        expect(readFileSync(path)).toEqual(before);
      } finally { await app.close(); }
    } finally { sqlite.close(); rmSync(root, { recursive: true, force: true }); }
  });
  it("accepts only loopback UI origins unless explicitly configured", () => {
    expect(trustedUiOrigin("http://127.0.0.1:5173", {})).toBe(true);
    expect(trustedUiOrigin("http://localhost:4000", {})).toBe(true);
    expect(trustedUiOrigin("https://attacker.example", {})).toBe(false);
    expect(trustedUiOrigin("https://console.example", { TRACEFORGE_ALLOWED_ORIGINS: "https://console.example" })).toBe(true);
  });

  it("uses local safe defaults", () => {
    expect(resolveListenConfig({})).toEqual({ host: "127.0.0.1", port: 4000 });
  });

  it("accepts an explicit host and port for process supervision", () => {
    expect(resolveListenConfig({ TRACEFORGE_HOST: "0.0.0.0", TRACEFORGE_PORT: "4400" })).toEqual({ host: "0.0.0.0", port: 4400 });
  });

  it.each(["0", "65536", "not-a-port", "4000.5"])("rejects invalid port %s", (port) => {
    expect(() => resolveListenConfig({ TRACEFORGE_PORT: port })).toThrow("TRACEFORGE_PORT");
  });

  it("exposes a secret-free health response when optional integrations are unavailable", async () => {
    const app = await buildServer(":memory:", "missing-mcp.json", "missing-llm.json");
    const response = await app.inject({ method: "GET", url: "/api/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: "ok",
      llmConfigured: false,
      mcpTools: 0,
      executionNodeReady: expect.any(Boolean),
      executionProcessReady: expect.any(Boolean),
      deployment: { managed: false },
    });
    expect(response.body).not.toMatch(/api.?key|secret/i);
    await app.close();
  });

  it("rejects API calls and WebSocket handshakes from an untrusted browser origin", async () => {
    const app = await buildServer(":memory:", "missing-mcp.json", "missing-llm.json");
    expect((await app.inject({ method: "GET", url: "/api/health", headers: { origin: "https://attacker.example" } })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: "/ws", headers: { origin: "https://attacker.example", upgrade: "websocket", connection: "Upgrade" } })).statusCode).toBe(403);
    await app.close();
  });

  it("fences legacy application APIs as well as foundation routes", async () => {
    const app=await buildServer(":memory:","missing-mcp.json","missing-llm.json");
    try {
      for(const url of ["/api/cases","/api/config/llm","/api/scenarios/definitions"]) {
        expect((await app.inject({url})).statusCode).toBe(401);
      }
      const management=foundationHostControl(app).management();
      expect((await app.inject({url:"/api/cases",headers:management.headers()})).statusCode).toBe(200);
      expect((await app.inject({url:"/api/scenarios/definitions",headers:management.headers()})).statusCode).toBe(200);
    } finally { await app.close(); }
  });

  it("serves the production web application and preserves JSON API 404s", async () => {
    const webRoot = mkdtempSync(join(tmpdir(), "traceforge-web-"));
    writeFileSync(join(webRoot, "index.html"), "<!doctype html><title>TraceForge Desktop</title>");
    const app = await buildServer(":memory:", "missing-mcp.json", "missing-llm.json", webRoot, webRoot);
    expect((await app.inject({ url: "/" })).body).toContain("TraceForge Desktop");
    expect((await app.inject({ url: "/workspace/deep-link" })).body).toContain("TraceForge Desktop");
    const missingApi = await app.inject({ url: "/api/does-not-exist" });
    expect(missingApi.statusCode).toBe(404);
    expect(missingApi.json()).toEqual({ error: "not found" });
    await app.close();
  });
});
