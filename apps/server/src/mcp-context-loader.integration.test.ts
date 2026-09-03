import { afterEach, describe, expect, it } from "vitest";
import { ScenarioPackageRegistry } from "@traceforge/scenario-sdk";
import { createMcpContextLoader, mcpContextProfileDigest, type FoundationMcpContextServer } from "./mcp-context-loader.js";
import { contextContentDigest, SqlitePackageContextStore } from "./package-context-resources.js";
import { contextBinding, contextPackage } from "./test-fixtures/context-package.js";
import { fixtureMcpNode } from "./test-fixtures/mcp-node.js";
import { foundationHost, eventually } from "./test-fixtures/foundation-host.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
function server(): FoundationMcpContextServer {
  return { source: "fixture.context", serverName: "neutral", serverVersion: "1", reviewVersion: 1,
    process: { executable: "fixture-only", workingDirectory: "/fixture", attribution: { runId: "service", caseId: "service", workId: "service", workerId: "service",
      leaseId: "service", leaseExpiresAt: "2099-01-01", scopeRef: "service", actionId: "discovery", idempotencyKey: "discovery" },
      permissions: { version: 1, platform: "linux", filesystem: { read: [], write: [], deny: [] }, network: "deny",
        process: { access: "sandboxed", background: false, interactive: false }, secrets: "deny", sources: ["test-only"] },
      resources: { cpuTimeMs: 10000, memoryBytes: 128 * 1024 * 1024, maximumProcesses: 1, writeBytes: 0 }, requestTimeoutMs: 150, maximumFrameBytes: 8192 } };
}
function settings(f: ReturnType<typeof fixtureMcpNode>, kind: "resource" | "prompt" = "resource") {
  const config = server(); const pkg = contextPackage(["context.catalog", "context.read"]);
  const content = kind === "resource" ? "neutral reference" : JSON.stringify([{ role: "user", content: { type: "text", text: "neutral prompt" } }]);
  const resource = pkg.resourceManifest!.resources[0]!; resource.digest = contextContentDigest(content);
  resource.context!.type = "knowledge";
  resource.context!.external = { source: config.source, profileDigest: mcpContextProfileDigest(config), kind,
    target: kind === "resource" ? "fixture:notes" : "notes", ...(kind === "prompt" ? { arguments: { topic: "first" } } : {}) };
  return { pkg, config, content, resource, foundation: { scenarioPackageRegistry: new ScenarioPackageRegistry([pkg]),
    executionNode: f.node, mcpContextServers: [config], toolDiscoverySources: [] } };
}

describe("Pinned external context through the foundation Worker", () => {
  it("requires a controlled node and fingerprints the reviewed deployment", () => {
    const a = server(), b = server(); b.reviewVersion++;
    expect(mcpContextProfileDigest(a)).not.toBe(mcpContextProfileDigest(b));
    expect(() => createMcpContextLoader(a, undefined)).toThrow("Execution Node");
  });
  it.each(["resource", "prompt"] as const)("reads and revokes %s via HTTP without promoting server instructions", async (kind) => {
    const f = fixtureMcpNode(); const s = settings(f, kind); let turns = 0;
    let h!: Awaited<ReturnType<typeof foundationHost>>;
    h = await foundationHost({ foundation: s.foundation, model: async (args) => {
      turns++;
      if (turns === 1) {
        expect(f.starts).toHaveLength(0);
        return { type: "invoke_tool", invocation: { id: "read", tool: "context.read", input: { id: "first", digest: s.resource.digest }, rationale: "Read pinned context" } };
      }
      if (turns === 2) {
        expect(args.user).toContain(kind === "resource" ? "neutral reference" : "neutral prompt");
        new SqlitePackageContextStore(h.sqlite).revoke(s.resource.digest, "withdrawn");
        return { type: "invoke_tool", invocation: { id: "refresh", tool: "context.catalog", input: {}, rationale: "Refresh" } };
      }
      expect(args.user).not.toContain(kind === "resource" ? "neutral reference" : "neutral prompt");
      return { type: "complete", summary: "Replanned", outputs: [] };
    } }); cleanup.push(() => h.close());
    await h.start(); await eventually(async () => (await h.state()).workItems[0]?.status === "failed");
    const stopped = await h.state();
    await h.request("/api/scenarios/runs/run/work/work/continue", { commandId: "resume-after-context-change", actor: "test", reason: "Re-evaluate current context",
      expectedRevision: stopped.revision, checkpointRef: stopped.workItems[0].latestCheckpoint.payloadRef });
    await eventually(async () => (await h.state()).workItems[0]?.status === "completed");
    expect(turns).toBe(3); expect(f.calls()).toBe(1); expect(f.starts).toHaveLength(1); expect(f.terminated()).toBe(1);
    expect(f.starts[0]!.attribution.runId).toBe("run");
    const occupied=await h.request("/api/security-tools/process-occupancies?caseId=case&runId=run");
    expect(occupied.items).toHaveLength(1);
    expect(occupied.items[0]).toMatchObject({state:"terminal_observed",identity:{kind:"work",source:"fixture.context",operation:`context.${kind}`}});
    expect(JSON.stringify(h.requests)).not.toContain("UNTRUSTED_");
    const messages = f.messages.filter((m) => m.method === (kind === "resource" ? "resources/read" : "prompts/get"));
    expect(messages[0]!.params).toEqual(kind === "resource" ? { uri: "fixture:notes" } : { name: "notes", arguments: { topic: "first" } });
    expect(h.sqlite.prepare("SELECT count(*) AS n FROM worker_tool_receipts").get()).toEqual({ n: 1 });
    expect(JSON.stringify(h.sqlite.prepare("SELECT result_json FROM worker_tool_receipts").all())).toContain(kind === "resource" ? "neutral reference" : "neutral prompt");
  });
  it.each(["denied", "profile", "expired"])("rejects %s context before starting a process", async (mode) => {
    const f = fixtureMcpNode(); const s = settings(f);
    if (mode === "denied") (s.pkg.authorizationPolicy as { authorizeResource?: (scope: unknown, kind: string, value: string) => string })
      .authorizeResource = (_scope, kind, value) => kind === "mcp.resource" ? "denied" : value;
    if (mode === "profile") s.config.reviewVersion++;
    if (mode === "expired") s.resource.context!.expiresAt = "2020-01-01T00:00:00Z";
    const h = await foundationHost({ foundation: s.foundation, model: async (args) => JSON.parse(args.user).transcript.some((t: any) => t.kind === "tool")
      ? { type: "complete", summary: "Rejected", outputs: [] } : { type: "invoke_tool", invocation: { id: "read", tool: "context.read", input: { id: "first", digest: s.resource.digest }, rationale: "Read" } } });
    cleanup.push(() => h.close()); await h.start(); await eventually(async () => (await h.state()).workItems[0]?.status === "completed");
    expect(f.starts).toHaveLength(0); expect(h.requests.at(-1)!.transcript.some((t: any) => t.summary.includes("rejected"))).toBe(true);
  });
  it("cuts off a revoked external context profile before starting its process", async () => {
    const f = fixtureMcpNode(); const s = settings(f); let h!: Awaited<ReturnType<typeof foundationHost>>;
    h = await foundationHost({ foundation: { ...s.foundation, extensionAssembly: { revokeAuthorizer: { async authorize() {
      return { decision: "allowed" as const, authorizationRef: "independent-extension-review", expiresAt: "2099-01-01T00:00:00.000Z" };
    } } } }, model: async (args) => {
      if (JSON.parse(args.user).transcript.some((entry: { kind: string }) => entry.kind === "tool")) {
        return { type: "complete", summary: "Profile withdrawal observed", outputs: [] };
      }
      await h.request("/api/foundation/extension-assembly/profiles/revoke", { commandId: "withdraw_context_profile", kind: "mcp_context",
        source: s.config.source, profileDigest: mcpContextProfileDigest(s.config), actor: "operator", reason: "review withdrawn" });
      return { type: "invoke_tool", invocation: { id: "read", tool: "context.read",
        input: { id: "first", digest: s.resource.digest }, rationale: "Read" } };
    } }); cleanup.push(() => h.close());
    await h.start(); await eventually(async () => (await h.state()).workItems[0]?.status === "completed");
    expect(f.starts).toHaveLength(0); expect(f.calls()).toBe(0);
  });
  it.each(["resourceText", "wrongUri", "binary", "missing", "hangCall", "invalidAttestation"] as const)("does not retain invalid or uncertain %s content", async (mode) => {
    const f = fixtureMcpNode({ [mode]: mode === "resourceText" ? "CHANGED_PRIVATE_TEXT" : true }); const s = settings(f);
    const h = await foundationHost({ foundation: s.foundation, model: async () => ({ type: "invoke_tool",
      invocation: { id: "read", tool: "context.read", input: { id: "first", digest: s.resource.digest }, rationale: "Read" } }) });
    cleanup.push(() => h.close()); await h.start(); await eventually(async () => (await h.state()).workItems[0]?.status === "blocked");
    expect(h.sqlite.prepare("SELECT status FROM tool_invocation_executions").get()).toEqual({ status: "uncertain" });
    expect(h.sqlite.prepare("SELECT count(*) AS n FROM package_context_content").get()).toEqual({ n: 0 });
    expect(JSON.stringify(h.requests)).not.toContain("CHANGED_PRIVATE_TEXT"); expect(f.terminated()).toBe(1);
  });
  it("restores a confirmed external receipt without contacting a new MCP process", async () => {
    const f = fixtureMcpNode(); const s = settings(f);
    const first = await foundationHost({ foundation: s.foundation, failResultCheckpoint: true, model: async () => ({ type: "invoke_tool",
      invocation: { id: "read", tool: "context.read", input: { id: "first", digest: s.resource.digest }, rationale: "Read" } }) });
    cleanup.push(() => first.sqlite.open ? first.close() : Promise.resolve());
    await first.start(); await eventually(async () => (await first.state()).workItems[0]?.status === "failed");
    const before = await first.state(); await first.close(false);
    const next = await foundationHost({ root: first.root, foundation: s.foundation, model: async (args) => {
      expect(args.user).toContain("neutral reference"); return { type: "complete", summary: "Restored pinned receipt", outputs: [] };
    } }); cleanup.push(() => next.close());
    await next.request("/api/scenarios/runs/run/work/work/continue", { commandId: "resume-context", actor: "test", reason: "Resume confirmed read",
      expectedRevision: before.revision, checkpointRef: before.workItems[0].latestCheckpoint.payloadRef });
    await eventually(async () => (await next.state()).workItems[0]?.status === "completed");
    expect(f.calls()).toBe(1); expect(f.starts).toHaveLength(1);
  });
  it("rechecks authorization after the remote response before caching or delivering content", async () => {
    const f = fixtureMcpNode(); const s = settings(f);
    let h!: Awaited<ReturnType<typeof foundationHost>>;
    const write = f.node.writeProcessInput.bind(f.node);
    s.foundation.executionNode = { ...f.node, async writeProcessInput(request) {
      const message = JSON.parse(Buffer.from(request.dataBase64, "base64").toString());
      if (message.method === "resources/read") new SqlitePackageContextStore(h.sqlite).revoke(s.resource.digest, "withdrawn during read");
      return write(request);
    } };
    h = await foundationHost({ foundation: s.foundation, model: async () => ({ type: "invoke_tool", invocation: { id: "read",
      tool: "context.read", input: { id: "first", digest: s.resource.digest }, rationale: "Read" } }) }); cleanup.push(() => h.close());
    await h.start(); await eventually(async () => (await h.state()).workItems[0]?.status === "blocked");
    expect(f.calls()).toBe(1); expect(f.terminated()).toBe(1);
    expect(h.sqlite.prepare("SELECT count(*) AS n FROM package_context_content").get()).toEqual({ n: 0 });
    expect(JSON.stringify(h.requests)).not.toContain("neutral reference");
  });
  it("opens separate attributed processes across Runs", async () => {
    const f = fixtureMcpNode(); const s = settings(f);
    const h = await foundationHost({ foundation: s.foundation, model: async (args) => JSON.parse(args.user).transcript.some((t: any) => t.kind === "tool")
      ? { type: "complete", summary: "Read", outputs: [] } : { type: "invoke_tool", invocation: { id: "read", tool: "context.read", input: { id: "first", digest: s.resource.digest }, rationale: "Read" } } });
    cleanup.push(() => h.close());
    for (const id of ["first", "second"]) { await h.start(id); await eventually(async () => (await h.state(id)).workItems[0]?.status === "completed"); }
    expect(f.starts.map((s) => s.attribution.runId)).toEqual(["first", "second"]); expect(f.calls()).toBe(2); expect(f.terminated()).toBe(2);
  });
});
