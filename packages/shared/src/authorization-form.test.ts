import { expect, it } from "vitest";
import { AuthorizationFormSchema, buildAuthorizationScope, type AuthorizationForm } from "./authorization-form.js";

const form: AuthorizationForm = { version: 1, description: "Reviewed resources", fields: [
  { path: ["scope", "items"], label: "资源", description: "Literal identifiers", type: "string-list", required: true, maximumItems: 2, maximumLength: 100 },
] };
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
