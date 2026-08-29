import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ExecutionToolDiscoveryRuntime } from "@traceforge/worker-runtime";
import type { ScenarioSessionPort, ScenarioTrafficPort } from "@traceforge/scenario-sdk";
import { ScenarioPackageRegistry } from "@traceforge/scenario-sdk";
import { WEB_BLACKBOX_PACKAGE } from "@traceforge/scenario-web-blackbox";

const hostContext = {
  sessions: {} as ScenarioSessionPort,
  traffic: {} as ScenarioTrafficPort,
  evidence: { recordNode() { return []; } },
  authorization: {
    requireAction() { throw new Error("not used by package discovery test"); },
    authorizeResource() { throw new Error("not used by package discovery test"); },
  },
};

describe("ScenarioPackageRegistry", () => {
  it("exposes no scenario definitions or scenario tools when no package is installed", async () => {
    const registry = new ScenarioPackageRegistry();
    expect(registry.definitions()).toEqual([]);
    const runtime = new ExecutionToolDiscoveryRuntime(registry.toolSources(hostContext));
    await runtime.refresh();
    expect(runtime.snapshot().providers).toEqual([]);
    await runtime.close();
  });

  it("exposes Web tools only after the Web package is explicitly installed", async () => {
    const registry = new ScenarioPackageRegistry([WEB_BLACKBOX_PACKAGE]);
    expect(registry.definitions().map((definition) => definition.kind)).toEqual(["web_blackbox"]);
    const sources = registry.toolSources(hostContext);
    expect(sources.map((source) => source.source)).toEqual(["scenario:web_blackbox@1"]);
    const tools = await sources[0].discover();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "execution.session.open",
      "scope.authorization.snapshot",
      "web.browser.observe",
      "web.traffic.snapshot",
    ]);
  });

  it("rejects duplicate package and tool-source identities", () => {
    expect(() => new ScenarioPackageRegistry([WEB_BLACKBOX_PACKAGE, WEB_BLACKBOX_PACKAGE])).toThrow("Duplicate Scenario Package");
    const duplicateSourcePackage = {
      ...WEB_BLACKBOX_PACKAGE,
      id: "traceforge.duplicate-source-fixture",
    };
    expect(() => new ScenarioPackageRegistry([WEB_BLACKBOX_PACKAGE, duplicateSourcePackage]))
      .toThrow("Duplicate Scenario Definition web_blackbox@1");
  });

  it("resolves only the exact Package version and Schema revision bound to a Run", () => {
    const registry = new ScenarioPackageRegistry([WEB_BLACKBOX_PACKAGE]);
    const binding = registry.bindingFor(WEB_BLACKBOX_PACKAGE);
    expect(binding).toEqual({ id: "traceforge.web-blackbox", version: "0.1.0", schemaRevision: 1 });
    expect(registry.requireBinding(binding, "web_blackbox", 1)).toBe(WEB_BLACKBOX_PACKAGE);
    expect(registry.bindingStatus({ ...binding, version: "0.0.9" }, "web_blackbox", 1)).toMatchObject({
      status: "recovery_required",
      reason: expect.stringContaining("required by Run is not installed"),
    });
    expect(registry.bindingStatus({ ...binding, schemaRevision: 2 }, "web_blackbox", 1)).toMatchObject({
      status: "recovery_required",
      reason: expect.stringContaining("schema revision mismatch"),
    });
  });

  it("rejects a Package that omits a versioned Schema required by its Definition", () => {
    expect(() => new ScenarioPackageRegistry([{
      ...WEB_BLACKBOX_PACKAGE,
      id: "traceforge.missing-output-schema",
      outputSchemas: WEB_BLACKBOX_PACKAGE.outputSchemas.filter((schema) => schema.kind !== "scope_snapshot"),
    }])).toThrow("lacks Output Schemas: scope_snapshot");
  });

  it("keeps generic Foundation, routes, and Embedded Workers free of concrete Scenario imports", () => {
    const sourceRoot = dirname(fileURLToPath(import.meta.url));
    for (const name of [
      "security-agent-foundation.ts",
      "scenario-routes.ts",
      "scenario-authorization.ts",
      "embedded-workers.ts",
      "execution-node-service.ts",
      "scenario-traffic-store.ts",
      "scenario-evidence-store.ts",
    ]) {
      const content = readFileSync(join(sourceRoot, name), "utf8");
      expect(content, name).not.toMatch(/@traceforge\/scenario-(?!sdk\b)|web_blackbox|WEB_BLACKBOX|ScenarioBrowser|ScenarioHttp/);
    }
  });
});
