import { expect, it } from "vitest";
import { createProvider } from "./factory.js";
import { continuation, continuationState } from "./model-continuation.js";
import { modelStreamEvents } from "./stream-events.js";
import type { ModelStreamEvent, TurnMessage } from "./provider.js";

const options = { apiKey: "fixture", model: "neutral", baseUrl: "https://model.example/v1", maxOutputTokens:8192 };
const args = { system: "Task", messages: [{role:"user" as const,content:"Read"}], tools: [{name:"read",description:"Read",input_schema:{type:"object"}}] };
const replies = {
  openai: {choices:[{message:{content:"",reasoning_content:"  original reasoning  ",tool_calls:[{id:"call",type:"function",function:{name:"read",arguments:"{}"}}]},finish_reason:"tool_calls"}]},
  anthropic: {id:"m",type:"message",role:"assistant",content:[{type:"thinking",thinking:"original reasoning",signature:"signed-fixture"},{type:"redacted_thinking",data:"redacted-fixture"},{type:"tool_use",id:"call",name:"read",input:{}}],stop_reason:"tool_use",usage:{input_tokens:1,output_tokens:1}},
  responses: {status:"completed",output:[{type:"reasoning",id:"reasoning-fixture",summary:[],encrypted_content:"encrypted-fixture"},{type:"function_call",call_id:"call",name:"read",arguments:"{}",status:"completed"}]},
};

it.each(["openai","anthropic","responses"] as const)("%s round-trips provider continuation with actual tool results",async protocol=>{
  const requests: any[] = [];
  const model = createProvider({...options,provider:protocol},{fetch:async(input,init)=>{
    requests.push(await new Request(input,init).json());return Response.json(replies[protocol]);
  }});
  const turn = await model.runTools(args);
  expect(turn.continuation?.state.protocol).toBe(protocol);
  const messages:TurnMessage[] = [...args.messages,{role:"assistant",content:turn.text,toolCalls:turn.toolCalls,continuation:turn.continuation},{role:"tool",toolCallId:"call",content:"actual result"}];
  await model.runTools({...args,messages});
  const body=requests[1];
  if(protocol === "openai") expect(body.messages[2].reasoning_content).toBe("  original reasoning  ");
  if(protocol === "anthropic") expect(body.messages[1].content.slice(0,2)).toEqual(replies.anthropic.content.slice(0,2));
  if(protocol === "responses") expect(body.input[1]).toEqual(replies.responses.output[0]);
  expect(JSON.stringify(body)).toContain("actual result");
  expect(JSON.stringify(body)).not.toContain('"connection"');
  const other = createProvider({...options,model:"other",provider:protocol},{fetch:async(input,init)=>{
    const serialized=JSON.stringify(await new Request(input,init).json());
    for(const privateValue of ["original reasoning","signed-fixture","redacted-fixture","encrypted-fixture"]) expect(serialized).not.toContain(privateValue);
    return Response.json(replies[protocol]);
  }});
  await other.runTools({...args,messages});
});

it("binds continuation to protocol, model, endpoint and account, but permits token rotation",()=>{
  const state=continuation({...options,continuationScope:"account"},{protocol:"openai",reasoning:"original"});
  expect(continuationState(state,{...options,continuationScope:"account",apiKey:"rotated"},"openai")).toBeDefined();
  for(const change of [{model:"other"},{baseUrl:"https://other.example/v1"},{continuationScope:"other"}])
    expect(continuationState(state,{...options,continuationScope:"account",...change},"openai")).toBeUndefined();
  expect(continuationState(state,{...options,continuationScope:"account"},"responses")).toBeUndefined();
  expect(()=>continuation(options,{protocol:"openai",reasoning:"x".repeat(2*1024*1024)})).toThrow("limit");
});

it.each(["openai","anthropic","responses"] as const)("%s streaming retains continuation only in the returned turn",async protocol=>{
  const frames = protocol === "openai" ? [
    {choices:[{delta:{reasoning_content:"original reasoning",tool_calls:[{index:0,id:"call",type:"function",function:{name:"read",arguments:"{}"}}]}}]},
    {choices:[{delta:{},finish_reason:"tool_calls"}]},
  ] : protocol === "responses" ? [{type:"response.completed",response:replies.responses}] : [
    {type:"message_start",message:{...replies.anthropic,content:[],stop_reason:null}},
    ...replies.anthropic.content.flatMap((content_block,index)=>[{type:"content_block_start",index,content_block},{type:"content_block_stop",index}]),
    {type:"message_delta",delta:{stop_reason:"tool_use",stop_sequence:null},usage:{output_tokens:1}},
    {type:"message_stop"},
  ];
  const model=createProvider({...options,provider:protocol},{fetch:async()=>new Response(frames.map(frame=>`${"type" in frame ? `event: ${frame.type}\n` : ""}data: ${JSON.stringify(frame)}\n\n`).join(""),{headers:{"content-type":"text/event-stream"}})});
  const events:ModelStreamEvent[]=[];
  const turn=await model.streamTools!(args,{onEvent:event=>events.push(event)});
  expect(turn.continuation?.state.protocol).toBe(protocol);
  expect(events.at(-1)).toMatchObject({type:"complete",turn:{done:false}});
  expect(events.at(-1)).not.toHaveProperty("turn.continuation");
  for(const secret of ["signed-fixture","redacted-fixture","encrypted-fixture"]) expect(JSON.stringify(events)).not.toContain(secret);
});

it("keeps private continuation out of display events while returning it to the host",async()=>{
  const events:ModelStreamEvent[]=[];
  const turn={text:"done",toolCalls:[],done:true,continuation:continuation(options,{protocol:"openai",reasoning:"private-fixture"})};
  expect(await modelStreamEvents({onEvent:event=>events.push(event)},async()=>turn)).toBe(turn);
  expect(JSON.stringify(events)).not.toContain("private-fixture");
  expect(events.at(-1)).toEqual({type:"complete",turn:{text:"done",toolCalls:[],done:true}});
});
