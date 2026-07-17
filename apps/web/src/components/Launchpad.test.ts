import { describe, expect, it } from "vitest";
import type { CaseSummary } from "@traceforge/shared";
import { filterCaseSummaries, normalizeTarget, sortCaseSummaries } from "./Launchpad.js";

function summary(id: string, runStatus: CaseSummary["runStatus"], lastActivityAt: string): CaseSummary {
  return { id, name: id, status: "active", target: null, runStatus, trafficCount: 0, findingCount: 0, severityCounts: { critical: 0, high: 0, medium: 0, low: 0, info: 0 }, pendingApproval: runStatus === "waiting", lastActivityAt, createdAt: lastActivityAt };
}

describe("Launchpad", () => {
  it("normalizes domains, IPs, and URLs without accepting prose", () => {
    expect(normalizeTarget("example.com")).toBe("example.com");
    expect(normalizeTarget("https://api.example.com:8443/path")).toBe("api.example.com:8443");
    expect(normalizeTarget("192.168.1.10")).toBe("192.168.1.10");
    expect(normalizeTarget("test this target")).toBeNull();
  });

  it("orders attention states before recency", () => {
    const paused = { ...summary("paused", "idle", "2026-07-13T12:00:00Z"), status: "paused" as const };
    const items = [summary("idle", "idle", "2026-07-16T12:00:00Z"), paused, summary("running", "running", "2026-07-15T12:00:00Z"), summary("waiting", "waiting", "2026-07-14T12:00:00Z")];
    expect(sortCaseSummaries(items).map((item) => item.id)).toEqual(["waiting", "running", "paused", "idle"]);
  });

  it("searches case names and targets case-insensitively while excluding archives", () => {
    const items = [
      { ...summary("Alpha", "idle", "2026-07-16T12:00:00Z"), target: "api.example.com" },
      { ...summary("Beta", "idle", "2026-07-15T12:00:00Z"), target: "internal.test" },
      { ...summary("Archived", "idle", "2026-07-17T12:00:00Z"), target: "api.example.com", status: "archived" as const },
    ];
    expect(filterCaseSummaries(items, "  EXAMPLE ").map((item) => item.id)).toEqual(["Alpha"]);
    expect(filterCaseSummaries(items, "beta").map((item) => item.id)).toEqual(["Beta"]);
    expect(filterCaseSummaries(items, "").map((item) => item.id)).toEqual(["Alpha", "Beta"]);
  });
});
