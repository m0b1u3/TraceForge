import {expect,it,vi} from "vitest";
import {createProvider} from "./factory.js";
import {attachmentContent} from "./attachment-content.js";
import {MessageAttachmentsSchema} from "@traceforge/shared/message-attachments";
import type {MessageAttachment} from "@traceforge/shared/message-attachments";
const image:MessageAttachment={kind:"image",name:"sample.png",mediaType:"image/png",data:"iVBORw0KGgo="};
const pdf:MessageAttachment={kind:"document",name:"sample.pdf",mediaType:"application/pdf",data:Buffer.from("%PDF-1.4\n").toString("base64")};
const audio:MessageAttachment={kind:"audio",name:"sample.wav",mediaType:"audio/wav",data:Buffer.from("RIFF0000WAVE").toString("base64")};
const text:MessageAttachment={kind:"text",name:"sample.txt",text:"neutral reference"};

it.each(["openai","responses","anthropic"] as const)("dispatches image, PDF and text through %s without dropping bytes",async protocol=>{
  let body:any;
  const provider=createProvider({provider:protocol,model:"neutral",baseUrl:"https://models.example/v1",apiKey:"fixture",modelProfile:{model:"neutral",baseUrl:"https://models.example/v1",protocol,source:"operator",imageInput:true,documentInput:true}},{fetch:async(input,init)=>{
    body=await new Request(input,init).json();return Response.json(protocol==="responses"?{status:"completed",output:[]}:protocol==="anthropic"?{content:[{type:"text",text:"ok"}],stop_reason:"end_turn",usage:{input_tokens:1,output_tokens:1}}:{choices:[{message:{content:"ok"},finish_reason:"stop"}]});
  }});
  await provider.runTools({system:"Task",messages:[{role:"user",content:"Read",attachments:[image,pdf,text]}],tools:[]});
  const serialized=JSON.stringify(body);
  expect(serialized).toContain(image.data);expect(serialized).toContain(pdf.data);expect(serialized).toContain(text.text);
  expect(serialized).not.toContain('"attachments"');
  expect(serialized).toContain(protocol==="responses"?"input_image":protocol==="anthropic"?'"type":"image"':"image_url");
});
it("only serializes audio on the implemented wire protocol",()=>{
  expect(attachmentContent({role:"user",content:"Listen",attachments:[audio]},"openai")).toContainEqual({type:"input_audio",input_audio:{data:audio.data,format:"wav"}});
  for(const protocol of ["anthropic","responses"] as const)expect(()=>attachmentContent({role:"user",content:"Listen",attachments:[audio]},protocol)).toThrow();
});
it("rejects unsupported or unknown capabilities before both dispatch modes",async()=>{
  const fetch=vi.fn();const provider=createProvider({provider:"openai",model:"neutral",baseUrl:"https://models.example/v1",apiKey:"fixture"},{fetch});
  const args={system:"Task",messages:[{role:"user" as const,content:"Read",attachments:[image]}],tools:[]};
  await expect(provider.runTools(args)).rejects.toThrow("附件");await expect(provider.streamTools!(args,{})).rejects.toThrow("附件");expect(fetch).not.toHaveBeenCalled();
});
it("rejects URL/path substitutions, malformed bytes and excessive attachments",()=>{
  expect(()=>MessageAttachmentsSchema.parse([{...image,data:"https://remote.example/image"}])).toThrow();
  expect(()=>MessageAttachmentsSchema.parse([{...image,path:"/private/file"}])).toThrow();
  expect(()=>MessageAttachmentsSchema.parse(Array(5).fill(text))).toThrow();
  expect(()=>attachmentContent({role:"user",content:"Read",attachments:[{...image,data:"YWJjZA=="}]},"openai")).toThrow();
});
