import { describe, it, expect, beforeEach } from "vitest";
import { createDb, type Db } from "../db/client.js";
import { CaseStore } from "./case-store.js";
import { TrafficStore } from "./traffic-store.js";

let db: Db;
beforeEach(() => {
  db = createDb(":memory:");
});

describe("CaseStore", () => {
  it("creates and retrieves a case with scope rules", () => {
    const store = new CaseStore(db);
    const c = store.create("demo", [{ caseId: "tmp", allowHosts: ["target.com"], denyHosts: [] }]);
    expect(c.id).toMatch(/^case_/);
    expect(c.status).toBe("active");
    const got = store.get(c.id);
    expect(got?.scopeRules[0].allowHosts).toEqual(["target.com"]);
  });
});

describe("TrafficStore", () => {
  it("adds and lists entries scoped by case", () => {
    const cases = new CaseStore(db);
    const c = cases.create("demo", []);
    const traffic = new TrafficStore(db);
    traffic.add({
      id: "traf_1", caseId: c.id, url: "https://target.com/a", method: "GET",
      requestHeaders: {}, requestBody: null, responseStatus: 200, responseBody: "ok", createdAt: "now",
    });
    traffic.add({
      id: "traf_2", caseId: "other", url: "https://x/b", method: "GET",
      requestHeaders: {}, requestBody: null, responseStatus: 200, responseBody: null, createdAt: "now",
    });
    const list = traffic.listByCase(c.id);
    expect(list).toHaveLength(1);
    expect(list[0].url).toBe("https://target.com/a");
  });
});
