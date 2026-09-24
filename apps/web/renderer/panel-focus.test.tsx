// @vitest-environment jsdom
import React,{act,useRef} from "react";
import {createRoot} from "react-dom/client";
import {expect,it,vi} from "vitest";
import {usePanelFocus} from "./panel-focus";
import {SurfaceBoundary} from "./surface-boundary";

it("focuses a non-modal panel, closes only its own Escape, and restores the opener",async()=>{
 (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
 const opener=document.createElement("button"),node=document.createElement("div");document.body.append(opener,node);opener.focus();
 const close=vi.fn();function Panel(){const ref=useRef<HTMLElement>(null);usePanelFocus(ref,"panel",close);return <aside ref={ref} tabIndex={-1}><input/></aside>;}
 const root=createRoot(node);
 try{
  await act(async()=>root.render(<Panel/>));expect(document.activeElement).toBe(node.querySelector("aside"));
  window.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape"}));expect(close).not.toHaveBeenCalled();
  node.querySelector("input")!.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}));expect(close).toHaveBeenCalledOnce();
 }finally{act(()=>root.unmount());expect(document.activeElement).toBe(opener);opener.remove();node.remove();}
});

it("recovers a failed read surface without unmounting its sibling composer",async()=>{
 (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
 const quiet=vi.spyOn(console,"error").mockImplementation(()=>{});let failed=true;
 function Read(){if(failed)throw Error("synthetic");return <p>Saved content</p>;}
 const node=document.createElement("div"),root=createRoot(node);document.body.append(node);
 try{
  await act(async()=>root.render(<><textarea defaultValue="Unsent draft"/><SurfaceBoundary label="预览"><Read/></SurfaceBoundary></>));
  expect(node.querySelector('[role="alert"]')).not.toBeNull();const draft=node.querySelector("textarea");failed=false;
  await act(async()=>node.querySelector("button")!.click());expect(node.textContent).toContain("Saved content");expect(node.querySelector("textarea")).toBe(draft);expect(draft!.value).toBe("Unsent draft");
 }finally{act(()=>root.unmount());node.remove();quiet.mockRestore();}
});
