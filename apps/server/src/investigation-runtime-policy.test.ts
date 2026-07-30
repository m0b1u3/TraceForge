import { describe, expect, it } from "vitest";
import {
  InvestigationStructurePolicy,
  isInvestigationStructureTool,
} from "./investigation-runtime-policy.js";

describe("investigation runtime policy", () => {
  it("classifies control-plane tools separately from active investigation", () => {
    expect(isInvestigationStructureTool("record_fact")).toBe(true);
    expect(isInvestigationStructureTool("record_task")).toBe(true);
    expect(isInvestigationStructureTool("record_action")).toBe(true);
    expect(isInvestigationStructureTool("http_replay")).toBe(false);
  });

  it("converts open exploration into a structured task without ending the Run", () => {
    const policy = new InvestigationStructurePolicy(2);
    expect(policy.authorize("http_replay", 0, 0)).toBeUndefined();
    expect(policy.authorize("navigate", 0, 0)).toBeUndefined();
    expect(policy.authorize("http_replay", 0, 0)).toContain("record a concrete hypothesis");
    expect(policy.authorize("record_hypothesis", 0, 0)).toBeUndefined();
    expect(policy.authorize("record_task", 0, 0)).toBeUndefined();
  });

  it("permits only one running task to own active execution", () => {
    const policy = new InvestigationStructurePolicy();
    expect(policy.authorize("http_replay", 1, 0)).toContain("none owns execution");
    expect(policy.authorize("http_replay", 1, 1)).toBeUndefined();
    expect(policy.authorize("http_replay", 2, 2)).toContain("Multiple investigation tasks");
    expect(policy.authorize("search_facts", 2, 0)).toBeUndefined();
  });
});
