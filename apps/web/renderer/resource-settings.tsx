import React, { useEffect, useRef, useState } from "react";
import type { DesktopResourceOperation, DesktopResourceSnapshot, ProjectRecord } from "@traceforge/shared/desktop-resources";
import type { DesktopConversations } from "./desktop-conversation-transport";
import "./configuration-settings.css";

// Local extension of the established white desktop settings surface: explicit
// query/acquisition → source review → user-owned usage → enable for new Runs.
// Remote Markdown remains plain text. Saving never launches installation code.
export function ResourceSettings({ bridge, onDirty }: { bridge: DesktopConversations; onDirty?: (dirty: boolean) => void }) {
  const [snapshot, setSnapshot] = useState<DesktopResourceSnapshot | null>(null);
  const [config, setConfig] = useState<DesktopResourceSnapshot["configuration"]>({ provider: "disabled", endpoint: "" });
  const [credential, setCredential] = useState(""), [clearCredential, setClearCredential] = useState(false);
  const [query, setQuery] = useState(""), [repository, setRepository] = useState(""), [ref, setRef] = useState("HEAD");
  const [results, setResults] = useState<Array<{ title?: string; repository?: string; url: string; description: string }>>([]);
  const [url, setUrl] = useState(""), [document, setDocument] = useState<{ title?: string; text: string; url?: string; truncated?: boolean } | null>(null);
  const [projectId, setProjectId] = useState(""), [usage, setUsage] = useState(""), [entryScript, setEntryScript] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [status, setStatus] = useState("");
  const alive = useRef(true), locked = useRef(false), acquireIntent = useRef<{ key: string; id: string } | null>(null);
  const project = snapshot?.projects.find(project => project.id === projectId);
  const searchDirty = !!snapshot && (JSON.stringify(config) !== JSON.stringify(snapshot.configuration) || !!credential || clearCredential);
  const projectDirty = !!project && (usage !== project.usage || entryScript !== project.entryScript);
  const dirty = searchDirty || projectDirty;
  function choose(project?: ProjectRecord) { setProjectId(project?.id ?? ""); setUsage(project?.usage ?? ""); setEntryScript(project?.entryScript ?? ""); }
  async function request(operation?: DesktopResourceOperation) {
    const response = await bridge.request({ path: "/api/desktop/resources", method: operation ? "POST" : "GET", ...(operation ? { body: JSON.stringify(operation) } : {}) });
    if (response.status !== 200) throw new Error((response.body as { error?: string })?.error ?? "请求失败，请重新读取后核对状态。");
    return response.body;
  }
  async function run(action: () => Promise<unknown>, receive: (value: unknown) => void, message: string) {
    if (locked.current) return; locked.current = true; setBusy(true); setError(""); setStatus("");
    try { const value = await action(); if (alive.current) { receive(value); setStatus(message); } }
    catch (cause) { if (alive.current) setError(`${(cause as Error).message} 草稿仍保留；请核对后重试。`); }
    finally { locked.current = false; if (alive.current) setBusy(false); }
  }
  function loaded(value: unknown) {
    const next = value as DesktopResourceSnapshot;
    if (!next || !Array.isArray(next.projects) || !next.configuration) throw new Error("宿主返回的资源状态无效");
    setSnapshot(next); setConfig(next.configuration); choose(next.projects.find(project => project.id === projectId) ?? next.projects[0]);
    setCredential(""); setClearCredential(false);
  }
  useEffect(() => { alive.current = true; void run(() => request(), loaded, ""); return () => { alive.current = false; }; }, []);
  useEffect(() => { onDirty?.(dirty || busy); }, [dirty, busy, onDirty]);
  const update = () => { setStatus(""); };
  function acquire() {
    const key = JSON.stringify([repository, ref]);
    if (acquireIntent.current?.key !== key) acquireIntent.current = { key, id: crypto.randomUUID() };
    const commandId = acquireIntent.current.id;
    void run(() => request({ operation: "acquire", repository, ref, commandId, confirmed: true }), loaded, "源码已获取，尚未安装依赖或执行。请先核对说明、许可证和入口脚本。");
  }
  return <section className="configuration-settings resource-settings" aria-label="工具与公开资料">
    <header><h2>工具与公开资料</h2><p>查找项目、阅读文档，再决定如何使用。下载不等于安装可用。</p></header>
    <button disabled={busy || dirty} onClick={() => void run(() => request(), loaded, "已重新读取。")}>重新读取</button>
    {error && <p role="alert">{error}</p>}{status && <p role="status">{status}</p>}
    {!snapshot && !error && <p role="status">正在读取资源设置…</p>}
    {snapshot && <>
      <h3>搜索服务</h3>
      <p>查询会发送到你配置的服务。请勿提交凭证或私密数据；保存配置不会发送测试请求。</p>
      <label>全网搜索<select disabled={busy} value={config.provider} onChange={event => { const provider = event.target.value as typeof config.provider; setConfig({ provider, endpoint: provider === "brave" ? "https://api.search.brave.com/res/v1/web/search" : "" }); setCredential(""); update(); }}>
        <option value="disabled">未启用</option><option value="brave">Brave Search</option><option value="searxng">SearXNG（JSON API）</option>
      </select></label>
      {config.provider !== "disabled" && <label>搜索 API 地址<input type="url" value={config.endpoint} disabled={busy} placeholder="https://search.example.org/search" onChange={event => { setConfig({ ...config, endpoint: event.target.value }); update(); }}/></label>}
      {config.provider === "brave" && <><label>API 密钥<input type="password" autoComplete="off" disabled={busy || !snapshot.secureStorage} value={credential} placeholder={snapshot.credentialConfigured ? "已安全保存；留空保留" : "请输入密钥"} onChange={event => { setCredential(event.target.value); update(); }}/></label>
        {!snapshot.secureStorage && <p>当前宿主没有安全密钥存储，不能保存密钥。</p>}
        {snapshot.credentialConfigured && <label className="configuration-check"><input type="checkbox" checked={clearCredential} disabled={busy} onChange={event => { setClearCredential(event.target.checked); update(); }}/>移除已保存密钥</label>}</>}
      <button disabled={busy || !searchDirty} onClick={() => void run(() => request({ operation: "configure", expectedRevision: snapshot.revision, configuration: config, ...(credential ? { credential } : {}), clearCredential }), value => {
        const next = value as DesktopResourceSnapshot; setSnapshot(next); setConfig(next.configuration); setCredential(""); setClearCredential(false);
      }, "搜索设置已保存。新 Run 使用新配置，已有 Run 保持原配置。")}>保存搜索设置</button>

      <h3>查找与阅读</h3>
      <label>搜索关键词<input type="search" value={query} maxLength={500} disabled={busy} onChange={event => setQuery(event.target.value)}/></label>
      <div className="configuration-actions"><button disabled={busy || !query.trim()} onClick={() => void run(() => request({ operation: "search", kind: "github", query, confirmed: true }), value => setResults(value as typeof results), "已查询 GitHub。结果不代表项目已审核。")}>搜索 GitHub 项目</button>
        <button disabled={busy || !query.trim() || snapshot.configuration.provider === "disabled"} onClick={() => void run(() => request({ operation: "search", kind: "web", query, confirmed: true }), value => setResults(value as typeof results), "网页搜索已完成。")}>搜索网页</button></div>
      {snapshot.configuration.provider === "disabled" && <p>全网搜索未启用。GitHub 项目搜索和公开网页读取不依赖搜索密钥。</p>}
      <ul className="resource-results">{results.map(item => <li key={item.url}><button disabled={busy} onClick={() => item.repository ? setRepository(item.repository) : setUrl(item.url)}>{item.repository ?? item.title ?? item.url}</button><p>{item.description}</p><small>{item.url}</small></li>)}</ul>
      <label>公开文档地址<input type="url" value={url} disabled={busy} onChange={event => setUrl(event.target.value)} placeholder="https://…"/></label>
      <button disabled={busy || !url.trim()} onClick={() => void run(() => request({ operation: "fetch", url, confirmed: true }), value => setDocument(value as typeof document), "已读取公开正文；未登录、未执行页面脚本。")}>读取网页正文</button>
      {document && <details open><summary>{document.title || "文档正文"}{document.truncated ? " · 已截断" : ""}</summary><p>{document.url}</p><pre tabIndex={0}>{document.text}</pre></details>}

      <h3>获取项目源码</h3><p>只读取公开 GitHub 项目。分支或标签会固定到完整 commit；不运行安装钩子，不拉取子模块。</p>
      <label>GitHub 项目<input value={repository} disabled={busy} maxLength={300} onChange={event => setRepository(event.target.value)} placeholder="owner/repository"/></label>
      <label>分支、标签或 commit<input value={ref} disabled={busy} maxLength={200} onChange={event => setRef(event.target.value)}/></label>
      <button disabled={busy || dirty || !repository.trim() || !ref.trim()} onClick={acquire}>确认下载源码（不执行）</button>
      {dirty && <p>请先保存尚未提交的配置，再下载或切换项目。</p>}

      <h3>本地源码库</h3>
      {!snapshot.projects.length && <p>还没有项目。获取源码后，先阅读使用方法，再保存你审核过的入口。</p>}
      {!!snapshot.projects.length && <label>已获取的项目<select value={projectId} disabled={busy || dirty} onChange={event => choose(snapshot.projects.find(project => project.id === event.target.value))}>{snapshot.projects.map(project => <option key={project.id} value={project.id}>{project.repository} · {project.commit.slice(0, 8)}</option>)}</select></label>}
      {project && <>
        <p>{project.enabled ? "已为新 Run 启用，仍需在任务内审批执行" : "未启用"} · {project.fileCount} 个文件 · 未验证依赖或运行效果</p>
        <details open><summary>README（外部原文，不是执行指令）</summary><pre tabIndex={0}>{project.readme}</pre></details>
        <details><summary>许可证与来源版本</summary><p>Commit：{project.commit}</p><p>归档摘要：{project.digest}</p><pre tabIndex={0}>{project.license ?? "未找到根目录许可证，请自行核实使用条件。"}</pre></details>
        <details><summary>查看源码文件</summary><ul className="resource-files">{project.files.map(path => <li key={path}><button disabled={busy} onClick={() => void run(() => request({ operation: "read", id: project.id, path }), value => setDocument(value as typeof document), "源码以纯文本展示，未执行。")}>{path}</button></li>)}</ul></details>
        <label>使用说明与依赖<textarea rows={5} maxLength={16000} value={usage} disabled={busy} onChange={event => { setUsage(event.target.value); update(); }} placeholder="说明用途、参数、依赖和已知限制。模型会读取这一版说明。"/></label>
        <label>任务内入口脚本（Bash）<textarea rows={6} maxLength={16000} value={entryScript} disabled={busy} onChange={event => { setEntryScript(event.target.value); update(); }} placeholder="执行时已进入项目目录；可用 $@ 读取参数。"/></label>
        <p>保存只记录脚本。任务里另行审批后才会离线运行；缺少依赖时明确失败，不会自动安装依赖或绕过联网授权。</p>
        {searchDirty && <p>先保存搜索设置，再提交项目使用方式，避免丢失另一份草稿。</p>}
        <div className="configuration-actions"><button disabled={busy || searchDirty || !projectDirty || !usage.trim() || !entryScript.trim()} onClick={() => void run(() => request({ operation: "prepare", id: project.id, expectedRevision: project.revision, usage, entryScript, confirmed: true }), loaded, "使用方式已保存，未运行任何代码。")}>确认保存使用方式</button>
          <button disabled={busy || dirty || (!project.enabled && (!project.entryScript || !project.usage))} onClick={() => void run(() => request({ operation: "enable", id: project.id, expectedRevision: project.revision, enabled: !project.enabled, confirmed: true }), loaded, project.enabled ? "已停用；已有 Run 也不能再装配此项目。" : "已为新 Run 启用；已有 Run 不自动改变。")}>{project.enabled ? "停用项目" : "为新 Run 启用"}</button></div>
      </>}
    </>}
  </section>;
}
