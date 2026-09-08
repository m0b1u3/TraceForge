import React, { useEffect, useMemo, useState } from "react";
import { CaretRight } from "@phosphor-icons/react";
import type { DesktopConversations } from "./desktop-conversation-transport";
import type { SavedMessage } from "./conversation-client";
import { readExecutionJournal } from "./execution-journal";
import { EvidenceReference } from "./evidence-reference";
import { ExecutionController } from "./execution-controller";
import { AuthorizationForm } from "./authorization-form";

interface Catalog {
  modelReady: boolean;
  definitions: Array<{ kind: string; version: number; title?: string; authorizationForm?: unknown; authorizationReview?: unknown }>;
  scopes: Array<{ id: string; scenarioKind: string; status: string; expiresAt: string; scope: unknown }>;
  runs: Array<{ runId: string; status: string; revision: number; goal: string;
    workItems: Array<{ id: string; title: string; status: string }>; outputs: Array<{ id: string; summary: string; refs: string[] }> }>;
  truncated: boolean;
}

/** Application projection only; no Scenario rules, provider calls or execution policy. */
export function ExecutionPanel({ bridge, conversationId, messages, evidenceOnly = false, inline = false }: {
  bridge: DesktopConversations; conversationId: string; messages: SavedMessage[]; evidenceOnly?: boolean; inline?: boolean;
}) {
  const [catalog, setCatalog] = useState<Catalog | null>(null), [error, setError] = useState("");
  const [busy, setBusy] = useState(false), [scopeId, setScopeId] = useState("");
  const [selection, setSelection] = useState(""), [scopeText, setScopeText] = useState("{}");
  const [confirmedFor, setConfirmedFor] = useState<string | null>(null), [notice, setNotice] = useState("");
  const [journal] = useState(() => {
    try { return { pending: readExecutionJournal(localStorage, conversationId), error: false }; }
    catch { return { pending: null, error: true }; }
  });
  const [pending, setPending] = useState(journal.pending);
  const controller = useMemo(() => {
    try { return new ExecutionController(bridge, localStorage, conversationId); } catch { return null; }
  }, [bridge, conversationId]);
  const path = `/api/desktop/conversations/${conversationId}/execution`;
  async function load() {
    const result = await bridge.request({ path, method: "GET" });
    const value = result.body as Catalog;
    if (result.status !== 200 || !value || !Array.isArray(value.runs) || !Array.isArray(value.scopes) || !Array.isArray(value.definitions)) throw new Error("任务状态读取失败，请重试。");
    setCatalog(value);
  }
  useEffect(() => {
    let active = true;
    const poll = async () => {
      try {
        const result = await bridge.request({ path, method: "GET" }), value = result.body as Catalog;
        if (!active) return;
        if (result.status !== 200 || !value || !Array.isArray(value.runs) || !Array.isArray(value.scopes) || !Array.isArray(value.definitions)) throw new Error();
        setCatalog(value);
      } catch { if (active) setError("任务状态读取失败。上次状态保留，请重新读取。"); }
      if (active) timer = setTimeout(poll, 2000);
    };
    let timer: ReturnType<typeof setTimeout>;
    void poll(); return () => { active = false; clearTimeout(timer); };
  }, [bridge, conversationId]);
  async function write(operation: { path: string; body: Record<string, unknown> }) {
    if (journal.error || !controller) return false;
    setBusy(true); setError("");
    try {
      await controller.execute(operation); setPending(null);
      setNotice("宿主已接受操作。任务状态以实际运行回执为准。"); setConfirmed(false); await load(); return true;
    } catch (value) { setError(value instanceof Error ? value.message : "操作未完成，请核对状态。"); return false; }
    finally { try { setPending(controller.pending); } catch { setError("待确认记录无法读取，请保留记录并核对宿主状态。"); } setBusy(false); }
  }
  const scope = catalog?.scopes.find(item => item.id === scopeId && item.status === "active" && Date.parse(item.expiresAt) > Date.now());
  const definition = catalog?.definitions.find(item => `${item.kind}:${item.version}` === selection)
    ?? (catalog?.definitions.length === 1 ? catalog.definitions[0] : undefined);
  const activeScopes = catalog?.scopes.filter(item => item.status === "active" && Date.parse(item.expiresAt) > Date.now()) ?? [];
  const availableDefinitions = catalog?.definitions.filter(item => item.kind === scope?.scenarioKind) ?? [];
  const selectedDefinition = availableDefinitions.length === 1 ? availableDefinitions[0] : availableDefinitions.find(item => `${item.kind}:${item.version}` === selection);
  const message = messages.at(-1);
  // Bind the click to exactly the intent, current authorization and definition
  // the user saw. Poll updates must not silently reuse an older confirmation.
  const confirmationIdentity = JSON.stringify([message?.commandId, message?.text, scope?.id, scope?.scope, scope?.expiresAt,
    selectedDefinition?.kind, selectedDefinition?.version]);
  const confirmed = confirmedFor === confirmationIdentity;
  const setConfirmed = (value: boolean) => setConfirmedFor(value ? confirmationIdentity : null);
  return <section className={`execution-panel${inline ? " execution-inline" : ""}`} aria-label="真实调查任务">
    {(evidenceOnly || activeScopes.length > 0) && <h2>{evidenceOnly ? "任务输出与引用" : "准备调查"}</h2>}
    {journal.error && <p role="alert">待确认记录损坏，操作已暂停。请保留本地记录并核对宿主状态，不要清空后重复启动。</p>}
    {!catalog && <p role="status">正在读取宿主配置…</p>}
    {catalog && <>
      {!evidenceOnly && <fieldset disabled={journal.error}>
      {!catalog.definitions.length && <p>尚未安装可用场景，请先在宿主配置中安装并审核场景包。</p>}
      {!catalog.modelReady && <p className="inline-warning">请先在设置中保存可用模型连接。</p>}
      {activeScopes.length > 0 && <>
      <p className="authorization-help">使用最后一条调查说明，可能产生模型费用和目标请求。</p>
      <label>有效授权<select value={scopeId} onChange={event => { setScopeId(event.target.value); setConfirmed(false); }} disabled={busy || !!pending}>
        <option value="">选择本会话授权</option>{catalog.scopes.filter(item => item.status === "active" && Date.parse(item.expiresAt) > Date.now()).map(item => <option key={item.id} value={item.id}>{item.scenarioKind} · {item.id}</option>)}
      </select></label>
      {scope && <details><summary>核对授权范围</summary><pre>{JSON.stringify(scope.scope, null, 2)}</pre></details>}
      {availableDefinitions.length > 1 && <label>场景版本<select value={selection} onChange={event => { setSelection(event.target.value); setConfirmed(false); }}><option value="">请选择版本</option>{availableDefinitions.map(item => <option key={item.version} value={`${item.kind}:${item.version}`}>v{item.version}</option>)}</select></label>}
      <p>调查说明：{message?.text ?? "请先返回对话，保存调查说明。"}</p>
      <label className="execution-confirm"><input type="checkbox" checked={confirmed} disabled={busy || !!pending} onChange={event => setConfirmed(event.target.checked)} />我确认使用上述授权启动调查</label>
      <button className="primary" disabled={busy || !!pending || !confirmed || !catalog.modelReady || !scope || !message || !selectedDefinition}
        onClick={() => void write({ path, body: { commandId: crypto.randomUUID(), messageCommandId: message!.commandId, scopeRef: scope!.id,
          scenarioKind: selectedDefinition!.kind, definitionVersion: selectedDefinition!.version } })}>启动调查</button>
      </>}
      <details className={`authorization-setup${!activeScopes.length ? " authorization-initial" : ""}`} open={!activeScopes.length}>
        <summary><CaretRight className="disclosure-caret" aria-hidden="true" />{activeScopes.length ? "登记新的场景授权" : "设置授权范围"}</summary>
        {catalog.definitions.length > 1 ? <label>场景<select disabled={busy || !!pending} value={selection} onChange={event => setSelection(event.target.value)}><option value="">选择场景</option>{catalog.definitions.map(item => <option key={`${item.kind}:${item.version}`} value={`${item.kind}:${item.version}`}>{item.title ?? item.kind} · v{item.version}</option>)}</select></label>
          : definition && <p className="authorization-scenario">{definition.title ?? definition.kind}<span>v{definition.version}</span></p>}
        {definition?.authorizationForm !== undefined ? <AuthorizationForm
          key={JSON.stringify([selection, definition.authorizationForm, definition.authorizationReview])}
          contract={definition.authorizationForm} policy={definition.authorizationReview} disabled={busy || !!pending}
          register={async (value, expiresAt) => {
            const commandId = crypto.randomUUID();
            const success = await write({ path: `${path}/authorize`, body: { commandId,
              scenarioKind: definition.kind, definitionVersion: definition.version, scope: value, expiresAt, confirmed: true } });
            if (success) setScopeId(commandId);
            return success;
          }} /> : definition && <details><summary>高级 JSON 授权</summary><p>此场景尚未提供可视化表单，请按场景文档填写。</p>
        <label>场景范围 JSON<textarea rows={6} value={scopeText} onChange={event => setScopeText(event.target.value)} maxLength={32768} /></label>
        <button disabled={busy || !!pending || !definition} onClick={() => {
          try { const value = JSON.parse(scopeText); void write({ path: `${path}/authorize`, body: { commandId: crypto.randomUUID(),
            scenarioKind: definition!.kind, definitionVersion: definition!.version, scope: value,
            expiresAt: new Date(Date.now() + 3600000).toISOString(), confirmed: true } }); }
          catch { setError("范围 JSON 格式无效，未登记授权。"); }
        }}>确认登记 · 有效期一小时</button>
        </details>}
      </details>
      </fieldset>}
      {(catalog.runs.length > 0 || evidenceOnly) && <h3>运行记录</h3>}{!catalog.runs.length && evidenceOnly && <p>尚未启动调查。</p>}
      {catalog.truncated && <p>当前显示最近 20 次运行。</p>}
      {catalog.runs.map(run => <article key={run.runId} className="execution-run"><h3>{run.goal}</h3><p>状态：{run.status} · 版本 {run.revision}</p>
        {!evidenceOnly && !['completed', 'cancelled', 'failed'].includes(run.status) && <button disabled={busy || !!pending || journal.error} onClick={() => void write({ path: `${path}/cancel`, body: { commandId: crypto.randomUUID(), runId: run.runId, expectedRevision: run.revision } })}>请求停止调查</button>}
        <ul>{run.workItems?.map(work => <li key={work.id}>{work.title} · {work.status}</li>)}</ul>
        {run.outputs?.map(output => <div key={output.id} className="message message-assistant"><div className="message-body"><div className="sender">智能体任务输出</div><p>{output.summary}</p><details><summary>证据引用</summary><ul>{output.refs.map(ref => <li key={ref}><EvidenceReference bridge={bridge} conversationId={conversationId} runId={run.runId} reference={ref} /></li>)}</ul></details></div></div>)}
      </article>)}
    </>}
    {notice && <p role="status">{notice}</p>}{error && <p role="alert" className="inline-warning">{error}</p>}
    {pending && !evidenceOnly && <button disabled={busy} onClick={() => void write(pending)}>核对原请求</button>}
  </section>;
}
