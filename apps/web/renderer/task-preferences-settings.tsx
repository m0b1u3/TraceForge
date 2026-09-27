import React,{useEffect,useState} from "react";
import type { DesktopConversations } from "./desktop-conversation-transport";
import { TaskDefinitionsSchema,readDefaultTaskKind,saveDefaultTask,type TaskDefinition } from "./task-preferences";
import "./task-confirmation.css";

export function TaskPreferencesSettings({bridge,onDirty}:{bridge:DesktopConversations;onDirty?:(dirty:boolean)=>void}) {
  const [definitions,setDefinitions]=useState<TaskDefinition[]>([]);
  const [defaultKind,setDefaultKind]=useState("");
  const [error,setError]=useState(""),[notice,setNotice]=useState("");
  useEffect(()=>{onDirty?.(false);},[onDirty]);
  useEffect(()=>{
    let active=true;
    void bridge.request({path:"/api/desktop/task-definitions",method:"GET"}).then(response=>{
      if(response.status!==200)throw new Error("无法读取场景，请重试。");
      const available=TaskDefinitionsSchema.parse(response.body);
      if(!active)return;
      setDefinitions(available);
      try{setDefaultKind(readDefaultTaskKind(available)||available[0]?.kind||"");}
      catch{setDefaultKind(available[0]?.kind||"");}
      setError("");
    }).catch(()=>{if(active)setError("无法读取场景，请重试。");});
    return()=>{active=false;};
  },[bridge]);
  return <section className="task-preferences"><h2>任务执行</h2>
    <p>在对话中输入目标即可启动。智能体会直接使用已安装工具。</p>
    {definitions.length>1&&<label>默认场景<select value={defaultKind} onChange={event=>{
      const definition=definitions.find(item=>item.kind===event.target.value);
      if(!definition)return;
      try{saveDefaultTask(definition);setDefaultKind(definition.kind);setNotice("已设为默认场景。");setError("");}
      catch(cause){setError(cause instanceof Error?cause.message:"无法保存默认场景。");}
    }}>{definitions.map(item=><option value={item.kind} key={item.kind}>{item.title??item.kind}</option>)}</select></label>}
    {definitions.length===1&&<p>当前场景：{definitions[0]!.title??definitions[0]!.kind}</p>}
    {!definitions.length&&!error&&<p>没有已安装场景。</p>}
    {notice&&<p role="status">{notice}</p>}
    {error&&<p role="alert">{error}</p>}
  </section>;
}
