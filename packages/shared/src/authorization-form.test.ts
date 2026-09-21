import { expect, it } from "vitest";
import { AuthorizationFormSchema, buildAuthorizationScope, type AuthorizationForm } from "./authorization-form.js";

const form: AuthorizationForm = { version: 1, description: "Reviewed resources", fields: [
  { path: ["scope", "items"], label: "资源", description: "Literal identifiers", type: "string-list", required: true, maximumItems: 2, maximumLength: 100 },
] };
it("omits an optional numeric budget when blank instead of manufacturing a default",()=>{
  const policy=AuthorizationFormSchema.parse({version:1,description:"Optional budget",fields:[{path:["turns"],label:"Turns",description:"Optional",type:"integer",required:false,minimum:1,maximum:Number.MAX_SAFE_INTEGER}]});
  expect(buildAuthorizationScope(policy,[""])).toEqual({});
  expect(buildAuthorizationScope(policy,[])).toEqual({});
  expect(buildAuthorizationScope(policy,["1234567"])).toEqual({turns:1234567});
});
it("never infers boolean consent from prose, arrays or missing input", () => {
  const policy = AuthorizationFormSchema.parse({ ...form, fields: [{ ...form.fields[0], type: "boolean", required: false }] });
  expect(buildAuthorizationScope(policy, [])).toEqual({ scope: { items: false } });
  expect(buildAuthorizationScope(policy, ["true"])).toEqual({ scope: { items: true } });
  expect(buildAuthorizationScope(policy, ["false"])).toEqual({ scope: { items: false } });
  expect(() => buildAuthorizationScope(policy, ["yes"])).toThrow();
});
it("builds only literal declared values without guessing resource semantics", () => {
  expect(buildAuthorizationScope(form, [" first\r\nsecond "])).toEqual({ scope: { items: ["first", "second"] } });
  expect(() => buildAuthorizationScope(form, [""])).toThrow("请填写");
  expect(() => buildAuthorizationScope(form, ["a\nb\nc"])).toThrow("限制");
  expect(() => buildAuthorizationScope(form, ["x".repeat(101)])).toThrow("限制");
});
it("rejects executable, unknown, overlapping and prototype paths", () => {
  expect(AuthorizationFormSchema.safeParse({ ...form, execute: "code" }).success).toBe(false);
  for (const path of [["constructor"], ["__proto__"]])
    expect(AuthorizationFormSchema.safeParse({ ...form, fields: [{ ...form.fields[0], path }] }).success).toBe(false);
  expect(AuthorizationFormSchema.safeParse({ ...form, fields: [...form.fields, { ...form.fields[0], path: ["scope"] }] }).success).toBe(false);
  expect(AuthorizationFormSchema.safeParse({ ...form, version: 2 }).success).toBe(false);
});
