import { afterEach, expect, it } from "vitest";
import Fastify from "fastify";
import { ScenarioPackageRegistry } from "@traceforge/scenario-sdk";
import { DesktopConfigurationStore, registerDesktopConfigurationRoutes } from "./desktop-configuration.js";
import { PackageContextDiscoverySource, SqlitePackageContextStore, contextContentDigest } from "./package-context-resources.js";
import { contextPackage, contextBinding, contextText } from "./test-fixtures/context-package.js";
import { database, initialize } from "./test-fixtures/execution-recovery.js";
import { SqliteScenarioAuthorizationService } from "./scenario-authorization.js";
import type { ToolExecutionContext } from "@traceforge/worker-runtime";
import { foundationHost, eventually } from "./test-fixtures/foundation-host.js";
import { renderGuidanceTemplate } from "@traceforge/shared/desktop-configuration";

const cleanup: Array<() => void | Promise<void>> = [];

it("automatically supplies scoped role templates to Worker model input without a context tool call",async()=>{
  let observed=false;
  const h=await foundationHost({foundation:{scenarioPackageRegistry:new ScenarioPackageRegistry([contextPackage()]),toolDiscoverySources:[],contextResourceContents:[{package:contextBinding,resourceId:"first",content:contextText}]},model:async args=>{
    expect(args.user).toContain("Follow Observe in observe as worker");observed=true;return {type:"complete",summary:"Guidance consumed",outputs:[]};}});cleanup.push(()=>h.close());
  await h.request("/api/desktop/configuration",{package:contextBinding,expectedRevision:0,resources:[],mcp:[],userResources:[{id:"user.role",parentId:"first",kind:"prompt",title:"Role instruction",content:"Follow {{goal}} in {{phase}} as {{role}}",enabled:true,roles:["worker"],phases:[]}]});
  await h.start();await eventually(async()=>(await h.state()).workItems[0]?.status==="completed");expect(observed).toBe(true);
  expect(()=>renderGuidanceTemplate("{{unknown}}",{})).toThrow("Unknown");
});

it("previews compatible prior-version edits without deleting the old revision",()=>{
  const f=fixture();f.save("Old edited guidance");
  const pkg={...contextPackage(["observe"]),version:"2.0.0"}, binding={...contextBinding,version:"2.0.0"};
  const packages=new ScenarioPackageRegistry([pkg]);f.content.install(packages,[{package:binding,resourceId:"first",content:contextText}]);
  const store=new DesktopConfigurationStore(f.sqlite,packages,f.content);
  const preview=store.previewImport({package:binding,expectedRevision:0,from:contextBinding});
  expect(preview.draft.resources[0]!.content).toBe("Old edited guidance");expect(preview.conflicts).toEqual([]);
  expect(store.snapshot().packages[0]!.revision).toBe(0);store.save(preview.draft);
  expect(f.store.snapshot().packages[0]!.resources[0]!.content).toBe("Old edited guidance");
});

it("pins user-created guidance, preserves it for older clients and enforces inherited scope", async () => {
  const f = fixture();
  const user = { id: "user.first", parentId: "first", kind: "skill" as const, title: "My guidance", content: "Pinned custom guidance", enabled: true, roles: ["worker" as const], phases: [] };
  f.store.save({ package: contextBinding, expectedRevision: 0, resources: [], mcp: [], userResources: [user] });
  f.save(null);
  expect(f.store.snapshot().packages[0]!.userResources).toEqual([user]);
  expect(() => f.store.save({ package: contextBinding, expectedRevision: 2, resources: [], mcp: [], userResources: [{ ...user, roles: ["planner"] }] })).toThrow("scope");
  const controls = f.start();
  f.store.save({ package: contextBinding, expectedRevision: 2, resources: [], mcp: [], userResources: [] });
  const source = new PackageContextDiscoverySource(f.packages, f.content, f.sqlite, id => controls.runtime.load(id) ?? null, new Map(), f.store);
  const ctx = { runId: "run", caseId: "case", workId: "work", workerId: "worker", scopeRef: "scope", leaseId: "lease", leaseExpiresAt: "2099-01-01", idempotencyKey: "custom-read" } as ToolExecutionContext;
  const selected = source.selection(ctx).resources.find(r => r.id === user.id)!;
  expect(selected).toBeDefined();
  expect(selected.context?.skill).toBeUndefined();
  const result = await (await source.discover()).find(t => t.name === "context.read")!.execute({ id: user.id, digest: selected.digest }, ctx);
  expect(result.status).toBe("succeeded");
  expect(JSON.parse(result.raw).content).toBe(user.content);
  f.content.revoke(contextContentDigest(contextText), "withdrawn");
  expect(source.selection(ctx).resources).toEqual([]);
});
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
function fixture(beforeRun = true) {
  const sqlite = database(); cleanup.push(() => sqlite.close());
  const pkg = contextPackage(["observe"]); pkg.resourceManifest!.resources[0]!.context!.requiredCapabilities = ["observe"];
  const packages = new ScenarioPackageRegistry([pkg]), content = new SqlitePackageContextStore(sqlite);
  content.install(packages, [{ package: contextBinding, resourceId: "first", content: contextText }]);
  if (!beforeRun) initialize(sqlite);
  const store = new DesktopConfigurationStore(sqlite, packages, content);
  const save = (text: string | null, enabled = true, revision = store.snapshot().packages[0]!.revision) => store.save({
    package: contextBinding, expectedRevision: revision, resources: [{ id: "first", enabled, content: text }], mcp: [] });
  function start() {
    const controls = beforeRun ? initialize(sqlite) : null;
    sqlite.prepare("INSERT INTO scenario_authorizations(id,case_id,scenario_kind,scope_json,status,approved_by,expires_at,created_at,updated_at) VALUES ('scope','case','neutral','{}','active','test','2099-01-01T00:00:00Z','2026-01-01','2026-01-01')").run();
    new SqliteScenarioAuthorizationService(sqlite, packages).pin("scope", "case", contextBinding, 0);
    return controls!;
  }
  return { sqlite, packages, content, store, save, start };
}

it("saves independent text revisions and rejects stale writes, invalid entries and unreviewed MCP", () => {
  const f = fixture();
  expect(f.save("User guidance").packages[0]).toMatchObject({ revision: 1, resources: [{ content: "User guidance", defaultContent: contextText }] });
  expect(f.content.read(contextBinding, f.packages.list()[0]!.resourceManifest!.resources[0]!)).toBe(contextText);
  expect(() => f.save("stale", true, 0)).toThrow("changed");
  expect(() => f.save("字".repeat(30000))).toThrow("64 KiB");
  expect(() => f.store.save({ package: contextBinding, expectedRevision: 1, resources: [{ id: "unknown", content: "x", enabled: true }], mcp: [] })).toThrow("editable");
  expect(() => f.store.save({ package: contextBinding, expectedRevision: 1, resources: [], mcp: [{ source: "unknown", profileDigest: `sha256:${"a".repeat(64)}`, enabled: true, tools: [] }] })).toThrow("reviewed");
  expect(f.save(null).packages[0]!.resources[0]!.content).toBeNull();
});

it("pins configuration at Run creation and actual context.read returns it after edits and restart", async () => {
  const f = fixture(); f.save("First configured guidance"); const controls = f.start();
  f.save("Later guidance");
  const restarted = new DesktopConfigurationStore(f.sqlite, f.packages, f.content);
  const source = new PackageContextDiscoverySource(f.packages, f.content, f.sqlite, id => controls.runtime.load(id) ?? null, new Map(), restarted);
  const ctx = { runId: "run", caseId: "case", workId: "work", workerId: "worker", scopeRef: "scope", leaseId: "lease", leaseExpiresAt: "2099-01-01", idempotencyKey: "read" } as ToolExecutionContext;
  const resource = source.selection(ctx).resources[0]!;
  expect(resource.digest).toBe(contextContentDigest("First configured guidance"));
  const result = await (await source.discover()).find(t => t.name === "context.read")!.execute({ id: "first", digest: resource.digest }, ctx);
  expect(result.status).toBe("succeeded"); expect(JSON.parse(result.raw).content).toBe("First configured guidance");
  expect(source.observationIsCurrent(result.raw, ctx)).toBe(true);
  f.content.revoke(contextContentDigest(contextText), "withdrawn");
  expect(source.selection(ctx).resources).toEqual([]);
  expect(source.observationIsCurrent(result.raw, ctx)).toBe(false);
});

it("disabled resources disappear from discovery and old Runs retain defaults", () => {
  const f = fixture(); f.save(null, false); const controls = f.start();
  const source = new PackageContextDiscoverySource(f.packages, f.content, f.sqlite, id => controls.runtime.load(id) ?? null, new Map(), f.store);
  expect(source.selectionForReader("run", "case", "work", "worker").resources).toEqual([]);
  const old = fixture(false); old.save("Not for existing Run");
  const original = old.packages.list()[0]!.resourceManifest!.resources[0]!;
  expect(old.store.resource("run", contextBinding, original)?.digest).toBe(original.digest);
});

it("desktop API persists and reports conflicts without changing a signed resource", async () => {
  const f = fixture(), app = Fastify(); cleanup.push(() => app.close()); registerDesktopConfigurationRoutes(app, f.store);
  expect((await app.inject({ method: "GET", url: "/api/desktop/configuration" })).json().packages).toHaveLength(1);
  const payload = { package: contextBinding, expectedRevision: 0, resources: [{ id: "first", enabled: true, content: "Through desktop API" }], mcp: [] };
  expect((await app.inject({ method: "POST", url: "/api/desktop/configuration", payload })).statusCode).toBe(200);
  expect((await app.inject({ method: "POST", url: "/api/desktop/configuration", payload })).statusCode).toBe(409);
  expect(f.store.snapshot().packages[0]!.resources[0]!.content).toBe("Through desktop API");
});

it("desktop-saved guidance reaches actual Worker model input through governed context receipts", async () => {
  const text = "User-configured neutral investigation guidance";
  let observed = false;
  const h = await foundationHost({ foundation: {
    scenarioPackageRegistry: new ScenarioPackageRegistry([contextPackage()]), toolDiscoverySources: [],
    contextResourceContents: [{ package: contextBinding, resourceId: "first", content: contextText }],
  }, model: async args => {
    const request = JSON.parse(args.user);
    if (!request.transcript.some((entry: { kind: string }) => entry.kind === "tool")) return {
      type: "invoke_tool", invocation: { id: "first", tool: "context.read", input: { id: "first", digest: contextContentDigest(text) }, rationale: "Read configured guidance" },
    };
    expect(args.user).toContain(text); expect(args.user).not.toContain(contextText); observed = true;
    return { type: "complete", summary: "Configured guidance consumed", outputs: [] };
  } }); cleanup.push(() => h.close());
  await h.request("/api/desktop/configuration", { package: contextBinding, expectedRevision: 0, resources: [{ id: "first", content: text, enabled: true }], mcp: [] });
  await h.start(); await eventually(async () => (await h.state()).workItems[0]?.status === "completed");
  expect(observed).toBe(true);
});
