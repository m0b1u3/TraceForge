import React, { useRef, useState } from "react";
import { Paperclip } from "@phosphor-icons/react";
import { MessageAttachmentsSchema, type MessageAttachment } from "@traceforge/shared/message-attachments";

export function AttachmentPicker({disabled,onAdd,onReading,selectFiles,onError}:{disabled:boolean;onAdd(items:MessageAttachment[]):void;onReading?(value:boolean):void;selectFiles?():Promise<unknown>;onError?(value:string):void}){
  const input=useRef<HTMLInputElement>(null);const [error,setLocalError]=useState("");const [reading,setReading]=useState(false);
  function setError(value:string){setLocalError(value);onError?.(value);}
  async function read(files:File[]){
    setReading(true);onReading?.(true);setError("");
    try{
      if(files.length>4)throw new Error("每次最多选择 4 个附件。");
      const items:MessageAttachment[]=[];
      for(const file of files){
        if(file.size>1048576)throw new Error("单个附件不能超过 1 MiB，请先缩小文件。");
        const bytes=new Uint8Array(await file.arrayBuffer());
        if(["image/png","image/jpeg","application/pdf","audio/wav","audio/mpeg","audio/x-wav"].includes(file.type)){
          let binary="";for(const byte of bytes)binary+=String.fromCharCode(byte);
          const mediaType=file.type==="audio/x-wav"?"audio/wav":file.type;
          items.push({kind:mediaType==="application/pdf"?"document":mediaType.startsWith("audio/")?"audio":"image",name:file.name,mediaType,data:btoa(binary)} as MessageAttachment);
        }else{
          if(!/\.(txt|md|json|csv|log|yaml|yml|xml|html|css|js|ts|py|sh)$/i.test(file.name))throw new Error("支持 PNG、JPEG、PDF、WAV、MP3 和 UTF-8 文本。Office、视频暂未接通；音频需 Chat Completions 兼容模型。");
          const text=new TextDecoder("utf-8",{fatal:true}).decode(bytes);
          if(text.includes("\0"))throw new Error("该文件不是可读取的文本。");
          items.push({kind:"text",name:file.name,text});
        }
      }
      onAdd(MessageAttachmentsSchema.parse(items));
    }catch(cause){setError(cause instanceof Error && !("issues" in cause)?cause.message:"附件超过大小限制，请缩小后重试。");}
    finally{setReading(false);onReading?.(false);if(input.current)input.current.value="";}
  }
  async function select(){
    setReading(true);onReading?.(true);setError("");
    try{const items=MessageAttachmentsSchema.parse(await selectFiles!());if(items.length)onAdd(items);}
    catch{setError("文件未能添加。最多 4 份；未加密 PDF / UTF-8 文本每份不超过 32 MiB，图片 / 音频不超过 1 MiB。请检查文件后重试。");}
    finally{setReading(false);onReading?.(false);}
  }
  return <><input hidden ref={input} type="file" multiple aria-label="选择附件" onChange={event=>void read(Array.from(event.target.files??[]))}/>
    <button type="button" disabled={disabled||reading} onClick={()=>selectFiles?void select():input.current?.click()}><Paperclip aria-hidden="true"/>{reading?"读取附件…":"添加附件"}</button>
    {error&&!onError&&<span role="alert">{error}</span>}</>;
}
