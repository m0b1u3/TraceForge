import http from "node:http";
import { describe, expect, it } from "vitest";
import { makeHttpReplayTool, makeProposeScopeExpansionTool, makeReplayTrafficTool } from "./builtin-tools.js";
import type { ScopeRule, TrafficEntry } from "@traceforge/shared";

async function withTarget<T>(run: (baseUrl: string, rules: ScopeRule[]) => Promise<T>): Promise<T> {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8") || "hello";
      res.writeHead(req.method === "POST" ? 201 : 200, { "content-type": "text/plain; charset=utf-8" });
      res.end(body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server address unavailable");
    const host = `127.0.0.1:${address.port}`;
    return await run(`http://${host}`, [{ caseId: "c", allowHosts: [host], denyHosts: [] }]);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

function makeTraffic(entry: TrafficEntry) {
  const added: TrafficEntry[] = [];
  return {
    added,
    listByCase: (caseId: string) => (caseId === "c" ? [entry] : []),
    add: (trafficEntry: TrafficEntry) => { added.push(trafficEntry); },
  };
}

describe("makeHttpReplayTool", () => {
  it("declares authorized-target effects and replays an in-scope request over real HTTP", async () => {
    await withTarget(async (baseUrl, rules) => {
      const tool = makeHttpReplayTool(rules);
      expect(tool.security).toMatchObject({ impactScope: "authorized_target", mutates: true, openWorld: false });
      const res = await tool.execute({ url: `${baseUrl}/x`, method: "GET" });
      expect(res.ok).toBe(true);
      expect(res.content).toContain("200");
      expect(res.content).toContain("hello");
    });
  });

  it("refuses out-of-scope targets before sending a request", async () => {
    const rules: ScopeRule[] = [{ caseId: "c", allowHosts: ["allowed.example"], denyHosts: [] }];
    const tool = makeHttpReplayTool(rules);
    const res = await tool.execute({ url: "http://127.0.0.1:1/x", method: "GET" });
    expect(res.ok).toBe(false);
    expect(res.content).toMatch(/scope/i);
  });
});

describe("makeReplayTrafficTool", () => {
  it("replays an existing entry over real HTTP and records new traffic", async () => {
    await withTarget(async (baseUrl, rules) => {
      const entry: TrafficEntry = {
        id: "traf_1", caseId: "c", url: `${baseUrl}/api/user`, method: "GET",
        requestHeaders: { Authorization: "Bearer x" }, requestBody: null,
        responseStatus: 200, responseBody: "{}", createdAt: "now",
      };
      const traffic = makeTraffic(entry);
      const emitted: unknown[] = [];
      const tool = makeReplayTrafficTool(rules, traffic, undefined, "c", traffic, (event) => emitted.push(event));
      const res = await tool.execute({ trafficId: "traf_1" });
      expect(res.ok).toBe(true);
      expect(res.content).toContain("200");
      expect(res.content).toContain("newTrafficId");
      expect(traffic.added).toHaveLength(1);
      expect(emitted.some((event) => (event as { type: string }).type === "response_captured")).toBe(true);
    });
  });

  it("applies request overrides to the original request", async () => {
    await withTarget(async (baseUrl, rules) => {
      const entry: TrafficEntry = {
        id: "traf_1", caseId: "c", url: `${baseUrl}/api/user`, method: "GET",
        requestHeaders: {}, requestBody: null, responseStatus: 200, responseBody: "{}", createdAt: "now",
      };
      const traffic = makeTraffic(entry);
      const tool = makeReplayTrafficTool(rules, traffic, undefined, "c", traffic, () => {});
      const res = await tool.execute({ trafficId: "traf_1", method: "POST", body: "{\"x\":1}" });
      expect(res.ok).toBe(true);
      expect(res.content).toContain("201");
      expect(res.content).toContain("{\"x\":1}");
    });
  });

  it("errors when traffic id is missing", async () => {
    const entry: TrafficEntry = {
      id: "traf_1", caseId: "c", url: "https://allowed.example/x", method: "GET",
      requestHeaders: {}, requestBody: null, responseStatus: 200, responseBody: "{}", createdAt: "now",
    };
    const traffic = makeTraffic(entry);
    const rules: ScopeRule[] = [{ caseId: "c", allowHosts: ["allowed.example"], denyHosts: [] }];
    const tool = makeReplayTrafficTool(rules, traffic, undefined, "c", traffic, () => {});
    const res = await tool.execute({ trafficId: "nope" });
    expect(res.ok).toBe(false);
    expect(res.content).toContain("not found");
  });
});

describe("makeProposeScopeExpansionTool", () => {
  it("records a proposal without sending any packet", async () => {
    const proposals: Array<[string, string]> = [];
    const tool = makeProposeScopeExpansionTool((host, reason) => { proposals.push([host, reason]); });
    expect(tool.security).toMatchObject({ impactScope: "case", mutates: true, openWorld: false });
    const res = await tool.execute({ host: "cdn.t.com", reason: "same cert" });
    expect(proposals).toEqual([["cdn.t.com", "same cert"]]);
    expect(res.ok).toBe(true);
  });
});
