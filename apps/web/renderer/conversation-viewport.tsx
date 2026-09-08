import React,{useEffect,useRef,useState} from "react";
import {ArrowDown} from "@phosphor-icons/react";

/** Follow new content only while the reader is already at the end. */
export function ConversationViewport({identity,follow,children}:{identity:string;follow:boolean;children:React.ReactNode}){
  const viewport=useRef<HTMLDivElement>(null),content=useRef<HTMLDivElement>(null),atEnd=useRef(true);
  const [away,setAway]=useState(false);
  useEffect(()=>{
    const element=viewport.current,body=content.current;if(!element||!body)return;
    atEnd.current=true;setAway(false);element.scrollTop=follow?element.scrollHeight:0;
    const update=()=>{if(follow&&atEnd.current)element.scrollTop=element.scrollHeight;};
    const changes=new MutationObserver(update);changes.observe(body,{childList:true,subtree:true,characterData:true});
    const size=typeof ResizeObserver!=="undefined"?new ResizeObserver(update):null;size?.observe(body);
    return()=>{changes.disconnect();size?.disconnect();};
  },[identity,follow]);
  return <div className="conversation-viewport">
    <div ref={viewport} className="conversation-scroll" onScroll={event=>{const element=event.currentTarget;atEnd.current=element.scrollHeight-element.scrollTop-element.clientHeight<100;setAway(!atEnd.current);}}>
      <div ref={content} className="transcript">{children}</div>
    </div>
    {follow&&away&&<button className="return-latest" onClick={()=>{atEnd.current=true;setAway(false);if(viewport.current)viewport.current.scrollTop=viewport.current.scrollHeight;}}><ArrowDown aria-hidden="true"/>回到最新内容</button>}
  </div>;
}
