import {expect,it,vi} from "vitest";
import {createProvider} from "./factory.js";
import {discoverModels} from "./model-catalog.js";
import {applyModelProfile,profileFromCatalog} from "./model-profile.js";
const config={provider:"openai" as const,model:"neutral",baseUrl:"https://models.example/v1",apiKey:"fixture"};
const profile={model:config.model,baseUrl:config.baseUrl,protocol:config.provider,source:"catalog" as const,contextWindowTokens:64000,maxOutputTokens:1024,toolCalling:true};

it("only projects allowlisted, bounded directory metadata",()=>{
  expect(profileFromCatalog({id:"neutral",context_length:64000,top_provider:{max_completion_tokens:1024},supported_parameters:["tools","reasoning"],secret:"never"},config)).toMatchObject({...profile,reasoning:true});
  expect(profileFromCatalog({id:"neutral",context_length:-1,max_output_tokens:Infinity,capabilities:{thinking:{supported:"yes"}}},config)).toBeUndefined();
  expect(profileFromCatalog({id:"neutral",max_input_tokens:200000,max_tokens:8192,capabilities:{thinking:{supported:true,types:{adaptive:{supported:false}}}}},{...config,provider:"anthropic"})).toMatchObject({contextWindowTokens:200000,maxOutputTokens:8192,reasoning:true,adaptiveThinking:false});
});
it("uses documented defaults only for exact official endpoint and model",()=>{
  expect(profileFromCatalog({id:"deepseek-flash"},{...config,baseUrl:"https://api.deepseek.com"})).toMatchObject({source:"documentation",contextWindowTokens:1000000});
  expect(profileFromCatalog({id:"deepseek-flash"},config)).toBeUndefined();
  expect(profileFromCatalog({id:"deepseek-future"},{...config,baseUrl:"https://api.deepseek.com"})).toBeUndefined();
});
it("keeps unknown capabilities unknown and drops conflicting duplicate declarations",async()=>{
  const catalog=await discoverModels(config,{fetch:async()=>Response.json({data:[{id:"neutral",context_length:64000},{id:"neutral",context_length:32000},{id:"unknown"}]})});
  expect(catalog.models).toEqual([{id:"neutral"},{id:"unknown"}]);
});
it("applies saved profile to real request output limit and context budget",async()=>{
  let body:any;
  const provider=createProvider({...config,modelProfile:profile},{fetch:async(input,init)=>{body=await new Request(input,init).json();return Response.json({choices:[{message:{content:'{}'},finish_reason:"stop"}]});}});
  expect(provider.contextLimits).toMatchObject({contextWindowTokens:64000,maxOutputTokens:1024});
  await provider.extractJson({system:"JSON",user:"hello",schema:{}});
  expect(body.max_tokens).toBe(1024);expect(body).not.toHaveProperty("modelProfile");
  expect(applyModelProfile({...config,modelProfile:profile,contextWindowTokens:32000,maxOutputTokens:512})).toMatchObject({contextWindowTokens:32000,maxOutputTokens:512});
});
it("uses the full supplied model capacity instead of a 4096-token product default",async()=>{
  const declared={...profile,contextWindowTokens:1000000,maxOutputTokens:384000};
  let body:any;
  const provider=createProvider({...config,modelProfile:declared},{fetch:async(input,init)=>{body=await new Request(input,init).json();return Response.json({choices:[{message:{content:'{}'},finish_reason:"stop"}]});}});
  await provider.extractJson({system:"JSON",user:"hello",schema:{}});
  expect(body.max_tokens).toBe(declared.maxOutputTokens);
});
it.each(["openai","responses"] as const)("omits an invented output cap for %s when the connection declares none",async protocol=>{
  let body:any;
  const provider=createProvider({...config,provider:protocol},{fetch:async(input,init)=>{
    body=await new Request(input,init).json();
    return Response.json(protocol==="openai"?{choices:[{message:{content:'{}'},finish_reason:"stop"}]}:{status:"completed",output:[{type:"message",status:"completed",role:"assistant",content:[{type:"output_text",text:"{}"}]}]});
  }});
  await provider.extractJson({system:"JSON",user:"hello",schema:{}});
  expect(body).not.toHaveProperty("max_tokens");expect(body).not.toHaveProperty("max_output_tokens");
});
it("rejects mismatched profiles and unsupported declarations before network activity",async()=>{
  for(const change of [{model:"other"},{baseUrl:"https://other.example"},{provider:"responses" as const}]) expect(()=>createProvider({...config,modelProfile:profile,...change})).toThrow("another connection");
  expect(()=>createProvider({...config,modelProfile:profile,maxOutputTokens:4096})).toThrow("maximum");
  expect(()=>createProvider({...config,modelProfile:{...profile,reasoning:false},requestOptions:{thinking:"enabled"}})).toThrow("reasoning");
  const fetch=vi.fn();const provider=createProvider({...config,modelProfile:{...profile,toolCalling:false}},{fetch});
  const args={system:"Task",messages:[],tools:[{name:"read",description:"Read",input_schema:{}}]};
  await expect(provider.runTools(args)).rejects.toThrow("tool calling");
  await expect(provider.streamTools!(args,{})).rejects.toThrow("tool calling");expect(fetch).not.toHaveBeenCalled();
});
