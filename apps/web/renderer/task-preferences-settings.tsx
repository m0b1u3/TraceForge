import React,{useEffect,useState} from "react";
import type { DesktopConversations } from "./desktop-conversation-transport";
import { TaskDefinitionsSchema,defaultTaskPreset,readTaskPreset,saveTaskPreset,taskField,type TaskDefinition,type TaskPreset } from "./task-preferences";
import "./task-confirmation.css";
import {readDefaultTaskKind,saveDefaultTask} from "./task-preferences";

export function TaskPreferencesSettings({bridge,onDirty}:{bridge:DesktopConversations;onDirty?:(dirty:boolean)=>void}) {
  const [definitions,setDefinitions]=useState<TaskDefinition[]>([]),[index,setIndex]=useState(0),[preset,setPreset]=useState<TaskPreset|null>(null);
  const [error,setError]=useState(""),[notice,setNotice]=useState(""),[dirty,setDirty]=useState(false);
  const definition=definitions[index];
  const [defaultKind,setDefaultKind]=useState("");
  useEffect(()=>{onDirty?.(dirty);},[dirty,onDirty]);
  function select(d:TaskDefinition){try{setPreset(readTaskPreset(d));setError("");}catch(cause){setPreset(defaultTaskPreset(d));setError((cause as Error).message);}setDirty(false);}
  async function load(){try{const r=await bridge.request({path:"/api/desktop/task-definitions",method:"GET"});if(r.status!==200)throw new Error("无法读取场景，请重试。");const ds=TaskDefinitionsSchema.parse(r.body);setDefinitions(ds);const kind=readDefaultTaskKind(ds);setDefaultKind(kind);const i=Math.max(0,ds.findIndex(d=>d.kind===kind));setIndex(i);if(ds[i])select(ds[i]);}catch(cause){setError((cause as Error).message);}}
  useEffect(()=>{void load();},[bridge]);
  function edit(next:TaskPreset){setPreset(next);setDirty(true);setNotice("");}
  return <section className="task-preferences"><h2>任务执行</h2><p>设置一次，后续新任务沿用。已有任务保持开始时的配置。</p>
    {definition&&<p>{defaultKind===definition.kind?"当前默认场景：":"配置场景："}{definition.title??definition.kind}。对话中只需描述任务，无需填写场景名称。{defaultKind!==definition.kind&&<button disabled={dirty} onClick={()=>{try{saveDefaultTask(definition);setDefaultKind(definition.kind);setNotice("已设为默认场景，新任务自动使用。");}catch(cause){setError((cause as Error).message);}}}>设为默认场景</button>}</p>}
    {definitions.length>1&&<label>场景<select value={index} disabled={dirty} onChange={e=>{const i=Number(e.target.value);setIndex(i);select(definitions[i]);}}>{definitions.map((d,i)=><option value={i} key={d.kind}>{d.title??d.kind}</option>)}</select></label>}
    {!definitions.length&&!error&&<p>没有可配置的已安装场景。</p>}
    {definition&&preset&&<><h3>允许的操作</h3><p>默认启用场景支持的全部工具。沙箱和危险操作确认保留。</p><p>{definition.authorizationForm.description}</p>
      <div className="task-settings-actions">{definition.authorizationReview.allowedActions.filter(a=>!definition.authorizationReview.deniedActions.includes(a)).map(a=><label key={a}><input type="checkbox" checked={preset.actions.includes(a)} onChange={e=>edit({...preset,actions:e.target.checked?[...preset.actions,a]:preset.actions.filter(v=>v!==a)})}/>{definition.authorizationForm.actionLabels?.[a]??a}</label>)}</div>
      <h3>执行与访问偏好</h3>{definition.authorizationForm.fields.map((f,i)=>taskField(f)?null:<label className="task-setting-field" key={f.path.join(".")}><span>{f.label}</span>{f.type==="boolean"?<input type="checkbox" checked={preset.inputs[i]==="true"} onChange={e=>edit({...preset,inputs:preset.inputs.map((v,n)=>n===i?String(e.target.checked):v)})}/>:f.type==="integer"?<input type="number" min={f.minimum} max={f.maximum} value={preset.inputs[i]} onChange={e=>edit({...preset,inputs:preset.inputs.map((v,n)=>n===i?e.target.value:v)})}/>:<textarea rows={2} value={preset.inputs[i]} onChange={e=>edit({...preset,inputs:preset.inputs.map((v,n)=>n===i?e.target.value:v)})}/>}<small>{f.description}</small></label>)}
      <div className="task-settings-footer"><button onClick={()=>edit(defaultTaskPreset(definition))}>恢复默认</button><button className="primary" disabled={!dirty} onClick={()=>{try{setPreset(saveTaskPreset(definition,preset));setDirty(false);setError("");setNotice("已保存，新任务将使用此配置。");}catch(cause){setError((cause as Error).message);}}}>保存设置</button></div></>}
    {notice&&<p role="status">{notice}</p>}{error&&<p role="alert">{error}<button onClick={()=>void load()}>重新读取</button></p>}
  </section>;
}
