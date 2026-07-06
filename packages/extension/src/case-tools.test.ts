import { describe, it, expect } from "vitest";
import { makeListTrafficTool, makeGetTrafficTool } from "./case-tools.js";
import type { TrafficEntry } from "@traceforge/shared";

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
