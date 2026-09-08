import React, { useEffect, useRef, useState } from "react";
import { ArrowClockwise, Key, ShieldCheck } from "@phosphor-icons/react";
import { ModelSettingsClient } from "./model-settings-client";
import { ModelAccountPanel } from "./model-account-panel";
import type { ModelConfigInput, ModelSettingsBridge, ModelSettingsSnapshot } from "./model-settings-client";

const labels: Record<string, string> = { deepseek: "DeepSeek", xai: "xAI / Grok API", kimi: "Kimi", glm: "GLM", custom: "自定义 / 兼容端点" };
const empty: ModelConfigInput = { provider: "openai", model: "", baseUrl: "", jsonMode: "json_object", authMode: "api_key" };

export function ModelSettings({ bridge, onDirty }: { bridge?: ModelSettingsBridge; onDirty?: (dirty:boolean)=>void }) {
  const [client] = useState(() => bridge ? new ModelSettingsClient(bridge) : null);
  const [snapshot, setSnapshot] = useState<ModelSettingsSnapshot | null>(null);
  const [form, setForm] = useState<ModelConfigInput>(empty);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState<"load" | "save" | "test" | "discover" | null>(null);
  const [catalog, setCatalog] = useState<{ models: Array<{ id: string }>; truncated: boolean } | null>(null);
  const [catalogError, setCatalogError] = useState("");
  const lastDiscovery = useRef("");
  const [result, setResult] = useState("");
  const [error, setError] = useState("");
  const [dirty, setDirty] = useState(false);
  const [confirmReload, setConfirmReload] = useState(false);
  const [mustReload, setMustReload] = useState(false);
  const [accountBusy, setAccountBusy] = useState(false);
  const locked = useRef(false);
  const alive = useRef(true);
  useEffect(()=>{onDirty?.(dirty||!!busy||accountBusy||confirmReload);},[dirty,busy,accountBusy,confirmReload,onDirty]);
  useEffect(()=>{if(!dirty&&!busy&&!accountBusy)return;const warn=(event:BeforeUnloadEvent)=>{event.preventDefault();event.returnValue="";};window.addEventListener("beforeunload",warn);return()=>window.removeEventListener("beforeunload",warn);},[dirty,busy,accountBusy]);
  useEffect(() => { alive.current = true; void load(); return () => { alive.current = false; }; }, []);

  function accept(value: ModelSettingsSnapshot) {
    setSnapshot(value);
    const current = value.config;
    setForm(current ? { provider: current.provider, supplier: current.supplier, model: current.model, credentialRef: current.credentialRef,
      baseUrl: current.baseUrl ?? value.suppliers[current.supplier ?? ""]?.baseUrl ?? (current.provider === "anthropic" ? "https://api.anthropic.com" : "https://api.openai.com/v1"),
      authMode: current.authMode ?? "api_key", jsonMode: current.jsonMode ?? "json_object", contextWindowTokens: current.contextWindowTokens,
      maxOutputTokens: current.maxOutputTokens, requestOptions: current.requestOptions } : empty);
    if (!current) {
      const connected = value.accounts?.filter(account => account.status !== "signed_out") ?? [];
      if (connected.length === 1) setForm({ ...empty, credentialRef: connected[0].id, provider: connected[0].provider, baseUrl: connected[0].baseUrl, authMode: "bearer" });
    }
    setKey(""); setDirty(false); setMustReload(false);
  }
  async function load() {
    if (!client || locked.current) return;
    locked.current = true; setBusy("load"); setError(""); setConfirmReload(false);
    try { const value = await client.load(); if (alive.current) { accept(value); setResult("已读取宿主配置，密钥不会回显。"); } }
    catch (cause) { if (alive.current) { setMustReload(true); setError((cause as Error).message); } }
    finally { locked.current = false; if (alive.current) setBusy(null); }
  }
  function change(patch: Partial<ModelConfigInput>) { setForm(value => ({ ...value, ...patch })); setDirty(true); setResult(""); setError(""); }
  function supplier(value: string) {
    setKey("");
    const preset = snapshot?.suppliers[value];
    change(preset ? { supplier: value as ModelConfigInput["supplier"], provider: preset.protocol, baseUrl: preset.baseUrl, jsonMode: preset.jsonMode, model: "", requestOptions: undefined } : { supplier: undefined, model: "", baseUrl: "", requestOptions: undefined });
  }
  const savedUrl = snapshot?.config?.baseUrl ?? snapshot?.suppliers[snapshot?.config?.supplier ?? ""]?.baseUrl ?? (snapshot?.config?.provider === "anthropic" ? "https://api.anthropic.com" : "https://api.openai.com/v1");
  const sameDestination = snapshot?.config?.provider === form.provider && savedUrl.replace(/\/+$/, "") === form.baseUrl.replace(/\/+$/, "");
  const canKeepKey = sameDestination && !!snapshot?.config?.apiKeyMasked;
  const managed = !!form.credentialRef;
  const selectedAccount = snapshot?.accounts?.find(account => account.id === form.credentialRef);
  const ready = !!client && !!snapshot && !busy && !accountBusy && !mustReload && (!managed || !!selectedAccount && selectedAccount.status !== "signed_out");
  const discoveryKey = JSON.stringify([snapshot?.revision, form.provider, form.baseUrl, form.credentialRef, form.authMode, key, selectedAccount?.status]);
  useEffect(() => { setCatalog(null); setCatalogError(""); lastDiscovery.current = ""; }, [discoveryKey]);
  useEffect(() => {
    if (!ready || !form.baseUrl || (!managed && !key && !canKeepKey) || lastDiscovery.current === discoveryKey) return;
    const timer = setTimeout(() => { lastDiscovery.current = discoveryKey; void fetchCatalog(); }, managed ? 0 : 700);
    return () => clearTimeout(timer);
  }, [discoveryKey, ready]);
  async function fetchCatalog() {
    if (!ready || locked.current) return;
    locked.current = true; setBusy("discover"); setCatalogError("");
    try {
      const value = await client.discover(snapshot.revision, { ...form, ...(!managed && key ? { apiKey: key } : {}) });
      if (alive.current) setCatalog(value);
    } catch (cause) { if (alive.current) { setCatalog(null); setCatalogError((cause as Error).message); } }
    finally { locked.current = false; if (alive.current) setBusy(null); }
  }
  async function perform(operation: "save" | "test") {
    if (!ready || locked.current) return;
    let url: URL;
    try { url = new URL(form.baseUrl); if (url.username || url.password || url.search || url.hash || !(url.protocol === "https:" || url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) throw new Error(); }
    catch { setError("请填写 HTTPS API 地址；仅本机回环地址允许 HTTP，不允许用户名、查询参数或片段。"); return; }
    if (!form.model.trim() || (!managed && !key && !canKeepKey)) { setError("请填写模型 ID 和 API 密钥。更换端点后必须重新输入密钥。"); return; }
    if (/[\r\n]/.test(key)) { setError("密钥不能包含换行。"); return; }
    locked.current = true; setBusy(operation); setError(""); setResult("");
    const payload = { ...form, model: form.model.trim(), ...(!managed && key ? { apiKey: key } : {}) };
    try {
      if (operation === "save") { const value = await client.save(snapshot.revision, payload); if (alive.current) { accept(value); setResult("已保存到安全存储并应用于宿主后续调用。尚未证明调查或工具调用可用。"); } }
      else { const ok = await client.test(snapshot.revision, payload); if (alive.current) setResult(ok ? "连接测试通过：模型返回了结构化确认。当前表单未保存；这不是工具调用或调查验收。" : "连接测试未通过。请检查端点、模型 ID、密钥与 API 权限；未保存配置。"); }
    } catch (cause) { if (alive.current) { setError((cause as Error).message); setMustReload(true); setKey(""); } }
    finally { locked.current = false; if (alive.current) setBusy(null); }
  }

  return <section className="model-settings" aria-label="模型连接设置">
    <div className="model-settings-heading"><div><h2>模型连接</h2><p>配置工作台使用的模型，与调查场景独立。</p></div><span className="status">宿主级配置</span></div>
    {!client && <p className="model-notice" role="status">当前为界面预览，未连接桌面安全存储。可以查看配置项，但不能输入密钥、保存或调用模型。</p>}
    <ModelAccountPanel client={client} accounts={snapshot?.accounts ?? []} disabled={!!busy || mustReload} onBusy={setAccountBusy}
      onAccounts={accounts => {
        setSnapshot(value => value ? { ...value, accounts } : value);
        const connected = accounts.filter(account => account.status !== "signed_out");
        if (!dirty && !snapshot?.configured && connected.length === 1) setForm({ ...empty, credentialRef: connected[0].id, provider: connected[0].provider, baseUrl: connected[0].baseUrl, authMode: "bearer" });
      }} />
    {managed && !selectedAccount && <p className="model-notice">已保存的账号连接未注册，暂不能调用。请恢复宿主注册或明确切换到 API Key。</p>}
    <form onSubmit={event => { event.preventDefault(); void perform("save"); }}>
      <fieldset disabled={!!busy || accountBusy}><legend className="sr-only">模型连接参数</legend>
        <label>认证连接<select aria-label="认证连接" value={form.credentialRef ?? ""} onChange={event => {
          setKey(""); const account = snapshot?.accounts?.find(item => item.id === event.target.value);
          change(account ? { credentialRef: account.id, provider: account.provider, baseUrl: account.baseUrl, authMode: "bearer", supplier: undefined, requestOptions: undefined }
            : { credentialRef: undefined, authMode: "api_key" });
        }}><option value="">API Key</option>{managed && !selectedAccount && <option value={form.credentialRef}>未注册的已保存连接</option>}{snapshot?.accounts?.map(account => <option key={account.id} value={account.id}>{account.label}{account.status === "signed_out" ? " · 未登录" : ""}</option>)}</select></label>
        <div className="model-fields"><label>供应商<select aria-label="供应商" disabled={managed} value={form.supplier ?? "custom"} onChange={event => supplier(event.target.value)}><option value="custom">自定义 / 兼容端点</option>{Object.keys(snapshot?.suppliers ?? {}).map(id => <option key={id} value={id}>{labels[id] ?? id}</option>)}</select></label>
        <label>接口协议<select aria-label="接口协议" disabled={managed} value={form.provider} onChange={event => { setKey(""); change({ provider: event.target.value as ModelConfigInput["provider"], requestOptions: undefined }); }}><option value="openai">OpenAI Chat Completions</option><option value="responses">Responses</option><option value="anthropic">Anthropic Messages</option></select></label></div>
        <p className="field-help">供应商与协议独立选择，请确认端点支持该协议。切换协议会清除输入的密钥和协议专用参数，不会自动改用其他协议重试。</p>
        <label>API 地址<input aria-label="API 地址" disabled={managed} type="url" value={form.baseUrl} placeholder="https://api.example.com/v1" autoComplete="off" maxLength={2048} onChange={event => { setKey(""); change({ baseUrl: event.target.value, supplier: undefined }); }} /></label>
        <div className="model-catalog">
          <label>选择模型<select aria-label="选择模型" value={catalog?.models.some(item => item.id === form.model) ? form.model : ""} disabled={!catalog?.models.length} onChange={event => { if (event.target.value) change({ model: event.target.value }); }}>
            <option value="">{busy === "discover" ? "正在获取模型列表…" : "从当前连接的模型目录选择"}</option>
            {catalog?.models.map(model => <option key={model.id} value={model.id}>{model.id}</option>)}
          </select></label>
          <button type="button" disabled={!ready || !form.baseUrl || (!managed && !key && !canKeepKey)} onClick={() => void fetchCatalog()}>刷新模型列表</button>
        </div>
        <p className="field-help" role="status">{busy === "discover" ? "正在读取模型目录，不发送对话或生成请求…" : catalog ? `${catalog.models.length ? `获取到 ${catalog.models.length} 个模型` : "供应商返回空目录，可手动填写"}${catalog.truncated ? "（列表不完整，可手动填写未列出的模型）" : ""}。目录不代表模型调用或工具能力已通过。` : "连接就绪后自动读取模型目录，不会自动选择、保存或测试模型。"}</p>
        {catalogError && <p className="model-error" role="alert">{catalogError}</p>}
        <label>模型 ID<input aria-label="模型 ID" value={form.model} placeholder="从上方选择，或手动填写模型 ID" maxLength={200} autoComplete="off" onChange={event => change({ model: event.target.value })} /></label>
        <label><span><Key size={16} /> API 密钥</span><input aria-label="API 密钥" type="password" value={key} disabled={managed || !client || !snapshot || mustReload} autoComplete="new-password" spellCheck={false} maxLength={8192} placeholder={canKeepKey ? "已保存 · 留空保留现有密钥" : "输入此端点的 API 密钥"} onChange={event => { setKey(event.target.value); setDirty(true); setResult(""); }} /></label>
        <p className="field-help">{canKeepKey ? "密钥不会回显；留空仅在相同端点和协议下保留。" : "更换端点或协议后，不会沿用之前的密钥。"} 密钥不写入浏览器存储或对话历史。</p>
        <details className="model-advanced"><summary>高级参数</summary><div className="model-fields"><label>JSON 输出<select value={form.jsonMode ?? "json_object"} onChange={event => change({ jsonMode: event.target.value as ModelConfigInput["jsonMode"] })}><option value="json_object">JSON Object</option><option value="json_schema">JSON Schema</option></select></label><label>凭据方式<select value={form.authMode ?? "api_key"} onChange={event => change({ authMode: event.target.value as ModelConfigInput["authMode"] })}><option value="api_key">API Key（协议默认）</option><option value="bearer">Bearer Token</option></select></label><label>上下文上限<input type="number" min={1} max={100000000} value={form.contextWindowTokens ?? ""} placeholder="保留宿主默认" onChange={event => change({ contextWindowTokens: event.target.value ? Number(event.target.value) : undefined })} /></label><label>最大输出 Tokens<input type="number" min={1} max={10000000} value={form.maxOutputTokens ?? ""} placeholder="保留宿主默认" onChange={event => change({ maxOutputTokens: event.target.value ? Number(event.target.value) : undefined })} /></label></div><p className="field-help">参数支持因模型而异。现有推理参数会保留；本表单不自动推断模型能力。</p></details>
      </fieldset>
      <div className="model-notes"><ShieldCheck size={20} /><p>保存影响宿主后续模型调用，不只当前对话。连接测试会向上方端点发送一次最小请求，可能产生 API 费用。Grok 等聊天订阅不等于 API 授权；账号登录仅在宿主安装了有效注册时可用，不保证所有套餐均有模型调用权限。</p></div>
      {error && <p role="alert" className="model-error">{error}</p>}<p role="status" className="model-result">{busy === "load" ? "正在读取安全配置…" : busy === "save" ? "正在保存，请等待宿主回执…" : busy === "test" ? "正在测试连接，最长等待约 30 秒…" : result}</p>
      <div className="model-actions"><button type="button" disabled={!client || !!busy || accountBusy} onClick={() => dirty ? setConfirmReload(true) : void load()}><ArrowClockwise />重新读取</button><div><button type="button" disabled={!ready} onClick={() => void perform("test")}>测试连接</button><button className="primary" type="submit" disabled={!ready}>保存配置</button></div></div>
      {confirmReload && <div className="model-reload-confirm"><p>重新读取会丢弃当前未保存的配置和输入的密钥。</p><button type="button" onClick={() => setConfirmReload(false)}>继续编辑</button><button type="button" onClick={() => void load()}>放弃修改并读取</button></div>}
    </form>
  </section>;
}
