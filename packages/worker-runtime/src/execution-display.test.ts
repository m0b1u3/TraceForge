import { expect, it } from "vitest";
import { executionDisplay } from "./execution-display.js";
it("redacts credential-bearing fields and command arguments before display", () => {
  const result = executionDisplay({ arguments: ["--token", "private-value"], headers: { Authorization: "secret" }, environment: { SECRET: "secret" }, path: "task.sh" });
  expect(result.text).not.toContain("private-value"); expect(result.text).not.toContain('"secret"'); expect(result.text).toContain("task.sh");
});
it("bounds output and strips terminal control sequences", () => {
  expect(executionDisplay("\u001b[31m" + "a".repeat(200), 20)).toEqual({ text: "a".repeat(20), truncated: true });
});
