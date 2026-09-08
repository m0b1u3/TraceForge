import { expect, it, vi } from "vitest";
import { OpenAICompatibleProvider } from "./openai-provider.js";
import { AnthropicProvider } from "./anthropic-provider.js";

function upstream() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const fetch = vi.fn(async (_request: unknown, init?: RequestInit) => {
    const body = new ReadableStream<Uint8Array>({ start(c) { controller = c; } });
    init?.signal?.addEventListener("abort", () => { try { controller.error(new DOMException("aborted", "AbortError")); } catch {} }, { once: true });
    return new Response(body, { headers: { "content-type": "text/event-stream" } });
  }) as typeof globalThis.fetch & { mock: { calls: unknown[][] } };
  return { fetch, send(value: object, type?: string) { controller.enqueue(new TextEncoder().encode(`${type ? `event: ${type}\n` : ""}data: ${JSON.stringify(value)}\n\n`)); }, end() { controller.close(); }, fail() { controller.error(new Error("ECONNRESET")); } };
}
const args = { system: "Text only", messages: [{ role: "user" as const, content: "Hello" }], tools: [] };
it("Chat Completions delivers native deltas before completion and omits empty tools", async () => {
  const u=upstream(),provider=new OpenAICompatibleProvider({apiKey:"test",model:"neutral",fetch:u.fetch});
  const delta=vi.fn();let done=false;
  const result=provider.streamTools(args,{onTextDelta:delta}).then(value=>{done=true;return value;});
  await vi.waitFor(()=>expect(u.fetch).toHaveBeenCalledOnce());
  u.send({choices:[{delta:{content:"Hello"},finish_reason:null}]});
  await vi.waitFor(()=>expect(delta).toHaveBeenCalledWith("Hello"));expect(done).toBe(false);
  u.send({choices:[{delta:{},finish_reason:"stop"}]});u.end();
  expect(await result).toMatchObject({text:"Hello",done:true,toolCalls:[]});
  expect(JSON.parse((u.fetch.mock.calls[0]![1] as RequestInit).body as string)).not.toHaveProperty("tools");
});
it("Chat Completions never replays a broken stream or accepts missing completion",async()=>{
  for(const failure of ["network","eof"]){
    const u=upstream(),provider=new OpenAICompatibleProvider({apiKey:"test",model:"neutral",fetch:u.fetch});
    const delta=vi.fn(),result=provider.streamTools(args,{onTextDelta:delta});
    const rejected=expect(result).rejects.toThrow();
    await vi.waitFor(()=>expect(u.fetch).toHaveBeenCalledOnce());u.send({choices:[{delta:{content:"partial"}}]});
    await vi.waitFor(()=>expect(delta).toHaveBeenCalledOnce());
    if(failure==="network")u.fail();else u.end();
    await rejected;expect(u.fetch).toHaveBeenCalledOnce();
  }
});
it("Anthropic consumes native text events and confirms final message before success",async()=>{
  const u=upstream(),provider=new AnthropicProvider({apiKey:"test",model:"neutral",fetch:u.fetch});
  const delta=vi.fn();let done=false;
  const result=provider.streamTools(args,{onTextDelta:delta}).then(value=>{done=true;return value;});
  await vi.waitFor(()=>expect(u.fetch).toHaveBeenCalledOnce());
  u.send({type:"message_start",message:{id:"message",type:"message",role:"assistant",content:[],model:"neutral",stop_reason:null,stop_sequence:null,usage:{input_tokens:3,output_tokens:0}}},"message_start");
  u.send({type:"content_block_start",index:0,content_block:{type:"text",text:""}},"content_block_start");
  u.send({type:"content_block_delta",index:0,delta:{type:"text_delta",text:"Native text"}},"content_block_delta");
  await vi.waitFor(()=>expect(delta).toHaveBeenCalledWith("Native text"));expect(done).toBe(false);
  u.send({type:"content_block_stop",index:0},"content_block_stop");
  u.send({type:"message_delta",delta:{stop_reason:"end_turn",stop_sequence:null},usage:{output_tokens:2}},"message_delta");
  u.send({type:"message_stop"},"message_stop");u.end();
  expect(await result).toMatchObject({text:"Native text",toolCalls:[],done:true});expect(u.fetch).toHaveBeenCalledOnce();
});
it("native protocols abort without a retry",async()=>{
  for(const Provider of [OpenAICompatibleProvider,AnthropicProvider]){
    const u=upstream(),provider=new Provider({apiKey:"test",model:"neutral",fetch:u.fetch}),abort=new AbortController();
    const result=provider.streamTools(args,{signal:abort.signal});const rejected=expect(result).rejects.toThrow();
    await vi.waitFor(()=>expect(u.fetch).toHaveBeenCalledOnce());abort.abort();await rejected;expect(u.fetch).toHaveBeenCalledOnce();
  }
});
