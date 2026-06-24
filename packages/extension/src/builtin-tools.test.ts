import { describe, it, expect, vi } from "vitest";
import { makeHttpReplayTool, makeProposeScopeExpansionTool } from "./builtin-tools.js";
import type { ScopeRule } from "@traceforge/shared";
import type { Fetcher } from "@traceforge/tools";

const rules: ScopeRule[] = [{ caseId: "c", allowHosts: ["t.com"], denyHosts: [] }];
const okFetcher: Fetcher = async () => ({ status: 200, bodyLength: 5, body: "hello", headers: {} });

describe("makeHttpReplayTool", () => {
  it("is normal-risk and replays in-scope requests", async () => {
    const tool = makeHttpReplayTool(rules, okFetcher);
    expect(tool.risk).toBe("normal");
    const res = await tool.execute({ url: "https://t.com/x", method: "GET" });
    expect(res.ok).toBe(true);
    expect(res.content).toContain("200");
  });

  it("refuses out-of-scope targets (scope guard inside execute)", async () => {
    const tool = makeHttpReplayTool(rules, okFetcher);
    const res = await tool.execute({ url: "https://evil.com/x", method: "GET" });
    expect(res.ok).toBe(false);
    expect(res.content).toMatch(/scope/i);
  });
});

describe("makeProposeScopeExpansionTool", () => {
  it("records a proposal without sending any packet", async () => {
    const onPropose = vi.fn();
    const tool = makeProposeScopeExpansionTool(onPropose);
    expect(tool.risk).toBe("normal");
    const res = await tool.execute({ host: "cdn.t.com", reason: "same cert" });
    expect(onPropose).toHaveBeenCalledWith("cdn.t.com", "same cert");
    expect(res.ok).toBe(true);
  });
});
