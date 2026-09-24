// @vitest-environment jsdom
import React,{act} from "react";
import {createRoot} from "react-dom/client";
import {expect,it,vi} from "vitest";
import {ArtifactPreviewPanel,ArtifactPreviewProvider,useArtifactPreview} from "./artifact-preview";
it("supports keyboard preview tabs and Escape without any model or mutation request",async()=>{
 (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
 const request=vi.fn();function Open(){const p=useArtifactPreview();return <button onClick={()=>{for(const id of ["first","second"])p!.open({kind:"text",conversationId:"c",sourceId:id,title:id,text:id});}}>Open</button>;}
 const node=document.createElement("div"),root=createRoot(node);document.body.append(node);
 try{
  await act(async()=>root.render(<ArtifactPreviewProvider><Open/><ArtifactPreviewPanel bridge={{protocolVersion:1,request}} conversationId="c"/></ArtifactPreviewProvider>));
  const opener=node.querySelector("button")!;opener.focus();await act(async()=>opener.click());
  const tabs=node.querySelectorAll<HTMLButtonElement>('[role="tab"]');expect(tabs[1]!.tabIndex).toBe(0);
  await act(async()=>tabs[1]!.dispatchEvent(new KeyboardEvent("keydown",{key:"Home",bubbles:true})));expect(tabs[0]!.getAttribute("aria-selected")).toBe("true");expect(document.activeElement).toBe(tabs[0]);
  await act(async()=>tabs[0]!.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true})));expect(node.querySelectorAll('[role="tab"]')).toHaveLength(1);
  await act(async()=>node.querySelector("aside")!.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true})));expect(node.querySelector("aside")).toBeNull();expect(document.activeElement).toBe(opener);expect(request).not.toHaveBeenCalled();
 }finally{act(()=>root.unmount());node.remove();}
});
