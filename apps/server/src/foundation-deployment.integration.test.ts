import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import Fastify from "fastify";
import { createDb, getSqliteClient } from "./db/client.js";
import { FoundationDeploymentControl, foundationDeploymentManifestSchema, resolveFoundationDeployment, type FoundationDeploymentInventory, type FoundationDeploymentManifest, type FoundationDeploymentOptions } from "./foundation-deployment.js";
import { registerSecurityAgentFoundation } from "./security-agent-foundation.js";
import { foundationHostControl } from "./foundation-host-control.js";
import { buildServer } from "./main.js";

const roots: string[] = [], dbs: Database.Database[] = [], apps: ReturnType<typeof Fastify>[] = [];
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const allow = { async authorize() { return { decision: "allowed" as const, authorizationRef: "independent-host-upgrade-review", expiresAt: "2099-01-01T00:00:00.000Z" }; } };
afterEach(async () => { for (const app of apps.splice(0)) await app.close(); for (const db of dbs.splice(0)) if (db.open) db.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function inventory(version = "1.0.0", model = "model-v1"): FoundationDeploymentInventory {
  const components: FoundationDeploymentInventory["components"] = [
    { kind: "foundation", id: "traceforge", version, digest: sha(`foundation:${version}`), required: true },
    { kind: "database_schema", id: "primary", version: "41", digest: sha("schema:41"), required: true },
    { kind: "native_helper", id: "sandbox", version, digest: sha(`helper:${version}`), required: true },
    { kind: "trust_root", id: "packages", version: "1", digest: sha("trust:1"), required: true },
    { kind: "scenario_package", id: "neutral-scenario", version: "1", digest: sha("scenario:1"), required: true },
    { kind: "skill", id: "investigate", version: "1", digest: sha("skill:1"), required: true },
    { kind: "knowledge_resource", id: "security-guidance", version: "1", digest: sha("knowledge:1"), required: true },
    { kind: "mcp_provider", id: "local-tools", version: "1", digest: sha("mcp:1"), required: true },
    { kind: "model_configuration", id: "primary", version: model, digest: sha(`model:${model}`), required: true },
    { kind: "capacity_policy", id: "host", version: "1", digest: sha("capacity:1"), required: true },
    { kind: "recovery_identity", id: "host-root", version: "1", digest: sha("recovery:1"), required: true },
  ];
  return { components, secretReferences: ["host-secret://model/primary", "host-secret://vault/master"] };
}
function manifest(releaseId: string, generation: number, value = inventory()): FoundationDeploymentManifest {
  return foundationDeploymentManifestSchema.parse({ format: 1, profile: "traceforge-foundation-deployment-v1", releaseId,
    deploymentGeneration: generation, createdAt: "2026-09-01T00:00:00.000Z", inventory: value,
    migration: { fromSchemaRevision: 41, toSchemaRevision: 41, planDigest: sha(`migration:${generation}`), rollbackCompatible: true } });
}
function fixture() {
  const root = mkdtempSync("/private/tmp/traceforge-deployment-"); roots.push(root);
  const audit = new Database(join(root, "audit.sqlite")); dbs.push(audit); let current = inventory();
  const options: FoundationDeploymentOptions = { auditDb: audit, controlRoot: join(root, "control"), authorizer: allow,
    currentInventory: () => current, startupContext: { databasePath: join(root, "active.sqlite") } };
  const control = new FoundationDeploymentControl(options);
  const stage = (value: FoundationDeploymentManifest, commandId = `stage_${value.releaseId}`) => control.execute({ operation: "stage", commandId, manifest: value, actor: "operator", reason: "Stage reviewed complete host release" });
  const request = (operation: "activate" | "rollback", value: FoundationDeploymentManifest, commandId: string) => {
    const active = control.inspect().active, preview = control.preview({ operation, releaseId: value.releaseId, deploymentGeneration: value.deploymentGeneration, expectedSwitchGeneration: active?.switchGeneration ?? 0 });
    return { operation, commandId, releaseId: value.releaseId, deploymentGeneration: value.deploymentGeneration,
      expectedSwitchGeneration: active?.switchGeneration ?? 0, planFingerprint: preview.planFingerprint, actor: "operator", reason: "Switch the complete reviewed host generation" };
  };
  return { root, audit, options, control, stage, request, setCurrent(value: FoundationDeploymentInventory) { current = value; } };
}
async function crash(root: string, phase: string, request: unknown, current: FoundationDeploymentInventory) {
  writeFileSync(join(root, "deployment-crash.json"), JSON.stringify({ request, current }));
  const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("../test-fixtures/foundation-deployment-crash-host.mjs", import.meta.url)), root, phase], { stdio: ["ignore", "pipe", "pipe"] }), errors: string[] = [];
  child.stderr.on("data", chunk => errors.push(String(chunk)));
  await new Promise<void>((resolve, reject) => { const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("Deployment crash fixture deadline exceeded")); }, 15_000);
    child.on("error", error => { clearTimeout(timer); reject(error); }); child.on("exit", (code, signal) => { clearTimeout(timer); signal === "SIGKILL" ? resolve() : reject(new Error(`Unexpected deployment crash exit ${code}: ${errors.join("")}`)); }); });
}

describe("trusted host deployment generation", () => {
  it("publishes a non-secret manifest and atomically activates it after exact preflight", async () => {
    const f = fixture(), release = manifest("release1", 1); await f.stage(release); const activation = f.request("activate", release, "activate1");
    const result = await f.control.execute(activation); expect(result).toMatchObject({ replayed: false, audit: { status: "completed", restartRequired: true }, active: { switchGeneration: 1, active: { releaseId: "release1" } } });
    expect(resolveFoundationDeployment(f.options, { databasePath: "active.sqlite" })?.preflight.ready).toBe(true);
    const body = readFileSync(join(f.options.controlRoot, "release-1-release1", "manifest.json"), "utf8");
    expect(body).toContain("host-secret://model/primary"); expect(body).not.toMatch(/password|api[_-]?key|private[_-]?key/i);
  });

  it("blocks startup and switching on missing, unexpected, drifted or unresolved host material", async () => {
    const f = fixture(), release = manifest("release1", 1); await f.stage(release);
    const changed = inventory(); changed.components = changed.components.filter(item => item.kind !== "native_helper");
    changed.components.push({ kind: "foundation", id: "unexpected", version: "1", digest: sha("unexpected"), required: true }); changed.secretReferences = ["host-secret://model/primary"];
    f.setCurrent(changed); expect(() => f.control.preview({ operation: "activate", releaseId: "release1", deploymentGeneration: 1, expectedSwitchGeneration: 0 })).toThrow("preflight");
    f.setCurrent(inventory()); const activation = f.request("activate", release, "activate1"); await f.control.execute(activation);
    f.setCurrent(inventory("1.0.1")); expect(() => resolveFoundationDeployment(f.options, { databasePath: "active.sqlite" })).toThrow("preflight failed");
  });

  it("rejects embedded secrets, duplicate identities, stale plans, default denial and command conflicts", async () => {
    expect(() => manifest("bad", 1, { components: inventory().components, secretReferences: ["plaintext-secret"] })).toThrow();
    const duplicate = inventory(); duplicate.components.push(duplicate.components[0]!); expect(() => manifest("duplicate", 1, duplicate)).toThrow("Duplicate");
    const f = fixture(), denied = new FoundationDeploymentControl({ ...f.options, authorizer: undefined });
    await expect(denied.execute({ operation: "stage", commandId: "denied", manifest: manifest("denied", 1), actor: "operator", reason: "Denied" })).rejects.toThrow("authorization");
    const release = manifest("release1", 1); await f.stage(release); await expect(f.control.execute({ operation: "stage", commandId: "stage_release1", manifest: manifest("other", 2), actor: "operator", reason: "Conflict" })).rejects.toThrow("conflict");
    const activation = f.request("activate", release, "activate1"); await expect(f.control.execute({ ...activation, planFingerprint: "a".repeat(64) })).rejects.toThrow("plan changed");
  });

  it("switches whole generations and only rolls back to the adjacent prior release", async () => {
    const f = fixture(), first = manifest("release1", 1); await f.stage(first); await f.control.execute(f.request("activate", first, "activate1"));
    const secondInventory = inventory("2.0.0", "model-v2"), second = manifest("release2", 2, secondInventory); f.setCurrent(secondInventory); await f.stage(second); await f.control.execute(f.request("activate", second, "activate2"));
    expect(f.control.inspect().active).toMatchObject({ switchGeneration: 2, active: { releaseId: "release2" }, previous: { releaseId: "release1" } });
    expect(() => f.control.preview({ operation: "rollback", releaseId: "release2", deploymentGeneration: 2, expectedSwitchGeneration: 2 })).toThrow("immediately previous");
    f.setCurrent(inventory()); await f.control.execute(f.request("rollback", first, "rollback1")); expect(f.control.inspect().active).toMatchObject({ switchGeneration: 3, active: { releaseId: "release1" }, previous: { releaseId: "release2" } });
  });

  it("rechecks the exact host material after authorization and before pointer publication", async () => {
    const f = fixture(), release = manifest("release1", 1); await f.stage(release); const request = f.request("activate", release, "activate1"); let reads = 0;
    const guarded = new FoundationDeploymentControl({ ...f.options, currentInventory: () => ++reads === 2 ? inventory("drifted") : inventory() });
    await expect(guarded.execute(request)).rejects.toThrow("changed after authorization"); expect(guarded.inspect().active).toBeNull();
  });

  it("runs production preflight before opening the database or connecting runtime dependencies", async () => {
    const f = fixture(), release = manifest("release1", 1); await f.stage(release); await f.control.execute(f.request("activate", release, "activate1"));
    const dbPath = join(f.root, "must-not-open.sqlite"); f.setCurrent(inventory("drifted"));
    await expect(buildServer(dbPath, join(f.root, "missing-mcp.json"), join(f.root, "missing-model.json"), f.root, undefined, { deployment: f.options })).rejects.toThrow("preflight failed");
    expect(existsSync(dbPath)).toBe(false);
    f.setCurrent(inventory()); const app = await buildServer(dbPath, join(f.root, "missing-mcp.json"), join(f.root, "missing-model.json"), f.root, undefined, { deployment: f.options }); apps.push(app);
    expect((await app.inject({ url: "/api/health" })).json()).toMatchObject({ status: "ok", deployment: { managed: true, releaseId: "release1", deploymentGeneration: 1, switchGeneration: 1 } });
  });

  it("exposes deployment control only through the trusted management channel", async () => {
    const f = fixture(), sqlite = getSqliteClient(createDb(join(f.root, "foundation.sqlite"))); dbs.push(sqlite); const app = Fastify(); apps.push(app);
    registerSecurityAgentFoundation(app, sqlite, {} as never, f.root, () => false, { deployment: f.options });
    expect((await app.inject({ url: "/api/foundation/deployment" })).statusCode).toBe(401); const headers = foundationHostControl(app).management().headers();
    expect((await app.inject({ url: "/api/foundation/deployment", headers })).json()).toMatchObject({ enabled: true, secretValuesPersisted: false });
  });

  it.each(["stage_started", "stage_published"])("keeps audit immutable and reconciles %s after a real SIGKILL", async phase => {
    const f = fixture(), release = manifest("crash-stage", 1), request = { operation: "stage", commandId: "crash_stage", manifest: release, actor: "operator", reason: "Crash stage" };
    await crash(f.root, phase, request, inventory()); if (phase === "stage_published") expect(existsSync(join(f.options.controlRoot, "release-1-crash-stage", "READY"))).toBe(true);
    expect(await f.control.execute(request)).toMatchObject({ audit: { status: "staged" } }); expect(existsSync(join(f.options.controlRoot, "release-1-crash-stage", "READY"))).toBe(true);
    expect(() => f.audit.exec("DELETE FROM foundation_deployment_events")).toThrow("immutable");
  });

  it.each(["switch_prepared", "switch_published", "switch_completed"])("reconciles %s without a second generation switch", async phase => {
    const f = fixture(), release = manifest("release1", 1); await f.stage(release); const request = f.request("activate", release, "crash_activate"); await crash(f.root, phase, request, inventory());
    const result = await f.control.execute(request); expect(result).toMatchObject({ audit: { status: "completed" }, active: { switchGeneration: 1, active: { releaseId: "release1" } } });
    expect((f.audit.prepare("SELECT count(*) count FROM foundation_deployment_events WHERE event_type LIKE 'switch_completed%'").get() as { count: number }).count).toBe(1);
  });
});
