import { describe, expect, it } from "vitest";
import { makeAssessValidationExperimentTool } from "@traceforge/extension";
import { createDb } from "./db/client.js";
import { TrafficStore } from "./stores/traffic-store.js";

describe("validation assessment with real SQLite traffic", () => {
  it("reads persisted evidence, returns a structured verdict, and preserves case isolation", async () => {
    const traffic = new TrafficStore(createDb(":memory:"));
    const now = new Date().toISOString();
    traffic.add({
      id: "baseline", caseId: "case_1", url: "https://target.test/api/orders/42", method: "GET",
      requestHeaders: {}, requestBody: null, responseStatus: 200, responseBody: "{\"order\":{\"id\":42,\"secret\":\"x\"}}",
      responseSize: 32, createdAt: now,
    });
    traffic.add({
      id: "variant", caseId: "case_1", url: "https://target.test/api/orders/42", method: "GET",
      requestHeaders: {}, requestBody: null, responseStatus: 200, responseBody: "{\"order\":{\"id\":42,\"secret\":\"x\"}}",
      responseSize: 32, createdAt: now,
    });
    traffic.add({
      id: "foreign", caseId: "case_2", url: "https://other.test/private", method: "GET",
      requestHeaders: {}, requestBody: null, responseStatus: 200, responseBody: "{\"secret\":\"other\"}",
      responseSize: 18, createdAt: now,
    });

    const tool = makeAssessValidationExperimentTool("case_1", traffic);
    const result = await tool.execute({
      baselineTrafficId: "baseline",
      variantTrafficId: "variant",
      protectedFields: ["order.id", "order.secret"],
    });
    expect(result.ok).toBe(true);
    expect(JSON.parse(result.content)).toMatchObject({ verdict: "supports" });

    const isolated = await tool.execute({
      baselineTrafficId: "baseline",
      variantTrafficId: "foreign",
    });
    expect(isolated.ok).toBe(false);
  });
});
