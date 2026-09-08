import { describe, expect, it, vi } from "vitest";
import { createProvider } from "./factory.js";
import { MODEL_SUPPLIERS, modelConnectionFetch, normalizeModelConnection } from "./connections.js";
import { LlmConfigSchema } from "./config.js";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("TraceForge upstream model connections", () => {
  it("works against a standalone HTTP endpoint without any external client proxy",async()=>{
    let captured:unknown;
    const server=createServer(async(request,response)=>{
      let body="";for await(const chunk of request)body+=chunk;
      captured={url:request.url,authorization:request.headers.authorization,body:JSON.parse(body)};
      response.setHeader("content-type","application/json");response.end(JSON.stringify({choices:[{message:{content:'{"ok":true}'},finish_reason:"stop"}]}));
    });
    await new Promise<void>(done=>server.listen(0,"127.0.0.1",done));
    try{
      const baseUrl=`http://127.0.0.1:${(server.address() as {port:number}).port}/v1`;
      const provider=createProvider({provider:"openai",baseUrl,apiKey:"standalone-key",model:"standalone"},{fetch:globalThis.fetch});
      expect(await provider.extractJson({system:"JSON",user:"ping",schema:{type:"object"}})).toEqual({ok:true});
      expect(captured).toMatchObject({url:"/v1/chat/completions",authorization:"Bearer standalone-key",body:{model:"standalone"}});
    }finally{server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));}
  });
  it("keeps client-specific configuration and Scenario/Core imports out of upstream adapters",()=>{
    for(const file of ["connections.ts","device-authorization.ts","factory.ts"]){
      const source=readFileSync(resolve("packages/llm/src",file),"utf8");
      expect(source).not.toMatch(/\.cc-switch|\.claude|\.grok|grok-cli:access|b1a00492|apps\/server|scenarios\/|@traceforge\/orchestration-core/);
    }
  });
  it.each(Object.entries(MODEL_SUPPLIERS))("routes %s directly through the existing provider contract", async (supplier, preset) => {
    const requests: Request[] = [];
    const transport = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(new Request(input, init));
      return Response.json({ choices: [{ message: { content: '{"ok":true}' }, finish_reason: "stop" }], usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } });
    });
    const config = LlmConfigSchema.parse({provider:"openai",supplier,model:"operator-selected-model",apiKey:"test-key",maxOutputTokens:1000,
      requestOptions:{thinking:"disabled",reasoningEffort:"low",temperature:0.5}});
    const provider = createProvider(config,{fetch:transport});
    await expect(provider.extractJson({system:"Return JSON",user:"ping",schema:{type:"object"}})).resolves.toEqual({ok:true});
    const request = requests[0]!;
    expect(request.url).toBe(`${preset.baseUrl}/chat/completions`);
    expect(request.headers.get("authorization")).toBe("Bearer test-key");
    expect(await request.json()).toMatchObject({model:"operator-selected-model",max_tokens:1000,thinking:{type:"disabled"},reasoning_effort:"low",temperature:0.5,
      response_format:{type:preset.jsonMode}});
  });
  it("resolves managed credentials per invocation and does not place them in messages",async()=>{
    let token="first";const requests:Request[]=[];
    const config={provider:"openai" as const,model:"model",baseUrl:"https://model.example/v1",credentialRef:"account-one"};
    const provider=createProvider(config,{credentials:{async resolve(){return {value:token,baseUrl:config.baseUrl,expiresAt:Date.now()+10000};}},
      fetch:async(input,init)=>{requests.push(new Request(input,init));return Response.json({choices:[{message:{content:'{"ok":true}'},finish_reason:"stop"}]});}});
    await provider.extractJson({system:"JSON",user:"ping",schema:{}});token="second";
    await provider.extractJson({system:"JSON",user:"ping",schema:{}});
    expect(requests.map(request=>request.headers.get("authorization"))).toEqual(["Bearer first","Bearer second"]);
    expect(await requests[1]!.text()).not.toContain("second");
  });
  it("enforces credential origin/path/expiry and blocks redirects",async()=>{
    const transport=vi.fn(async()=>Response.json({}));
    const config={provider:"openai" as const,model:"model",baseUrl:"https://model.example/v1",credentialRef:"account"};
    for(const credential of [{value:"key",baseUrl:"https://other.example/v1"},{value:"key",baseUrl:"https://model.example/other"},
      {value:"key",baseUrl:config.baseUrl,expiresAt:0}]) {
      const request=modelConnectionFetch(config,{fetch:transport,credentials:{async resolve(){return credential;}}});
      await expect(request("https://model.example/v1/chat/completions")).rejects.toThrow();
    }
    expect(transport).not.toHaveBeenCalled();
    const request=modelConnectionFetch({...config,credentialRef:undefined,apiKey:"key"},{fetch:async()=>new Response(null,{status:307,headers:{location:"https://other.example"}})});
    await expect(request("https://model.example/v1/chat/completions")).rejects.toThrow(/redirect/);
    await expect(request("https://model.example/v10/chat/completions")).rejects.toThrow(/escaped/);
  });
  it("uses bearer-only Anthropic authentication only when explicitly configured",async()=>{
    let captured:Request|undefined;
    const config={provider:"anthropic" as const,model:"model",baseUrl:"https://model.example",apiKey:"token",authMode:"bearer" as const};
    const request=modelConnectionFetch(config,{fetch:async(input,init)=>{captured=new Request(input,init);return Response.json({});}});
    await request("https://model.example/v1/messages",{headers:{"x-api-key":"old"}});
    expect(captured!.headers.get("x-api-key")).toBeNull();
    expect(captured!.headers.get("authorization")).toBe("Bearer token");
  });
  it("rejects incompatible presets, ambiguous credentials and unsafe endpoints",()=>{
    expect(normalizeModelConnection({provider:"responses",supplier:"xai",model:"m"})).toMatchObject({provider:"responses",baseUrl:MODEL_SUPPLIERS.xai.baseUrl});
    expect(()=>normalizeModelConnection({provider:"openai",model:"m",apiKey:"key",credentialRef:"account"})).toThrow(/either/);
    for(const baseUrl of ["https://user:password@example.com/v1","http://example.com","https://example.com?token=secret"])
      expect(()=>normalizeModelConnection({provider:"openai",model:"m",baseUrl})).toThrow();
    expect(()=>createProvider({provider:"openai",model:"m",credentialRef:"account"})).toThrow(/resolver/);
    expect(LlmConfigSchema.safeParse({provider:"openai",model:"m",requestOptions:{apiKey:"hidden"}}).success).toBe(false);
  });
});
