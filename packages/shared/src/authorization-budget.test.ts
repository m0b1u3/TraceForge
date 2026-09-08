import {expect,it} from "vitest";
import {AuthorizationFormSchema,buildAuthorizationScope} from "./authorization-form.js";
const form={version:1,description:"Budget",fields:[{path:["budget"],label:"Budget",description:"Reviewed task limit",type:"integer",required:false,minimum:1,maximum:100,defaultValue:6}]};
it("requires bounded integer consent and rejects coercive or overflowing budget values",()=>{
  expect(buildAuthorizationScope(AuthorizationFormSchema.parse(form),["20"])).toEqual({budget:20});
  for(const value of ["-1","0","101","1.5","1e2","", "true"])expect(()=>buildAuthorizationScope(AuthorizationFormSchema.parse(form),[value])).toThrow();
  expect(AuthorizationFormSchema.safeParse({...form,fields:[{...form.fields[0],defaultValue:101}]}).success).toBe(false);
});
