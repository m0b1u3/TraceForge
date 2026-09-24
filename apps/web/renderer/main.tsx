import React from "react";
import { createRoot } from "react-dom/client";
import { HostWorkbench } from "./host-workbench";
import type { DesktopConversations } from "./desktop-conversation-transport";
import type { ModelSettingsBridge } from "./model-settings-client";
import { ModelSettings } from "./model-settings";
import "./workbench.css";

const desktop = (window as Window & { traceforgeDesktop?: { mode?: string; conversations?: DesktopConversations; modelSettings?: ModelSettingsBridge } }).traceforgeDesktop;
createRoot(document.getElementById("root")!).render(<React.StrictMode>{desktop?.mode === "model-settings" ? <main className="settings-only"><header><span className="brand">TraceForge</span><span className="status">模型设置 · 不启动调查</span></header><ModelSettings bridge={desktop.modelSettings} /></main> : desktop?.conversations ? <HostWorkbench bridge={desktop.conversations} modelBridge={desktop.modelSettings} /> : <main className="host-unavailable" role="alert"><h1>桌面连接未就绪</h1><p>请从 TraceForge 桌面应用打开工作台。当前页面没有任务、模型或本机数据连接。</p></main>}</React.StrictMode>);
