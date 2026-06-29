import { describe, it, expect, beforeEach } from "vitest";
import { createDb } from "../db/client.js";
import { ContextSummaryStore } from "./context-summary-store.js";

let store: ContextSummaryStore;
beforeEach(() => { store = new ContextSummaryStore(createDb(":memory:")); });

describe("ContextSummaryStore", () => {
  it("latest returns undefined initially", () => { expect(store.latest("c1")).toBeUndefined(); });
  it("append then latest returns most recent by seq", () => {
    store.append("c1", 3, "early");
    store.append("c1", 8, "later");
    expect(store.latest("c1")?.content).toBe("later");
    expect(store.latest("c1")?.coversUpToEventSeq).toBe(8);
  });
  it("isolates by case", () => {
    store.append("c1", 3, "x");
    expect(store.latest("c2")).toBeUndefined();
  });
});
