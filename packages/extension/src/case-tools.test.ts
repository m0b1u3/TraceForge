import { describe, it, expect } from "vitest";
import { makeListTrafficTool, makeGetTrafficTool, makeExtractApiEndpointsTool } from "./case-tools.js";
import type { TrafficEntry, Fact, TimelineEntry, RuntimeEvent } from "@traceforge/shared";

const entries: TrafficEntry[] = [
  { id: "traf_1", caseId: "c", url: "https://t.com/a", method: "GET", requestHeaders: {}, requestBody: null, responseStatus: 200, responseBody: "hi", createdAt: "now" },
  { id: "traf_2", caseId: "c", url: "https://t.com/b", method: "POST", requestHeaders: {}, requestBody: null, responseStatus: 404, responseBody: null, createdAt: "now" },
];
const reader = { listByCase: (cid: string) => (cid === "c" ? entries : []) };

describe("makeListTrafficTool", () => {
  it("lists traffic summaries for the case", async () => {
    const tool = makeListTrafficTool("c", reader);
    expect(tool.risk).toBe("normal");
    expect(tool.executionMode).toBe("parallel");
    const res = await tool.execute({});
    expect(res.ok).toBe(true);
    expect(res.content).toContain("traf_1");
    expect(res.content).toContain("GET");
    expect(res.content).toContain("https://t.com/b");
  });
});

describe("makeGetTrafficTool", () => {
  it("returns a single entry detail by id", async () => {
    const tool = makeGetTrafficTool("c", reader);
    expect(tool.executionMode).toBe("parallel");
    const res = await tool.execute({ id: "traf_1" });
    expect(res.ok).toBe(true);
    expect(res.content).toContain("hi");
  });
  it("returns ok:false for a missing id", async () => {
    const tool = makeGetTrafficTool("c", reader);
    const res = await tool.execute({ id: "nope" });
    expect(res.ok).toBe(false);
  });
});

describe("makeExtractApiEndpointsTool", () => {
  const makeDeps = (responseBody?: string, url = "https://t.com/") => {
    const facts: Fact[] = [];
    const timeline: TimelineEntry[] = [];
    const events: RuntimeEvent[] = [];
    const traffic: TrafficEntry[] = [
      {
        id: "traf_home", caseId: "c", url,
        method: "GET", requestHeaders: {}, requestBody: null,
        responseStatus: 200, responseBody: responseBody ?? JSON.stringify({ endpoint: "/api/users" }),
        createdAt: "now",
      },
    ];
    return {
      traffic: { listByCase: (cid: string) => (cid === "c" ? traffic : []) },
      facts: {
        listByCase: (cid: string) => (cid === "c" ? facts : []),
        getById: (id: string) => facts.find((f) => f.id === id),
        update: (id: string, patch: Partial<Fact>) => {
          const index = facts.findIndex((fact) => fact.id === id);
          if (index === -1) return undefined;
          facts[index] = { ...facts[index], ...patch };
          return facts[index];
        },
        create: (_caseId: string, input: Omit<Fact, "id" | "caseId" | "createdAt" | "updateCount" | "updatedAt" | "validity"> & Partial<Pick<Fact, "validity">>) => {
          const f = { id: `fact_${facts.length + 1}`, caseId: "c", createdAt: "now", updateCount: 0, updatedAt: "", validity: "valid" as const, ...input } as Fact;
          facts.push(f);
          return f;
        },
      },
      timeline: {
        append: (_caseId: string, eventType: string, detail: string, refId?: string | null) => {
          const t = { id: `tl_${timeline.length + 1}`, caseId: "c", eventType, detail, refId: refId ?? null, createdAt: "now" };
          timeline.push(t);
          return t;
        },
      },
      events,
      emit: (event: RuntimeEvent) => { events.push(event); },
    };
  };

  it("discovers api endpoints from response body and records facts", async () => {
    const deps = makeDeps('{"links":["/api/orders","/api/profile"],"login":"/auth/login"}');
    const tool = makeExtractApiEndpointsTool("c", [{ caseId: "c", allowHosts: ["t.com"], denyHosts: [] }], deps);
    const res = await tool.execute({});
    expect(res.ok).toBe(true);
    expect(res.content).toContain("/api/orders");
    expect(res.content).toContain("/api/profile");
    expect(res.content).toContain("/auth/login");
    expect(deps.facts.listByCase("c").some((f) => f.type === "api_endpoint")).toBe(true);
    expect(deps.facts.listByCase("c").some((f) => f.type === "login_endpoint")).toBe(true);
    expect(deps.events.some((event) => event.type === "fact_created")).toBe(true);
  });

  it("returns empty message when no usable traffic", async () => {
    const deps = makeDeps();
    deps.traffic.listByCase = () => [];
    const tool = makeExtractApiEndpointsTool("c", [{ caseId: "c", allowHosts: ["t.com"], denyHosts: [] }], deps);
    const res = await tool.execute({});
    expect(res.ok).toBe(true);
    expect(res.content).toContain("未发现");
  });

  it("skips out-of-scope absolute urls", async () => {
    const deps = makeDeps('{"url":"https://evil.com/api/secret"}');
    const tool = makeExtractApiEndpointsTool("c", [{ caseId: "c", allowHosts: ["t.com"], denyHosts: [] }], deps);
    const res = await tool.execute({});
    expect(res.ok).toBe(true);
    expect(res.content).not.toContain("evil.com");
  });

});
