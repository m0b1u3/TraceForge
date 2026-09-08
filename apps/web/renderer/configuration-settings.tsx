import React, { useEffect, useRef, useState } from "react";
import type { ConfigurationSnapshot, ConfigurationSave, ConfigurationImportPreview } from "@traceforge/shared/desktop-configuration";
import type { DesktopConversations } from "./desktop-conversation-transport";
import "./configuration-settings.css";
import { UserResources } from "./user-resources";

// Extend the established white desktop settings surface. Resource list → text editor → explicit save.
// User content is plain text; package defaults, authority and tool contracts are never edited here.
export function ConfigurationSettings({ bridge, onDirty }: { bridge: DesktopConversations; onDirty?: (dirty: boolean) => void }) {
  const [snapshot, setSnapshot] = useState<ConfigurationSnapshot | null>(null);
  const [selected, setSelected] = useState(0);
  const [resourceId, setResourceId] = useState("");
  const [draft, setDraft] = useState<ConfigurationSave | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [status, setStatus] = useState("");
  const [dirty, setDirty] = useState(false), [reloadConfirm, setReloadConfirm] = useState(false);
  const [restoreConfirm, setRestoreConfirm] = useState(false);
  const [importing, setImporting] = useState(false);
  const [pendingImport, setPendingImport] = useState(false);
  const [versionPreview,setVersionPreview]=useState<ConfigurationImportPreview|null>(null);
  const alive = useRef(true), locked = useRef(false);
  const current = snapshot?.packages[selected];
  const resource = current?.resources.find(r => r.id === resourceId);
  const override = draft?.resources.find(r => r.id === resourceId);
  function select(value: ConfigurationSnapshot, index: number, preserveResource = false) {
    const i = Math.min(index, Math.max(0, value.packages.length - 1)), pkg = value.packages[i];
    setSnapshot(value); setSelected(i); setResourceId(preserveResource && pkg?.resources.some(r => r.id === resourceId) ? resourceId : pkg?.resources[0]?.id ?? "");
    setDraft(pkg ? { package: pkg.package, expectedRevision: pkg.revision,
      resources: pkg.resources.filter(r => r.editable).map(r => ({ id: r.id, enabled: r.enabled, content: r.content })),
      userResources: pkg.userResources ?? [],
      mcp: pkg.mcp.map(m => ({ source: m.source, profileDigest: m.profileDigest, enabled: m.enabled, tools: m.tools.filter(t => t.enabled).map(t => t.name) })) } : null);
    setDirty(false); setRestoreConfirm(false); setReloadConfirm(false);setVersionPreview(null);
  }
  async function request(body?: ConfigurationSave) {
    const reply = await bridge.request({ path: "/api/desktop/configuration", method: body ? "POST" : "GET", ...(body ? { body: JSON.stringify(body) } : {}) });
    if (reply.status < 200 || reply.status >= 300) throw new Error((reply.body as { error?: string })?.error ?? "配置读取失败，请重新读取。");
    const value = reply.body as ConfigurationSnapshot;
    if (!value || !Array.isArray(value.packages)) throw new Error("宿主返回了无效配置，请重新读取。");
    return value;
  }
  async function perform(save = false) {
    if (locked.current || importing || pendingImport) return;
    locked.current = true; setBusy(true); setError(""); setStatus("");
    try {
      const value = await request(save && draft ? draft : undefined);
      if (alive.current) { select(value, selected, true); setStatus(save ? "已保存。新任务使用这一版配置，已有任务保持原配置。" : "已读取宿主配置。"); }
    } catch (cause) { if (alive.current) setError(`${(cause as Error).message} ${save ? "草稿仍保留；保存结果不确定时请重新读取核对。" : dirty ? "读取失败，未覆盖当前草稿。" : "请重新读取配置。"}`); }
    finally { locked.current = false; if (alive.current) setBusy(false); }
  }
  async function previewVersion(from:ConfigurationSave["package"]) {
    if(locked.current||dirty||importing||pendingImport||!current)return;locked.current=true;setBusy(true);setError("");
    try{const reply=await bridge.request({path:"/api/desktop/configuration/import",method:"POST",body:JSON.stringify({package:current.package,expectedRevision:current.revision,from})});
      if(reply.status!==200)throw new Error("旧版本导入预览失败，请重新读取。");if(alive.current)setVersionPreview(reply.body as ConfigurationImportPreview);
    }catch(cause){if(alive.current)setError((cause as Error).message);}finally{locked.current=false;if(alive.current)setBusy(false);}
  }
  useEffect(() => { alive.current = true; void perform(); return () => { alive.current = false; }; }, []);
  useEffect(() => { onDirty?.(dirty || busy || importing || pendingImport || !!versionPreview); }, [dirty, busy, importing, pendingImport, versionPreview, onDirty]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn); return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  function changeResource(patch: Partial<ConfigurationSave["resources"][number]>) {
    setVersionPreview(null);
    setDraft(d => d ? { ...d, resources: d.resources.map(r => r.id === resourceId ? { ...r, ...patch } : r) } : d);
    setDirty(true); setStatus(""); setRestoreConfirm(false);
  }
  return <section className="configuration-settings" aria-label="场景与扩展设置">
    <header><h2>场景与扩展</h2><p>调整调查指导与可用工具，不修改场景包。</p></header>
    <div className="configuration-toolbar">
      <label>场景<select value={selected} disabled={busy || importing || pendingImport || dirty || !snapshot?.packages.length} onChange={e => { if (snapshot) select(snapshot, Number(e.target.value)); }}>
        {snapshot?.packages.map((pkg, i) => <option key={`${pkg.package.id}@${pkg.package.version}`} value={i}>{pkg.title} · {pkg.package.version}</option>)}
      </select></label>
      <button type="button" disabled={busy || importing || pendingImport} onClick={() => dirty ? setReloadConfirm(true) : void perform()}>重新读取</button>
      <button className="primary" type="button" disabled={busy || importing || pendingImport || !dirty} onClick={() => void perform(true)}>{busy ? "正在处理…" : "保存配置"}</button>
    </div>
    {reloadConfirm && <div role="group" aria-label="丢弃草稿确认"><p>重新读取会丢弃尚未保存的修改。</p><button disabled={busy || importing || pendingImport} onClick={() => void perform()}>丢弃并读取</button><button onClick={() => setReloadConfirm(false)}>保留草稿</button></div>}
    {error && <p role="alert">{error}</p>}{status && <p role="status">{status}</p>}
    {!snapshot && !error && <p role="status">正在读取配置…</p>}
    {snapshot && !current && <p>还没有可用的已安装场景。安装并审核场景后，其指导资源会显示在这里。</p>}
    {current && draft && <>
      <p className="configuration-meta">修订 {current.revision} · {dirty ? "有未保存的修改" : "与宿主一致"}。修改在新任务中生效。</p>
      {!!current.previousVersions?.length&&<details><summary>从旧版本保留自定义配置</summary><p>旧版本配置不会删除。先预览不兼容项，再替换当前草稿；保存后才生效。</p>
        {current.previousVersions.map(p=><button key={p.package.version} disabled={busy||dirty||importing||pendingImport||!!versionPreview} onClick={()=>void previewVersion(p.package)}>预览 {p.package.version} · 修订 {p.revision}</button>)}
      </details>}
      {versionPreview&&<div role="group" aria-label="版本配置导入确认"><p>将用旧版本的兼容项替换当前资源草稿。新版本默认内容可能已变化，请在保存前逐项核对。</p>{versionPreview.conflicts.map((text,i)=><p key={i}>{text}</p>)}
        <button disabled={busy||importing||pendingImport} onClick={()=>{setDraft(versionPreview.draft);setDirty(true);setVersionPreview(null);setStatus("已导入草稿，请核对后保存。");}}>确认导入兼容项</button><button onClick={()=>setVersionPreview(null)}>取消导入版本</button></div>}
      <h3>提示词与 Skills</h3>
      <div className="configuration-editor">
        <nav aria-label="场景资源">{current.resources.map(r => <button key={r.id} type="button" aria-current={resourceId === r.id ? "true" : undefined} onClick={() => { setResourceId(r.id); setRestoreConfirm(false); }}>
          <span>{r.id}</span><small>{r.type === "skill" ? "Skill / 场景指导" : "知识资源"}</small>
        </button>)}</nav>
        {resource ? <div className="configuration-document">
          <p>{resource.summary}</p><p className="configuration-meta">角色：{resource.roles.join("、")} · 阶段：{resource.phases.join("、") || "不限阶段"}</p>
          {resource.editable && override ? <>
            <label className="configuration-check"><input type="checkbox" checked={override.enabled} disabled={busy || importing || pendingImport} onChange={e => changeResource({ enabled: e.target.checked })} />为新任务启用此资源</label>
            <label>指导内容<textarea aria-label="指导内容" rows={16} value={override.content ?? resource.defaultContent} disabled={busy || importing || pendingImport} maxLength={65536} onChange={e => changeResource({ content: e.target.value })} /></label>
            <div className="configuration-actions"><span>{override.content === null ? "使用场景默认内容" : "使用用户修改内容"}</span><button disabled={busy || importing || pendingImport || override.content === null} onClick={() => setRestoreConfirm(true)}>恢复默认内容</button></div>
            {restoreConfirm && <div role="group" aria-label="恢复默认确认"><p>将移除此资源的自定义正文，保存后生效。</p><button disabled={busy || importing || pendingImport} onClick={() => changeResource({ content: null })}>确认恢复</button><button onClick={() => setRestoreConfirm(false)}>保留修改</button></div>}
            <details><summary>查看包内默认内容</summary><pre tabIndex={0} aria-label="包内默认正文">{resource.defaultContent}</pre></details>
          </> : <p>{resource.reason}</p>}
        </div> : <p>此场景未声明指导资源。</p>}
      </div>
      <UserResources key={`${current.package.id}@${current.package.version}`} resources={draft.userResources ?? []} parents={current.resources} busy={busy || importing} onBusy={setImporting} onPending={setPendingImport}
        onChange={userResources => { setVersionPreview(null); setDraft(d => d ? { ...d, userResources } : d); setDirty(true); setStatus(""); }} />
      <h3>MCP 工具</h3><p>管理宿主已审核连接的使用范围。此处不创建新连接，也不启动进程。</p>
      {!current.mcp.length && <p>当前场景没有已审核的 MCP 连接。</p>}
      {current.mcp.map(m => {
        const choice = draft.mcp.find(c => c.source === m.source)!;
        function update(patch: Partial<typeof choice>) {
          setVersionPreview(null); setDraft(d => d ? { ...d, mcp: d.mcp.map(c => c.source === m.source ? { ...c, ...patch } : c) } : d); setDirty(true); setStatus("");
        }
        return <div className="configuration-mcp" key={m.source}>
          <label className="configuration-check"><input type="checkbox" disabled={busy || importing || pendingImport} checked={choice.enabled} onChange={e => update({ enabled: e.target.checked })} />{m.name}</label>
          <details><summary>选择工具 · {choice.tools.length} / {m.tools.length}</summary>{m.tools.map(t => <label key={t.name} className="configuration-check"><input type="checkbox" disabled={busy || importing || pendingImport || !choice.enabled} checked={choice.tools.includes(t.name)} onChange={e => update({ tools: e.target.checked ? [...choice.tools, t.name] : choice.tools.filter(name => name !== t.name) })} />{t.name}</label>)}</details>
        </div>;
      })}
      <footer><p>配置不能扩大授权范围或绕过沙箱。禁用依赖资源时，需要同时禁用依赖它的资源。</p><button className="primary" type="button" disabled={busy || importing || pendingImport || !dirty} onClick={() => void perform(true)}>{busy ? "正在处理…" : "保存配置"}</button></footer>
    </>}
  </section>;
}
