import React,{Suspense,lazy,createContext,useContext,useEffect,useRef,useState} from "react";
import {X} from "@phosphor-icons/react";
import {AttachmentPreviewSchema} from "@traceforge/shared/message-attachments";
import type {DesktopConversations} from "./desktop-conversation-transport";
import {EvidenceReference} from "./evidence-reference";
const PdfPreview=lazy(()=>import("./pdf-preview").then(module=>({default:module.PdfPreview})));
class PreviewBoundary extends React.Component<{children:React.ReactNode},{failed:boolean}>{
  state={failed:false};
  static getDerivedStateFromError(){return {failed:true};}
  render(){return this.state.failed?<p role="alert">预览组件无法载入。对话仍可使用；请重新打开应用后重试预览。</p>:this.props.children;}
}
export type PreviewTarget={conversationId:string;title:string}&({kind:"evidence";runId:string;reference:string}|{kind:"attachment";messageId:string;index:number}|{kind:"text";sourceId:string;text:string});
const identity=(target:PreviewTarget)=>JSON.stringify(target.kind==="text"?[target.conversationId,"text",target.sourceId]:target.kind==="evidence"?[target.conversationId,target.runId,target.reference]:[target.conversationId,target.messageId,target.index]);
const Context=createContext<{open(target:PreviewTarget):void;tabs:PreviewTarget[];selected:string;select(id:string):void;close(id:string):void}|null>(null);
export function useArtifactPreview(){return useContext(Context);}
export function ArtifactPreviewProvider({children}:{children:React.ReactNode}){
  const [tabs,setTabs]=useState<PreviewTarget[]>([]),[selected,select]=useState("");
  const open=(target:PreviewTarget)=>{setTabs(old=>old.some(t=>identity(t)===identity(target))?old:[...old.slice(-7),target]);select(identity(target));};
  return <Context.Provider value={{tabs,selected,select,open,close:id=>{setTabs(old=>old.filter(t=>identity(t)!==id));select("");}}}>{children}</Context.Provider>;
}
function AttachmentContent({bridge,target}:{bridge:DesktopConversations;target:Extract<PreviewTarget,{kind:"attachment"}>}){
  const [value,setValue]=useState<ReturnType<typeof AttachmentPreviewSchema.parse>>(),[page,setPage]=useState(1),[offset,setOffset]=useState(0),[retry,setRetry]=useState(0),[busy,setBusy]=useState(true),[error,setError]=useState("");
  const digest=useRef<string>();
  useEffect(()=>{let active=true;setBusy(true);setError("");
    void bridge.request({path:`/api/desktop/conversations/${target.conversationId}/attachments/preview`,method:"POST",body:JSON.stringify({messageId:target.messageId,index:target.index,...(page>1?{page}:{}),...(offset?{offset}:{}),...(digest.current?{expectedDigest:digest.current}:{})})}).then(r=>{
      if(!active)return;if(r.status!==200)throw Error(r.status===404?"附件不存在或不属于当前会话。":r.status===415?"此附件类型暂不支持预览。":"附件无法读取、已变化或超过预览限制。");
      const next=AttachmentPreviewSchema.parse(r.body);if(next.conversationId!==target.conversationId||next.messageId!==target.messageId||next.index!==target.index||digest.current&&digest.current!==next.digest)throw Error("预览来源发生变化。");
      digest.current=next.digest;setValue(next);
    }).catch(e=>{if(active)setError(e instanceof Error?e.message:"预览失败。");}).finally(()=>{if(active)setBusy(false);});
    return()=>{active=false;};
  },[bridge,target,page,offset,retry]);
  return <section aria-label="附件预览内容"><p className="local-receipt">只读本地内容 · 不执行文档脚本</p>{busy&&<p role="status">正在读取…</p>}{!busy&&!error&&value&&<>
    {value.kind==="text"?<pre className="artifact-text" tabIndex={0}>{value.text}</pre>:value.kind==="image"?<img alt={value.name} src={`data:${value.mediaType};base64,${value.data}`} onError={()=>setError("图片无法解码。")}/>:<PreviewBoundary><Suspense fallback={<p role="status">正在载入 PDF 预览…</p>}><PdfPreview data={value.data!}/></Suspense></PreviewBoundary>}
    {value.kind==="pdf"&&<div className="preview-pagination"><button disabled={page===1} onClick={()=>setPage(p=>p-1)}>上一页</button><span>第 {page} / {value.pages??"未知"} 页</span><button disabled={!value.pages||page>=value.pages} onClick={()=>setPage(p=>p+1)}>下一页</button></div>}
    {value.kind==="text"&&<div className="preview-pagination"><button disabled={!offset} onClick={()=>setOffset(0)}>返回开头</button><span>位置 {offset}</span><button disabled={value.nextOffset==null} onClick={()=>setOffset(value.nextOffset!)}>下一段</button></div>}
  </>}{error&&<p role="alert">{error}<button onClick={()=>setRetry(n=>n+1)}>重新读取</button></p>}</section>;
}
export function ArtifactPreviewPanel({bridge,conversationId}:{bridge:DesktopConversations;conversationId:string}){
  const context=useArtifactPreview();if(!context)return null;
  const tabs=context.tabs.filter(t=>t.conversationId===conversationId),target=tabs.find(t=>identity(t)===context.selected)??tabs.at(-1);
  if(!target)return null;
  return <aside className="artifact-preview" aria-label="产物预览"><header><strong>产物预览</strong><button aria-label="关闭当前预览" onClick={()=>context.close(identity(target))}><X aria-hidden="true"/></button></header>
    <div className="preview-tabs" role="tablist" aria-label="已打开产物">{tabs.map(t=><button role="tab" aria-selected={t===target} key={identity(t)} onClick={()=>context.select(identity(t))}>{t.title}</button>)}</div>
    <div className="preview-body" key={identity(target)}>{target.kind==="text"?<section><p className="local-receipt">已保存的工具输出快照 · 只读；截断部分请查原始回执</p><pre className="artifact-text" tabIndex={0}>{target.text}</pre></section>:target.kind==="evidence"?<EvidenceReference bridge={bridge} conversationId={conversationId} runId={target.runId} reference={target.reference} embedded/>:<AttachmentContent bridge={bridge} target={target}/>}</div>
  </aside>;
}
