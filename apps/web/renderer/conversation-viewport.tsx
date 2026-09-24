import React,{useEffect,useRef,useState} from "react";
import {ArrowDown} from "@phosphor-icons/react";

/** Follow new content only while the reader is already at the end. */
export function ConversationViewport({identity,follow,children}:{identity:string;follow:boolean;children:React.ReactNode}){
  const viewport=useRef<HTMLDivElement>(null),content=useRef<HTMLDivElement>(null),atEnd=useRef(true);
  const positions=useRef(new Map<string,{top:number;atEnd:boolean}>());
  const [away,setAway]=useState(false);
  useEffect(()=>{
    const element=viewport.current,body=content.current;if(!element||!body)return;
    const saved=positions.current.get(identity);atEnd.current=saved?.atEnd??true;setAway(!atEnd.current);element.scrollTop=saved&&!saved.atEnd?saved.top:follow?element.scrollHeight:0;
    let frame:number|undefined;
    const update=()=>{if(!follow||!atEnd.current||frame!==undefined)return;
      frame=requestAnimationFrame(()=>{frame=undefined;if(atEnd.current)element.scrollTop=element.scrollHeight;});};
    const changes=new MutationObserver(update);changes.observe(body,{childList:true,subtree:true,characterData:true});
    const size=typeof ResizeObserver!=="undefined"?new ResizeObserver(update):null;size?.observe(body);
    return()=>{positions.current.set(identity,{top:element.scrollTop,atEnd:atEnd.current});if(positions.current.size>50)positions.current.delete(positions.current.keys().next().value!);changes.disconnect();size?.disconnect();if(frame!==undefined)cancelAnimationFrame(frame);};
  },[identity,follow]);
  return <div className="conversation-viewport">
    <div ref={viewport} className="conversation-scroll" onScroll={event=>{const element=event.currentTarget;atEnd.current=element.scrollHeight-element.scrollTop-element.clientHeight<100;setAway(!atEnd.current);}}>
      <div ref={content} className="transcript">{children}</div>
    </div>
    {follow&&away&&<button className="return-latest" onClick={()=>{atEnd.current=true;setAway(false);if(viewport.current)viewport.current.scrollTop=viewport.current.scrollHeight;}}><ArrowDown aria-hidden="true"/>回到最新内容</button>}
  </div>;
}
