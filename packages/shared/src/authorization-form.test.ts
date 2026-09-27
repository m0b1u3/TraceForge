import { expect, it } from "vitest";
import { AuthorizationFormSchema, buildAuthorizationScope, defaultTaskConfiguration, prepareTaskConfigurationReview, resolveTaskConfiguration, TaskDefinitionSchema, type AuthorizationForm } from "./authorization-form.js";

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
it("prepares changed preferences for explicit review without enabling new grants",()=>{
  const old=TaskDefinitionSchema.parse({kind:"neutral",version:1,authorizationForm:{version:1,description:"Scope",fields:[
    {path:["target"],label:"Target",description:"Exact",type:"string-list",required:false},
    {path:["continue"],label:"Continue",description:"Prior consent",type:"boolean",required:false},
  ]},authorizationReview:{actionSelection:true,allowedActions:["read","write"],deniedActions:[],resources:[]}});
  const saved={...defaultTaskConfiguration(old),revision:2,inputs:["first","true"],actions:["read","new-action"]};
  const current=TaskDefinitionSchema.parse({...old,version:2,authorizationForm:{...old.authorizationForm,fields:[
    {path:["direct"],label:"Direct",description:"New grant",type:"boolean",required:false,defaultEnabled:true},
    ...old.authorizationForm.fields,
  ]},authorizationReview:{...old.authorizationReview,allowedActions:["read","write","new-action"]}});
  const raw=JSON.stringify([{kind:old.kind,preset:saved}]);
  expect(()=>resolveTaskConfiguration(current,raw)).toThrow("场景配置已变化");
  const draft=prepareTaskConfigurationReview(current,raw);
  expect(draft.reviewRequired).toBe(true);
  expect(draft.preset.inputs).toEqual(["false","first","true"]);
  expect(draft.preset.actions).toEqual(["read"]);
  expect(prepareTaskConfigurationReview(current,null).preset.inputs[0]).toBe("true");
});
