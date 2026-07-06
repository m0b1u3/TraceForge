import { describe, it, expect, vi } from "vitest";
import { makeHttpReplayTool, makeProposeScopeExpansionTool, makeReplayTrafficTool } from "./builtin-tools.js";
import type { ScopeRule, TrafficEntry } from "@traceforge/shared";
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

describe("makeReplayTrafficTool", () => {
  const entry: TrafficEntry = {
    id: "traf_1", caseId: "c", url: "https://t.com/api/user", method: "GET",
    requestHeaders: { Authorization: "Bearer x" }, requestBody: null,
    responseStatus: 200, responseBody: "{}", createdAt: "now",
  };
  const traffic = {
    listByCase: (caseId: string) => (caseId === "c" ? [entry] : []),
    add: vi.fn(),
  };

  it("replays an existing traffic entry and records new traffic", async () => {
    const emitted: unknown[] = [];
    const tool = makeReplayTrafficTool(rules, traffic, okFetcher, "c", traffic, (e) => emitted.push(e));
    expect(tool.risk).toBe("normal");
    const res = await tool.execute({ trafficId: "traf_1" });
    expect(res.ok).toBe(true);
    expect(res.content).toContain("200");
    expect(res.content).toContain("newTrafficId");
    expect(traffic.add).toHaveBeenCalled();
    expect(emitted.some((e) => (e as { type: string }).type === "response_captured")).toBe(true);
  });

  it("applies overrides to the original request", async () => {
    const fetcher: Fetcher = async (req) => ({
      status: 201,
      bodyLength: String(req.body).length,
      body: String(req.body),
      headers: {},
    });
    const tool = makeReplayTrafficTool(rules, traffic, fetcher, "c", traffic, () => {});
    const res = await tool.execute({ trafficId: "traf_1", method: "POST", body: "{\"x\":1}" });
    expect(res.ok).toBe(true);
    expect(res.content).toContain("201");
  });

  it("errors when traffic id is missing", async () => {
    const tool = makeReplayTrafficTool(rules, traffic, okFetcher, "c", traffic, () => {});
    const res = await tool.execute({ trafficId: "nope" });
    expect(res.ok).toBe(false);
    expect(res.content).toContain("not found");
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
