// @vitest-environment jsdom
import {afterEach,expect,it,vi} from "vitest";
import React,{act} from "react";
import {createRoot} from "react-dom/client";
import {TaskDefinitionSchema,defaultTaskPreset,readTaskPreset,saveTaskPreset,taskScope,taskInputs} from "./task-preferences";
import {TaskPreferencesSettings} from "./task-preferences-settings";
import blackbox from "../../../scenarios/web-blackbox/scenario.json";
import {readDefaultTaskKind,saveDefaultTask} from "./task-preferences";
const definition=TaskDefinitionSchema.parse({kind:"neutral",version:1,title:"Neutral task",authorizationForm:{version:1,description:"Resources",fields:[{path:["targets"],label:"目标",description:"Literal target",type:"string-list",required:true},{path:["network"],label:"联网范围",description:"Literal prefix",type:"string-list",required:false,advanced:true},{path:["autonomy"],label:"连续执行",description:"Explicit opt in",type:"boolean",required:false}]},authorizationReview:{actionSelection:true,allowedActions:["read","write","denied"],deniedActions:["denied"],resources:[]}});
let dispose:(()=>void)|undefined;
afterEach(()=>{act(()=>dispose?.());document.body.replaceChildren();localStorage.clear();});
async function mount(element:React.ReactElement){(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;const node=document.createElement("div");document.body.append(node);const root=createRoot(node);dispose=()=>root.unmount();await act(async()=>root.render(element));return node;}
async function click(label:string){await act(async()=>[...document.querySelectorAll("button")].find(b=>b.textContent===label)!.click());}
it("defaults all supported actions on but does not infer autonomous or external scope grants",()=>{const p=readTaskPreset(definition);expect(p.actions).toEqual(["read","write"]);expect(p.inputs).toEqual(["","","false"]);});
it("persists one selected default independently of per-task settings",()=>{
  const other={...definition,kind:"second",title:"Second"};
  expect(readDefaultTaskKind([definition])).toBe("neutral");
  expect(readDefaultTaskKind([definition,other])).toBe("");
  saveDefaultTask(other);expect(readDefaultTaskKind([definition,other])).toBe("second");
  saveTaskPreset(other,readTaskPreset(other));expect(readDefaultTaskKind([definition,other])).toBe("second");
  saveDefaultTask(definition);expect(readDefaultTaskKind([definition,other])).toBe("neutral");
});
it("starts the shipped black-box task from its message without any target or networking form",async()=>{
  const d=TaskDefinitionSchema.parse({...blackbox.definition,authorizationForm:blackbox.authorizationPolicy.form,authorizationReview:{actionSelection:true,allowedActions:blackbox.authorizationPolicy.allowedActions,deniedActions:[],resources:blackbox.authorizationPolicy.resources}});
  const preset=defaultTaskPreset(d),scope=taskScope(d,preset);
  expect(scope).toMatchObject({asynchronousWorkspace:true,interactiveWorkspace:true,workspaceWebSocket:true,continuousExecution:true});
  expect(preset.actions).toEqual(blackbox.authorizationPolicy.allowedActions);
  expect(scope).not.toHaveProperty("targets");expect(scope).not.toHaveProperty("workspaceNetworkPrefixes");
});
it("persists preferences, snapshots the scope and refuses a changed contract",()=>{const p=defaultTaskPreset(definition);p.inputs[1]="https://docs.example/";p.inputs[2]="true";saveTaskPreset(definition,p);const read=readTaskPreset(definition);const scope=taskScope(definition,read,["target",...read.inputs.slice(1)]);saveTaskPreset(definition,{...read,inputs:["","","false"]});expect(scope).toEqual({targets:["target"],network:["https://docs.example/"],autonomy:true,authorizedActions:["read","write"]});expect(()=>readTaskPreset({...definition,version:2})).toThrow("场景配置已变化");});
it("refuses corrupted saved preferences instead of silently expanding permissions",()=>{localStorage.setItem("traceforge.desktop.task-preferences.v1","{}");expect(()=>readTaskPreset(definition)).toThrow();});
it("only suggests literal URLs when the Scenario declares that presentation hint",()=>{
  const hinted=TaskDefinitionSchema.parse({...definition,authorizationForm:{...definition.authorizationForm,fields:definition.authorizationForm.fields.map((f,i)=>i===0?{...f,suggestion:"message-urls"}:f)}});
  const message="查看 https://example.test/path?q=1 ，不要扩大范围";
  expect(taskInputs(definition,defaultTaskPreset(definition),message)[0]).toBe("");
  expect(taskInputs(hinted,defaultTaskPreset(hinted),message)[0]).toBe("https://example.test/path?q=1");
});
it("cancel never authorizes; save in settings never sends an execution request",async()=>{const request=vi.fn(async()=>({status:200,body:[definition]}));await mount(<TaskPreferencesSettings bridge={{protocolVersion:1,request}}/>);expect(document.querySelectorAll('input[type="checkbox"]')).toHaveLength(3);await act(async()=>document.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());await click("保存设置");expect(readTaskPreset(definition).actions).toEqual(["write"]);expect(request.mock.calls).toHaveLength(1);expect(document.body.textContent).toContain("已保存");});
