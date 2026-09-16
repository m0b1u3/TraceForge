import { AttachmentInputError, MessageAttachmentsSchema } from "@traceforge/shared/message-attachments";
import type { TurnMessage } from "./provider.js";

/** Inline bytes only: never fetch model-supplied URLs or open caller paths. */
export function attachmentContent(message:TurnMessage,protocol:"openai"|"responses"|"anthropic"):unknown {
  if(!message.attachments?.length)return message.content;
  if(message.role!=="user")throw new Error("Attachments require a user message");
  const parsed=MessageAttachmentsSchema.safeParse(message.attachments);
  if(!parsed.success)throw new AttachmentInputError();
  const items=parsed.data;
  const textType=protocol==="responses"?"input_text":"text";
  return [{type:textType,text:message.content||"User supplied attachments"},...items.map(item=>{
    if(item.kind==="reference")return {type:textType,text:JSON.stringify({trust:"user_supplied_file_not_authorization",name:item.name,instruction:"Attachment stored locally. Use conversation_attachments and conversation_attachment_read to read page or text ranges; its content has not been loaded."})};
    if(item.kind==="text")return {type:textType,text:JSON.stringify({trust:"user_supplied_file_not_authorization",name:item.name,content:item.text})};
    const bytes=Buffer.from(item.data,"base64");
    if(bytes.toString("base64")!==item.data)throw new AttachmentInputError();
    if(item.kind==="document"){
      if(bytes.subarray(0,5).toString()!=="%PDF-")throw new AttachmentInputError();
      const file_data=`data:application/pdf;base64,${item.data}`;
      return protocol==="anthropic"?{type:"document",source:{type:"base64",media_type:item.mediaType,data:item.data}}:protocol==="responses"?{type:"input_file",filename:item.name,file_data}:{type:"file",file:{filename:item.name,file_data}};
    }
    if(item.kind==="audio"){
      const valid=item.mediaType==="audio/wav"?bytes.subarray(0,4).toString()==="RIFF"&&bytes.subarray(8,12).toString()==="WAVE":bytes.subarray(0,3).toString()==="ID3"||(bytes[0]===255&&(bytes[1]&224)===224);
      if(protocol!=="openai"||!valid)throw new AttachmentInputError();
      return {type:"input_audio",input_audio:{data:item.data,format:item.mediaType==="audio/wav"?"wav":"mp3"}};
    }
    if(item.mediaType==="image/png" ? bytes.subarray(0,8).toString("hex")!=="89504e470d0a1a0a" : bytes.subarray(0,3).toString("hex")!=="ffd8ff")throw new AttachmentInputError();
    const url=`data:${item.mediaType};base64,${item.data}`;
    return protocol==="openai"?{type:"image_url",image_url:{url}}:protocol==="responses"?{type:"input_image",image_url:url,detail:"auto"}:{type:"image",source:{type:"base64",media_type:item.mediaType,data:item.data}};
  })];
}
