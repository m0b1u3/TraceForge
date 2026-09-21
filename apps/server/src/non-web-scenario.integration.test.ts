import { expect, it } from "vitest";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScenarioPackageRegistry } from "@traceforge/scenario-sdk";
import { contextPackage } from "./test-fixtures/context-package.js";
import { fixtureMcpNode } from "./test-fixtures/mcp-node.js";
import { foundationHost, eventually } from "./test-fixtures/foundation-host.js";
import { toolReceiptProvenance } from "./execution-provenance.js";

/** Architectural acceptance fixture, not a shipped code-audit Scenario. Uses
 * the real local Host/Worker/Gateway/file tools; inference is deterministic. */
it.skipIf(process.platform !== "darwin" || process.arch !== "arm64")("runs a non-Web file Scenario through the unchanged Host and retains attributable evidence", async () => {
  const pkg = contextPackage(["workspace.write", "workspace.read"]);
  delete pkg.resourceManifest;
  pkg.definition.authorizationActions = ["workspace.write", "workspace.read"];
  pkg.definition.toolPolicies = ["write", "read"].map(action => ({ source: "traceforge.builtin", capability: `workspace.${action}`,
    authorizationAction: `workspace.${action}`, profile: "run-workspace" as const }));
  pkg.authorizationPolicy = { parseScope: payload => ({ payload, allowedActions: ["workspace.write", "workspace.read"], deniedActions: [] }) };
  const root = await mkdtemp(join(await realpath(tmpdir()), "traceforge-nonweb-"));
  const h = await foundationHost({ root, foundation: { scenarioPackageRegistry: new ScenarioPackageRegistry([pkg]),
    executionNode: fixtureMcpNode().node, toolDiscoverySources: [] }, model: async args => {
    const context = JSON.parse(args.user);
    expect(context.tools.some((tool: { name: string }) => /browser|web\./.test(tool.name))).toBe(false);
    const observations = context.transcript.filter((entry: { kind: string }) => entry.kind === "tool");
    if (!observations.length) return { type: "invoke_tool", invocation: { id: "write", tool: "workspace_write",
      input: { path: "sample.txt", content: "Neutral file observation", expectedDigest: null }, rationale: "Prepare an isolated local sample" } };
    if (observations.length === 1) return { type: "invoke_tool", invocation: { id: "read", tool: "workspace_read", input: { path: "sample.txt" }, rationale: "Read the original file" } };
    return { type: "complete", summary: "Local file observed", outputs: [] };
  } });
  try {
    await h.request("/api/desktop/approval-preference", { expectedRevision: 0, routineApprovalRequired: false });
    await h.start();
    try { await eventually(async () => (await h.state()).workItems[0]?.status === "completed"); }
    catch (error) { throw new Error(JSON.stringify({ state: await h.state(), requests: h.requests }), { cause: error }); }
    const receipt = h.sqlite.prepare("SELECT result_json FROM worker_tool_receipts WHERE idempotency_key='run:effect:read'").get() as { result_json: string };
    expect(receipt.result_json).toContain("Neutral file observation");
    expect(toolReceiptProvenance(h.sqlite, "run:effect:read", { caseId: "case", runId: "run" }).integrity?.digest).toMatch(/^[a-f0-9]{64}$/);
  } finally { await h.close(); }
});
