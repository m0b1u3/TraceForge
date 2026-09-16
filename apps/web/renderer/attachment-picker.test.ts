// @vitest-environment jsdom
import React,{act} from "react";
import {createRoot} from "react-dom/client";
import {Simulate} from "react-dom/test-utils";
import {expect,it,vi} from "vitest";
import {AttachmentPicker} from "./attachment-picker";

it("uses native large-file references, handles cancel and import errors",async()=>{
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
  const node=document.createElement("div"),root=createRoot(node),onAdd=vi.fn();
  const reference={kind:"reference",id:"40f721bd-7662-4cb0-8f7d-27e99d4cce0e",name:"large.pdf"};
  const selectFiles=vi.fn().mockResolvedValueOnce([reference]).mockResolvedValueOnce([]).mockRejectedValueOnce(new Error("failed"));
  try{
    await act(async()=>root.render(React.createElement(AttachmentPicker,{disabled:false,onAdd,selectFiles})));
    const button=Array.from(node.querySelectorAll("button")).find(b=>b.textContent==="添加附件")!;
    await act(async()=>button.click());expect(onAdd).toHaveBeenCalledWith([reference]);
    await act(async()=>button.click());expect(onAdd).toHaveBeenCalledTimes(1);
    await act(async()=>button.click());expect(node.querySelector('[role="alert"]')?.textContent).toContain("32 MiB");
  }finally{await act(async()=>root.unmount());}
});

it("reads only selected files, reports unsupported formats and releases reading state",async()=>{
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
  const node=document.createElement("div"),root=createRoot(node),onAdd=vi.fn(),onReading=vi.fn();
  try{
    await act(async()=>root.render(React.createElement(AttachmentPicker,{disabled:false,onAdd,onReading})));
    const input=node.querySelector("input")!;
    const choose=async(name:string,type:string,bytes:number[])=>{
      Object.defineProperty(input,"files",{configurable:true,value:[{name,type,size:bytes.length,arrayBuffer:async()=>new Uint8Array(bytes).buffer}]});
      await act(async()=>Simulate.change(input));
    };
    await choose("reference.txt","text/plain",[65,66,67]);expect(onAdd).toHaveBeenLastCalledWith([{kind:"text",name:"reference.txt",text:"ABC"}]);
    await choose("movie.mp4","video/mp4",[1,2]);expect(node.textContent).toContain("视频暂未接通");expect(onAdd).toHaveBeenCalledTimes(1);
    expect(onReading).toHaveBeenLastCalledWith(false);
  }finally{await act(async()=>root.unmount());}
});
