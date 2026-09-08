import { expect, it } from "vitest";
import { parseMcpInputPolicy, validateMcpPolicyInput, authorizeMcpPolicyInput } from "./mcp-input-policy.js";

it("validates declarative fields and authorizes every resource independently", () => {
  const policy = parseMcpInputPolicy({ version: 1, fields: { targets: { type: "string_list", required: true } }, resources: [{ field: "targets", kind: "resource" }] });
  const seen: string[] = [];
  authorizeMcpPolicyInput(policy, { targets: ["first", "second"] }, (_kind, value) => { seen.push(value); return value; });
  expect(seen).toEqual(["first", "second"]);
  expect(() => authorizeMcpPolicyInput(policy, { targets: ["first"] }, () => "different")).toThrow("not authorized");
  expect(() => authorizeMcpPolicyInput(policy, { targets: [] }, (_kind, value) => value)).toThrow("empty");
  expect(() => validateMcpPolicyInput(policy, { targets: [1] })).toThrow();
  expect(() => validateMcpPolicyInput(policy, { targets: ["first"], extra: true })).toThrow("Unknown");
  expect(() => validateMcpPolicyInput(policy, {})).toThrow("Missing");
});

it("rejects optional resource bindings and invalid allowlists", () => {
  expect(() => parseMcpInputPolicy({ version: 1, fields: { target: { type: "string", required: false } }, resources: [{ field: "target", kind: "resource" }] })).toThrow("required");
  expect(() => parseMcpInputPolicy({ version: 1, fields: { count: { type: "number", required: true, values: ["1"] } }, resources: [] })).toThrow("text");
  const policy = parseMcpInputPolicy({ version: 1, fields: { mode: { type: "string", required: true, values: ["read"] } }, resources: [] });
  expect(() => validateMcpPolicyInput(policy, { mode: "write" })).toThrow();
});
