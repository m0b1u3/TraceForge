import { describe, it, expect } from "vitest";
import { createDb, getSqliteClient } from "../db/client.js";
import { CaseStore } from "./case-store.js";

describe("CaseStore", () => {
  it("creates and retrieves a conversation case with scope rules", () => {
    const db = createDb(":memory:");
    try {
      const store = new CaseStore(db);
      const entry = store.create("investigation", [{ caseId: "pending", allowHosts: ["target.test"], denyHosts: [] }]);
      expect(entry.id).toMatch(/^case_/);
      expect(entry.status).toBe("active");
      expect(store.get(entry.id)?.scopeRules[0].allowHosts).toEqual(["target.test"]);
    } finally {
      getSqliteClient(db).close();
    }
  });
});
