import React, { useEffect, useState } from "react";
import { ModelSettings } from "./model-settings";
import type { ModelSettingsBridge } from "./model-settings-client";
import type { DesktopConversations } from "./desktop-conversation-transport";
import { ConfigurationSettings } from "./configuration-settings";
import { McpSettings } from "./mcp-settings";
import { ResourceSettings } from "./resource-settings";

export function WorkbenchSettings({ bridge, modelBridge, onDirty }: { bridge: DesktopConversations; modelBridge?: ModelSettingsBridge; onDirty?: (dirty: boolean) => void }) {
  const [page, setPage] = useState<"model" | "configuration" | "mcp" | "resources">("model");
  const [resourcesOpened,setResourcesOpened] = useState(false), [resourcesDirty,setResourcesDirty] = useState(false);
  const [opened, setOpened] = useState(false);
  const [modelDirty,setModelDirty]=useState(false);
  const [mcpOpened,setMcpOpened] = useState(false),[configurationDirty,setConfigurationDirty]=useState(false),[mcpDirty,setMcpDirty]=useState(false);
  useEffect(()=>{onDirty?.(configurationDirty||mcpDirty||modelDirty||resourcesDirty);},[configurationDirty,mcpDirty,modelDirty,resourcesDirty,onDirty]);
  return <>
    <nav className="settings-sections" aria-label="设置分类">
      <button aria-current={page === "model" ? "page" : undefined} onClick={() => setPage("model")}>模型连接</button>
      <button aria-current={page === "configuration" ? "page" : undefined} onClick={() => { setOpened(true); setPage("configuration"); }}>场景与扩展</button>
      <button aria-current={page === "mcp" ? "page" : undefined} onClick={() => {setMcpOpened(true);setPage("mcp");}}>MCP 连接</button>
      <button aria-current={page === "resources" ? "page" : undefined} onClick={() => {setResourcesOpened(true);setPage("resources");}}>工具与资料</button>
    </nav>
    <div hidden={page !== "model"}><ModelSettings bridge={modelBridge} onDirty={setModelDirty} /></div>
    {opened && <div hidden={page !== "configuration"}><ConfigurationSettings bridge={bridge} onDirty={setConfigurationDirty} /></div>}
    {mcpOpened && <div hidden={page !== "mcp"}><McpSettings bridge={bridge} onDirty={setMcpDirty}/></div>}
    {resourcesOpened && <div hidden={page !== "resources"}><ResourceSettings bridge={bridge} onDirty={setResourcesDirty}/></div>}
  </>;
}
