import React, { useEffect, useRef, useState } from "react";
import { ModelSettings } from "./model-settings";
import type { ModelSettingsBridge } from "./model-settings-client";
import type { DesktopConversations } from "./desktop-conversation-transport";
import { ConfigurationSettings } from "./configuration-settings";
import { McpSettings } from "./mcp-settings";
import { ResourceSettings } from "./resource-settings";
import { StorageSettings } from "./storage-settings";
import { TaskPreferencesSettings } from "./task-preferences-settings";

export function WorkbenchSettings({ bridge, modelBridge, onDirty }: { bridge: DesktopConversations; modelBridge?: ModelSettingsBridge; onDirty?: (dirty: boolean) => void }) {
  const [page, setPage] = useState<"model" | "configuration" | "mcp" | "resources" | "storage" | "tasks">("model");
  const [tasksOpened,setTasksOpened]=useState(false),[tasksDirty,setTasksDirty]=useState(false);
  const [resourcesOpened,setResourcesOpened] = useState(false), [resourcesDirty,setResourcesDirty] = useState(false);
  const [opened, setOpened] = useState(false);
  const [modelDirty,setModelDirty]=useState(false);
  const content=useRef<HTMLDivElement>(null),previousPage=useRef(page);
  const [mcpOpened,setMcpOpened] = useState(false),[configurationDirty,setConfigurationDirty]=useState(false),[mcpDirty,setMcpDirty]=useState(false);
  useEffect(()=>{onDirty?.(configurationDirty||mcpDirty||modelDirty||resourcesDirty||tasksDirty);},[configurationDirty,mcpDirty,modelDirty,resourcesDirty,tasksDirty,onDirty]);
  useEffect(()=>{
    if(previousPage.current===page)return;previousPage.current=page;
    const heading=content.current?.querySelector<HTMLElement>(':scope > :not([hidden]) h2');
    if(heading){heading.tabIndex=-1;heading.focus({preventScroll:true});}
    const scroll=content.current?.closest('.conversation-scroll');if(scroll)scroll.scrollTop=0;
  },[page]);
  return <div className="settings-layout">
    <nav className="settings-sections" aria-label="设置分类">
      <button aria-current={page === "tasks" ? "page" : undefined} data-dirty={tasksDirty||undefined} onClick={()=>{setTasksOpened(true);setPage("tasks");}}>任务执行</button>
      <button data-dirty={modelDirty||undefined} aria-description={modelDirty?"有未保存内容或正在处理的操作":undefined} aria-current={page === "model" ? "page" : undefined} onClick={() => setPage("model")}>模型连接</button>
      <button aria-current={page === "configuration" ? "page" : undefined} onClick={() => { setOpened(true); setPage("configuration"); }}>场景与扩展</button>
      <button aria-current={page === "mcp" ? "page" : undefined} onClick={() => {setMcpOpened(true);setPage("mcp");}}>MCP 连接</button>
      <button aria-current={page === "resources" ? "page" : undefined} onClick={() => {setResourcesOpened(true);setPage("resources");}}>工具与资料</button>
      <button aria-current={page === "storage" ? "page" : undefined} onClick={() => setPage("storage")}>数据与日志</button>
    </nav>
    <div className="settings-content" ref={content}>
    {tasksOpened&&<div hidden={page!=="tasks"}><TaskPreferencesSettings bridge={bridge} onDirty={setTasksDirty}/></div>}
    {(configurationDirty||mcpDirty||modelDirty||resourcesDirty)&&<p className="settings-draft-status" role="status">有未保存内容或正在处理的操作：{[modelDirty&&"模型连接",configurationDirty&&"场景与扩展",mcpDirty&&"MCP 连接",resourcesDirty&&"工具与资料"].filter(Boolean).join("、")}。切换分类会保留当前内容。</p>}
    {page === "storage" && <StorageSettings bridge={bridge} />}
    <div hidden={page !== "model"}><ModelSettings bridge={modelBridge} onDirty={setModelDirty} /></div>
    {opened && <div hidden={page !== "configuration"}><ConfigurationSettings bridge={bridge} onDirty={setConfigurationDirty} /></div>}
    {mcpOpened && <div hidden={page !== "mcp"}><McpSettings bridge={bridge} onDirty={setMcpDirty}/></div>}
    {resourcesOpened && <div hidden={page !== "resources"}><ResourceSettings bridge={bridge} onDirty={setResourcesDirty}/></div>}
    </div>
  </div>;
}
