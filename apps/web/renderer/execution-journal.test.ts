import { expect, it } from "vitest";
import { readExecutionJournal } from "./execution-journal";
it("restores the same command only within its owning conversation", () => {
  const operation = { path: "/api/desktop/conversations/first/execution", body: { commandId: "command-1", messageCommandId: "message", scopeRef: "scope", scenarioKind: "review", definitionVersion: 1 } };
  expect(readExecutionJournal({ getItem: () => JSON.stringify(operation) }, "first")).toEqual(operation);
  expect(() => readExecutionJournal({ getItem: () => JSON.stringify(operation) }, "second")).toThrow();
  expect(readExecutionJournal({ getItem: () => null }, "first")).toBeNull();
});
it("does not silently discard a corrupt or oversized pending operation", () => {
  for (const raw of ["{", "{}", "x".repeat(40001), '{"path":"/api/admin","body":{"commandId":"first"}}'])
    expect(() => readExecutionJournal({ getItem: () => raw }, "first")).toThrow();
});
