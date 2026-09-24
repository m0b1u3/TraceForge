import React, { useEffect, useRef, useState } from "react";
import type { DesktopConversations } from "./desktop-conversation-transport";
import "./configuration-settings.css";
import "./storage-settings.css";

// Operate: extend the existing white settings surface with three plain rows.
// Paths and measured usage precede actions; only HTTP cache is disposable.
type Snapshot = { root: string; logs: string; cache: string; channel: string; legacy: boolean;
  data: { bytes: number; complete: boolean }; logsUsage: { bytes: number; complete: boolean }; cacheBytes: number; diagnosticsAvailable: boolean };
const bytes = (value: number) => value < 1048576 ? `${(value / 1024).toFixed(1)} KB` : `${(value / 1048576).toFixed(1)} MB`;
export function StorageSettings({ bridge }: { bridge: DesktopConversations }) {
  const [snapshot, setSnapshot] = useState<Snapshot>(), [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const locked = useRef(false), alive = useRef(true);
  async function action(operation: "inspect" | "open-data" | "open-logs" | "clear-cache") {
    if (!bridge.storage || locked.current) return;
    locked.current = true; setBusy(true); setError(""); setNotice("");
    try {
      const result = await bridge.storage(operation);
      if (!alive.current) return;
      if (operation === "inspect") setSnapshot(result as Snapshot);
      else if (operation === "clear-cache") {
        setNotice("缓存已清理。对话、证据、工作文件和登录状态均已保留。");
        try {
          const fresh = await bridge.storage("inspect");
          if (alive.current) setSnapshot(fresh as Snapshot);
        } catch { if (alive.current) setError("缓存已清理，但用量未能刷新。下方仍是上次读取结果，请重新读取用量。"); }
      } else setNotice("已打开文件夹。");
    } catch { if (alive.current) setError(operation === "clear-cache" ? "未能确认缓存清理结果。请重新读取用量后再试。" : "无法完成操作，请重试。已有数据不会因此删除。"); }
    finally { locked.current = false; if (alive.current) setBusy(false); }
  }
  useEffect(() => { alive.current = true; void action("inspect"); return () => { alive.current = false; }; }, [bridge]);
  return <section className="configuration-settings storage-settings" aria-label="本地数据与日志" aria-busy={busy}>
    <h2>本地数据与日志</h2><p>数据保存在当前电脑。清理缓存不会删除调查记录或退出模型登录。</p>
    {!bridge.storage ? <p>请在 TraceForge 桌面应用中管理本地存储。</p> : <>
      <button disabled={busy} onClick={() => void action("inspect")}>{busy ? "正在处理…" : "重新读取用量"}</button>
      {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
      {!snapshot && !error && <p role="status">正在读取本地用量…</p>}
      {snapshot && <>
        <p className="storage-environment">{snapshot.channel === "production" ? "正式环境" : snapshot.channel === "development" ? "开发环境，与正式数据隔离" : "隔离测试环境"}{snapshot.legacy ? " · 继续使用原有数据目录，未搬移文件" : ""}</p>
        <div className="storage-row"><div><h3>应用数据</h3><p>模型配置、加密凭据、对话、证据和工作文件。</p><code>{snapshot.root}</code><p>{bytes(snapshot.data.bytes)}{!snapshot.data.complete && " · 部分目录未计入"}</p></div><button disabled={busy} onClick={() => void action("open-data")}>打开数据目录</button></div>
        <div className="storage-row"><div><h3>诊断日志</h3><p>记录运行状态，自动轮换；不记录密钥或对话正文。执行回执另存于应用数据。</p><code>{snapshot.logs}</code><p>{bytes(snapshot.logsUsage.bytes)}{!snapshot.logsUsage.complete && " · 部分目录未计入"}{!snapshot.diagnosticsAvailable && " · 日志暂时无法写入，任务不因此停止"}</p></div><button disabled={busy} onClick={() => void action("open-logs")}>打开日志目录</button></div>
        <div className="storage-row"><div><h3>界面缓存</h3><p>仅清除应用界面的 HTTP 缓存，不清 Cookie，也不操作任务浏览器。</p><code>{snapshot.cache}</code><p>{bytes(snapshot.cacheBytes)} · 当前会话的 HTTP 缓存</p></div><button disabled={busy} onClick={() => void action("clear-cache")}>清理界面缓存</button></div>
      </>}
    </>}
  </section>;
}
