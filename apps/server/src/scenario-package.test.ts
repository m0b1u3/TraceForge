import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ExecutionToolDiscoveryRuntime } from "@traceforge/worker-runtime";
import { createScenarioHostCapabilities, ScenarioPackageRegistry } from "@traceforge/scenario-sdk";
import { webBlackboxControlPlanePackage } from "./test-fixtures/web-blackbox-control-plane-package.js";

const WEB_BLACKBOX_PACKAGE = webBlackboxControlPlanePackage();

const hostContext = {
  artifacts: {} as any,
  state: {} as any,
  capabilities: createScenarioHostCapabilities({}),
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
    const runtime = new ExecutionToolDiscoveryRuntime(registry.toolSources(hostContext, { allowInProcessDevelopment: true }));
    await runtime.refresh();
    expect(runtime.snapshot().providers).toEqual([]);
    await runtime.close();
  });

  it("keeps a control-plane-only fixture free of in-process tools", async () => {
    const registry = new ScenarioPackageRegistry([WEB_BLACKBOX_PACKAGE]);
    expect(registry.definitions().map((definition) => definition.kind)).toEqual(["web_blackbox"]);
    const sources = registry.toolSources(hostContext, { allowInProcessDevelopment: true });
    expect(sources).toEqual([]);
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

  it("binds Artifact and State capabilities to the package version receiving them", () => {
    let received: typeof hostContext | undefined;
    const fixturePackage = {
      ...WEB_BLACKBOX_PACKAGE,
      id: "traceforge.owner-fixture",
      definition: { ...WEB_BLACKBOX_PACKAGE.definition, kind: "owner_fixture" },
      createToolSources(context: typeof hostContext) { received = context; return []; },
    };
    new ScenarioPackageRegistry([fixturePackage]).toolSources(hostContext, { allowInProcessDevelopment: true });
    expect(() => received!.artifacts.get({ packageId: "traceforge.other", packageVersion: "0.1.0", caseId: "case", artifactId: "artifact" }))
      .toThrow("cannot access another package owner");
    expect(() => received!.state.read({ packageId: fixturePackage.id, packageVersion: "0.2.0", caseId: "case", runId: "run", key: "state" }))
      .toThrow("cannot access another package owner");
  });

  it("resolves only the exact Package version and Schema revision bound to a Run", () => {
    const registry = new ScenarioPackageRegistry([WEB_BLACKBOX_PACKAGE]);
    const binding = registry.bindingFor(WEB_BLACKBOX_PACKAGE);
    expect(binding).toEqual({ id: "traceforge.web-blackbox", version: "0.3.0", schemaRevision: 1 });
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
