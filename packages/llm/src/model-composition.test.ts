import { expect, it, vi } from "vitest";
import { createProvider } from "./factory.js";
import { normalizeModelConnection } from "./connections.js";
import type { ModelStreamEvent, TurnMessage } from "./provider.js";

const options = { model: "neutral", apiKey: "fixture", baseUrl: "https://provider.example/v1", maxOutputTokens:8192 };
const args = { system: "Neutral task", messages: [{ role: "user" as const, content: "Read" }], tools: [{ name: "read", description: "Read", input_schema: { type: "object" } }] };
const completed = { status: "completed", output: [{ type: "function_call", call_id: "first", name: "read", arguments: '{"path":"a"}', status: "completed" }] };
const events = {
  openai: [
    { choices: [{ delta: { tool_calls: [{ index: 0, id: "first", function: { name: "read", arguments: '{"path":' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"a"}' } }] }, finish_reason: "tool_calls" }] },
  ],
  responses: [
    { type: "response.output_item.added", output_index: 0, item: { type: "function_call", call_id: "first", name: "read" } },
    { type: "response.function_call_arguments.delta", output_index: 0, delta: '{"path":' },
    { type: "response.function_call_arguments.delta", output_index: 0, delta: '"a"}' },
    { type: "response.completed", response: completed },
  ],
  anthropic: [
    { type: "message_start", message: { id: "m", type: "message", role: "assistant", model: "neutral", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "first", name: "read", input: {} } },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"path":' } },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '"a"}' } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 1 } },
    { type: "message_stop" },
  ],
};

it.each(["openai", "responses", "anthropic"] as const)("%s gateway exposes native tool argument deltas and one validated completion", async provider => {
  const collected: ModelStreamEvent[] = [];
  const fetch = vi.fn(async () => new Response(events[provider].map(event => `${"type" in event ? `event: ${event.type}\n` : ""}data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } }));
  const model = createProvider({ ...options, provider }, { fetch });
  const turn = await model.streamTools!(args, { onEvent: event => collected.push(event) });
  expect(turn.toolCalls).toEqual([{ id: "first", name: "read", input: { path: "a" } }]);
  expect(collected[0]).toEqual({ type: "start" });
  expect(collected.at(-1)).toMatchObject({ type: "complete", turn });
  expect(collected.filter(event => event.type === "tool_call_delta").map(event => event.delta).join("")).toBe('{"path":"a"}');
  expect(collected.filter(event => event.type === "complete")).toHaveLength(1);
  expect(fetch).toHaveBeenCalledOnce();
});

it.each(["openai", "responses", "anthropic"] as const)("%s serializes portable history without changing the original tool IDs", async provider => {
  const id = "foreign|" + "x".repeat(100);
  const messages: TurnMessage[] = [{role:"assistant",content:"",toolCalls:[{id,name:"read",input:{}}]}, {role:"tool",toolCallId:id,content:"saved"}];
  let body: Record<string, any> = {};
  const model = createProvider({ ...options, provider }, { fetch: async (input, init) => {
    body = await new Request(input, init).json();
    return Response.json(provider === "responses" ? { status:"completed", output:[] } : provider === "openai" ? {choices:[{message:{content:"done"},finish_reason:"stop"}]} : {id:"m",type:"message",role:"assistant",content:[{type:"text",text:"done"}],stop_reason:"end_turn",usage:{input_tokens:1,output_tokens:1}});
  } });
  await model.runTools({ ...args, messages });
  const serialized = JSON.stringify(body);
  expect(serialized).not.toContain(id);
  expect(serialized.match(/tfh_[a-f0-9]{60}/g)).toHaveLength(2);
  expect(messages[0].toolCalls![0].id).toBe(id);
});

it("supplier defaults do not leak across protocols and compatible Messages endpoints receive no implicit Claude flags", async () => {
  expect(normalizeModelConnection({provider:"anthropic",supplier:"kimi",model:"neutral"}).jsonMode).toBeUndefined();
  let body: any;
  const model = createProvider({...options,provider:"anthropic",supplier:"kimi"}, {fetch: async(input,init) => {
    body = await new Request(input,init).json();
    return Response.json({id:"m",type:"message",role:"assistant",content:[{type:"text",text:'{"ok":true}'}],stop_reason:"end_turn",usage:{input_tokens:1,output_tokens:1}});
  }});
  expect(await model.extractJson({system:"JSON",user:"hello",schema:{type:"object"}})).toEqual({ok:true});
  expect(body).not.toHaveProperty("thinking");
  expect(body).not.toHaveProperty("output_config");
  expect(() => createProvider({...options,provider:"anthropic",requestOptions:{reasoningEffort:"high"}})).toThrow("reasoningEffort");
});

it.each(["openai", "responses", "anthropic"] as const)("%s rejects missing results before dispatch", async provider => {
  const fetch = vi.fn();
  const model = createProvider({...options,provider},{fetch});
  await expect(model.runTools({...args,messages:[{role:"assistant",content:"",toolCalls:[{id:"first",name:"read",input:{}}]}]})).rejects.toThrow("results are missing");
  expect(fetch).not.toHaveBeenCalled();
});

it.each(["openai", "responses", "anthropic"] as const)("%s cancellation emits no successful completion or network request", async provider => {
  const fetch = vi.fn(), abort = new AbortController(); abort.abort();
  const collected: ModelStreamEvent[] = [];
  const model = createProvider({...options,provider},{fetch});
  await expect(model.streamTools!(args,{signal:abort.signal,onEvent:event=>collected.push(event)})).rejects.toThrow();
  expect(collected).toEqual([{type:"error",aborted:true}]);
  expect(fetch).not.toHaveBeenCalled();
});

it.each(["openai", "responses", "anthropic"] as const)("%s incomplete stream emits an error instead of completing or replaying", async provider => {
  const collected: ModelStreamEvent[] = [];
  const fetch = vi.fn(async () => new Response("",{headers:{"content-type":"text/event-stream"}}));
  const model = createProvider({...options,provider},{fetch});
  await expect(model.streamTools!(args,{onEvent:event=>collected.push(event)})).rejects.toThrow();
  expect(collected).toEqual([{type:"start"},{type:"error",aborted:false}]);
  expect(fetch).toHaveBeenCalledOnce();
});

it.each(["openai", "anthropic"] as const)("%s SDK does not multiply the explicit retry policy", async provider => {
  const fetch = vi.fn(async () => Response.json({error:{type:"rate_limit_error",message:"rate limited"}},{status:429}));
  const model = createProvider({...options,provider},{fetch});
  await expect(model.runTools(args)).rejects.toThrow();
  expect(fetch).toHaveBeenCalledTimes(3);
});

it.each(["enabled", "disabled"] as const)("Messages honors explicit %s thinking and temperature", async thinking => {
  let body: any;
  const model = createProvider({...options,provider:"anthropic",jsonMode:"json_schema",requestOptions:{thinking,temperature:1}}, {fetch:async(input,init)=>{
    body=await new Request(input,init).json();
    return Response.json({id:"m",type:"message",role:"assistant",content:[{type:"text",text:'{}'}],stop_reason:"end_turn",usage:{input_tokens:1,output_tokens:1}});
  }});
  await model.extractJson({system:"JSON",user:"hello",schema:{type:"object"}});
  expect(body.thinking).toEqual({type:thinking === "enabled" ? "adaptive" : "disabled"});
  expect(body.temperature).toBe(1);
  expect(body.output_config.format.type).toBe("json_schema");
});
