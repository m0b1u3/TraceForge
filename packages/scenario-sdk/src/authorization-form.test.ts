import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { parseScenarioPackageDescriptor } from "./package-descriptor.js";
import { buildAuthorizationScope } from "@traceforge/shared/authorization-form";
import { authorizeScenarioResource, parseScenarioScope } from "./index.js";
const descriptor = () => JSON.parse(readFileSync(new URL("../../../scenarios/web-blackbox/scenario.json", import.meta.url), "utf8"));
it("round-trips a Scenario-owned form through the installed policy without widening resources", () => {
  const pkg = parseScenarioPackageDescriptor(descriptor()), policy = pkg.authorizationPolicy;
  if (!("form" in policy) || !policy.form) throw new Error("Missing form");
  const scope = buildAuthorizationScope(policy.form, ["https://first.example/exact", "https://second.example/", ""]);
  const parsed = parseScenarioScope(policy, scope);
  expect(authorizeScenarioResource(policy, parsed.payload, "network.url", "https://first.example/exact")).toBe("https://first.example/exact");
  expect(() => authorizeScenarioResource(policy, parsed.payload, "network.url", "https://first.example/other")).toThrow();
  expect(() => authorizeScenarioResource(policy, parsed.payload, "network.url", "https://second.example.evil/")).toThrow();
});
it("rejects omitted, unrelated or overlapping policy paths before installation", () => {
  for (const mutate of [
    (d: any) => d.authorizationPolicy.form.fields.pop(),
    (d: any) => { d.authorizationPolicy.form.fields[0].path = ["unrelated"]; },
    (d: any) => d.authorizationPolicy.form.fields.push(d.authorizationPolicy.form.fields[0]),
  ]) { const d = descriptor(); mutate(d); expect(() => parseScenarioPackageDescriptor(d)).toThrow(); }
});
