import { describe, expect, it } from "vitest";
import { assessToolProviderCompatibility, type ToolProviderContractSnapshot } from "./tool-provider-contract.js";

function contract(version = "1.0.0"): ToolProviderContractSnapshot {
  return {
    providerId: "provider.neutral",
    version,
    source: "managed.neutral",
    protocolVersion: 1,
    capabilities: ["investigation.observe"],
    permissions: { network: "deny", filesystem: "read_only", process: "sandboxed", secrets: "none" },
    resources: { cpuTimeMs: 1_000, memoryBytes: 1_000_000, maximumProcesses: 1, maximumWriteBytes: 1_000 },
    platforms: ["linux"],
    executionFingerprint: "first-execution",
    tools: [{
      name: "candidate.observe",
      source: "managed.neutral",
      version,
      priority: 100,
      description: "Observe a neutral candidate",
      inputSchema: {
        type: "object",
        properties: { subject: { type: "string" } },
        required: ["subject"],
        additionalProperties: false,
      },
      providedCapabilities: ["investigation.observe"],
      dependencyCapabilities: [],
      permissionRequirements: {},
      risk: "read_only",
      timeoutMs: 1_000,
    }],
  };
}

describe("Tool Provider contract compatibility", () => {
  it("ignores version-only changes in the normalized contract", () => {
    expect(assessToolProviderCompatibility(contract(), contract("1.1.0"))).toMatchObject({
      classification: "compatible",
      changes: [],
    });
  });

  it("accepts optional input fields and additive tools", () => {
    const next = contract("1.1.0");
    next.tools[0]!.inputSchema = {
      ...next.tools[0]!.inputSchema,
      properties: {
        subject: { type: "string" },
        annotation: { type: "string" },
      },
    };
    next.tools.push({ ...structuredClone(next.tools[0]!), name: "candidate.summarize", version: "1.1.0" });
    const report = assessToolProviderCompatibility(contract(), next);
    expect(report.classification).toBe("compatible");
    expect(report.changes.map((change) => change.code)).toEqual(["input_schema_extended", "tool_added"]);
  });

  it("requires draining when execution or resource limits change", () => {
    const next = contract("2.0.0");
    next.executionFingerprint = "second-execution";
    next.resources.memoryBytes += 1;
    expect(assessToolProviderCompatibility(contract(), next)).toMatchObject({
      classification: "requires_drain",
      changes: expect.arrayContaining([
        expect.objectContaining({ code: "execution_changed" }),
        expect.objectContaining({ code: "resources_changed" }),
      ]),
    });
  });

  it("classifies removed tools, required inputs and permission increases as breaking", () => {
    const previous = contract();
    previous.tools.push({ ...structuredClone(previous.tools[0]!), name: "candidate.second" });
    const next = contract("2.0.0");
    next.permissions.network = "brokered";
    next.tools[0]!.inputSchema = {
      ...next.tools[0]!.inputSchema,
      properties: { subject: { type: "string" }, mode: { type: "string" } },
      required: ["subject", "mode"],
    };
    const report = assessToolProviderCompatibility(previous, next);
    expect(report.classification).toBe("breaking");
    expect(report.changes.map((change) => change.code)).toEqual(expect.arrayContaining([
      "tool_removed", "input_schema_breaking", "provider_permission_increased",
    ]));
  });

  it("conservatively rejects Schema changes it cannot prove compatible", () => {
    const next = contract("2.0.0");
    next.tools[0]!.inputSchema = {
      ...next.tools[0]!.inputSchema,
      anyOf: [{ required: ["subject"] }, { required: ["fallback"] }],
    };
    expect(assessToolProviderCompatibility(contract(), next).changes).toContainEqual(expect.objectContaining({
      code: "input_schema_breaking",
      classification: "breaking",
    }));
  });
});
