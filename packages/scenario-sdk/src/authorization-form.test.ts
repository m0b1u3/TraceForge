import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { parseScenarioPackageDescriptor } from "./package-descriptor.js";
import { buildAuthorizationScope } from "@traceforge/shared/authorization-form";
import { authorizeScenarioResource, parseScenarioScope } from "./index.js";
const descriptor = () => JSON.parse(readFileSync(new URL("../../../scenarios/web-blackbox/scenario.json", import.meta.url), "utf8"));
it("round-trips default networking without a second target or network form", () => {
  const pkg = parseScenarioPackageDescriptor(descriptor()), policy = pkg.authorizationPolicy;
  if (!("form" in policy) || !policy.form) throw new Error("Missing form");
const scope = buildAuthorizationScope(policy.form, policy.form.fields.map(field => field.type === "integer" ? String(field.defaultValue ?? "") : field.path[0] === "targets" ? "https://first.example/exact" : field.path[0] === "urlPrefixes" ? "https://second.example/" : ""));
  const parsed = parseScenarioScope(policy, { ...scope, authorizedActions: ["web.request.replay"] });
  expect(authorizeScenarioResource(policy, parsed.payload, "network.url", "https://first.example/exact")).toBe("https://first.example/exact");
  for (const kind of ["network.url", "workspace.network"]) {
    expect(authorizeScenarioResource(policy, parsed.payload, kind, "https://another.example/other")).toBe("https://another.example/other");
    expect(authorizeScenarioResource(policy, parsed.payload, kind, "http://192.0.2.1/path")).toBe("http://192.0.2.1/path");
    expect(() => authorizeScenarioResource(policy, parsed.payload, kind, "file:///private/data")).toThrow();
  }
  expect(policy.form.fields.some(f => ["targets","urlPrefixes","workspaceNetworkPrefixes","researchUrlPrefixes"].includes(f.path[0]))).toBe(false);
  expect(authorizeScenarioResource(policy, parsed.payload, "research.url", "https://docs.example/")).toBe("https://docs.example/");
});
it("rejects omitted, unrelated or overlapping policy paths before installation", () => {
  for (const mutate of [
    (d: any) => { const fields=d.authorizationPolicy.form.fields; fields.splice(fields.findIndex((field:any)=>field.type==="string-list"),1); },
    (d: any) => { d.authorizationPolicy.form.fields.find((field:any)=>field.type==="string-list").path = ["unrelated"]; },
    (d: any) => d.authorizationPolicy.form.fields.push(d.authorizationPolicy.form.fields[0]),
  ]) { const d = descriptor(); mutate(d); expect(() => parseScenarioPackageDescriptor(d)).toThrow(); }
});
it("requires declared, unambiguous policies and visible boolean consent", () => {
  for (const mutate of [
    (d: any) => { d.definition.toolPolicies[0].profile = "unrestricted"; },
    (d: any) => { d.definition.toolPolicies[0].authorizationAction = "undeclared"; },
    (d: any) => d.definition.toolPolicies.push(d.definition.toolPolicies[0]),
    (d: any) => { d.definition.toolPolicies[0].autonomousScopeFlag = "invisible"; },
  ]) { const d = descriptor(); mutate(d); expect(() => parseScenarioPackageDescriptor(d)).toThrow(); }
});
