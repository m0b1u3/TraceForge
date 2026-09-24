import {useEffect, useRef, type RefObject} from "react";

/** Non-modal panels keep the conversation reachable; Escape only closes the focused panel. */
export function usePanelFocus(ref:RefObject<HTMLElement>,identity:string,onClose:()=>void){
  const close=useRef(onClose);close.current=onClose;
  useEffect(()=>{
    const panel=ref.current;if(!panel||!identity)return;
    const previous=document.activeElement;
    panel.focus({preventScroll:true});
    const key=(event:KeyboardEvent)=>{
      if(event.key!=="Escape"||event.defaultPrevented||event.isComposing)return;
      event.preventDefault();event.stopPropagation();close.current();
    };
    panel.addEventListener("keydown",key);
    return()=>{panel.removeEventListener("keydown",key);if(previous instanceof HTMLElement&&previous.isConnected)previous.focus({preventScroll:true});};
  },[ref,identity]);
}
