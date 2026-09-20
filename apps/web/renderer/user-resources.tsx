import React, { useEffect, useRef, useState } from "react";
import type { ConfigurationSnapshot, UserResource } from "@traceforge/shared/desktop-configuration";
import { guidanceVariables, renderGuidanceTemplate } from "@traceforge/shared/desktop-configuration";

type Parent = ConfigurationSnapshot["packages"][number]["resources"][number];
const roleName: Record<string, string> = { worker: "执行智能体", planner: "规划智能体", observer: "观察智能体" };
const kindName = { skill: "Skill", prompt: "角色指导", knowledge: "知识资料" };

export async function readGuidanceFile(file: File): Promise<string> {
  if (!/\.(md|txt)$/i.test(file.name) || file.size > 65536) throw new Error("请选择不超过 64 KiB 的 Markdown 或 TXT 文件。");
  const bytes = await file.arrayBuffer();
  if (bytes.byteLength > 65536) throw new Error("文件超过 64 KiB。");
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new Error("文件不是有效的 UTF-8 文本，请转换编码后再导入。"); }
}

/** Text-only user material. Importing a Markdown document never installs scripts or invokes tools. */
export function UserResources({ resources, parents, busy, onChange, onBusy, onPending }: {
  resources: UserResource[]; parents: Parent[]; busy: boolean; onChange: (items: UserResource[]) => void; onBusy: (busy: boolean) => void; onPending: (pending: boolean) => void;
}) {
  const [selected, setSelected] = useState("");
  const [remove, setRemove] = useState(false), [error, setError] = useState("");
  const [pendingImport, setPendingImport] = useState<{ id: string; content: string; name:string } | null>(null);
  const importing = useRef(false);
  useEffect(() => { onPending(!!pendingImport); return () => onPending(false); }, [pendingImport, onPending]);
  const item = resources.find(r => r.id === selected) ?? resources[0];
  const parent = parents.find(p => p.id === item?.parentId);
  const available = parents.filter(p => p.editable && p.roles.length > 0);
  function patch(value: Partial<UserResource>) {
    if (!item) return;
    onChange(resources.map(r => r.id === item.id ? { ...r, ...value } : r)); setRemove(false); setError("");
  }
  function add() {
    const source = available[0]; if (!source || resources.length >= 64) return;
    const id = `user.${crypto.randomUUID()}`;
    onChange([...resources, { id, parentId: source.id, title: "未命名 Skill", kind: "skill", content: "", enabled: true,
      roles: [source.roles[0] as UserResource["roles"][number]], phases: [],source:{kind:"editor",name:"客户端新建"} }]); setSelected(id); setRemove(false);
  }
  async function importFile(file: File | undefined) {
    if (!file || !item || importing.current || busy) return;
    importing.current = true; onBusy(true); setError(""); setRemove(false);
    try {
      const content = await readGuidanceFile(file);
      if (item.content) setPendingImport({ id: item.id, content,name:file.name.slice(0,200) });
      else patch({ content,source:{kind:"file",name:file.name.slice(0,200)} });
    } catch (cause) { setError((cause as Error).message); }
    finally { importing.current = false; onBusy(false); }
  }
  return <section className="user-resources" aria-label="我的 Skills 与指导">
    <div className="configuration-actions"><h3>我的 Skills 与指导</h3><button type="button" disabled={busy || !!pendingImport || !available.length || resources.length >= 64} onClick={add}>新建资源</button></div>
    <p>保存自己的 Skill、角色指导或知识资料。只加载文本；不会安装或运行其中的脚本。</p>
    {!available.length && <p>当前场景没有可继承的本地读取边界，暂不能添加用户资源。</p>}
    {!resources.length && <p>尚未添加。新建后可以直接编写，或导入 Markdown / TXT。</p>}
    {!!resources.length && <div className="configuration-editor">
      <nav aria-label="用户资源">{resources.map(r => <button key={r.id} disabled={busy || !!pendingImport} aria-current={item?.id === r.id ? "true" : undefined} onClick={() => { setSelected(r.id); setRemove(false); setError(""); }}><span>{r.title || "未命名"}</span><small>{kindName[r.kind]} · {r.enabled ? "启用" : "停用"}</small></button>)}</nav>
      {item && <div className="configuration-document">
        <p className="configuration-meta">来源：{item.source?.kind==="file"?"导入文件 · "+item.source.name:item.source?.kind==="editor"?"客户端创建":"来源未记录（旧资源）"}。来源是用户提供的信息，不代表签名或可信认证。</p>
        <p className="configuration-meta">使用位置：当前场景 · {item.roles.map(r=>roleName[r]??r).join("、")} · {item.phases.length?item.phases.join("、"):"继承父资源阶段"}。{!item.enabled?"资源已停用。":!parent?.enabled?"父资源已停用，本资源不可读取。":"新任务按保存后的配置使用。"}角色指导自动加入上下文；Skill 和知识资料按需读取。</p>
        <fieldset disabled={busy || !!pendingImport}>
          <label>资源名称<input aria-label="用户资源名称" value={item.title} maxLength={160} required onChange={e => patch({ title: e.target.value })} /></label>
          <label>资源类型<select value={item.kind} onChange={e => patch({ kind: e.target.value as UserResource["kind"] })}>{Object.entries(kindName).map(([kind, label]) => <option key={kind} value={kind}>{label}</option>)}</select></label>
          <label>继承读取边界<select value={item.parentId} onChange={e => {
            const source = available.find(p => p.id === e.target.value)!;
            patch({ parentId: source.id, roles: [source.roles[0] as UserResource["roles"][number]], phases: [] });
          }}>{!parent?.editable && <option value={item.parentId}>{item.parentId}（当前不可用）</option>}{available.map(p => <option key={p.id} value={p.id}>{p.id}</option>)}</select></label>
          <p className="configuration-meta">继承所选资源的读取授权和依赖；原资源不可用时，本资源也不能读取。角色指导作为上下文使用，不替换系统安全约束。</p>
          <label className="configuration-check"><input type="checkbox" checked={item.enabled} onChange={e => patch({ enabled: e.target.checked })} />启用此资源</label>
          <fieldset><legend>适用角色（至少一项）</legend>{parent?.roles.map(role => <label className="configuration-check" key={role}><input type="checkbox" checked={item.roles.includes(role as UserResource["roles"][number])} onChange={e => patch({ roles: e.target.checked ? [...item.roles, role as UserResource["roles"][number]] : item.roles.filter(v => v !== role) })} />{roleName[role] ?? role}</label>)}</fieldset>
          {!!parent?.phases.length && <fieldset><legend>适用阶段（不选则继承全部）</legend>{parent.phases.map(phase => <label className="configuration-check" key={phase}><input type="checkbox" checked={item.phases.includes(phase)} onChange={e => patch({ phases: e.target.checked ? [...item.phases, phase] : item.phases.filter(v => v !== phase) })} />{phase}</label>)}</fieldset>}
          <label>资源正文<textarea aria-label="用户资源正文" rows={12} value={item.content} maxLength={65536} onChange={e => patch({ content: e.target.value })} /></label>
          {item.kind==="prompt"&&<><p>角色指导会在所选角色和阶段自动加入模型上下文，不必等待工具读取。可插入任务变量：</p>
            <div className="configuration-actions">{guidanceVariables.map(name=><button type="button" key={name} onClick={()=>patch({content:`${item.content}{{${name}}}`})}>{`{{${name}}}`}</button>)}</div>
            <details><summary>模板预览（示例任务，不是真实运行）</summary><pre>{(()=>{try{return renderGuidanceTemplate(item.content,{goal:"示例任务目标",phase:item.phases[0]??parent?.phases[0]??"当前阶段",role:item.roles[0]??"worker",runId:"示例任务",caseId:"示例调查"});}catch{return "包含未知变量或渲染结果超限，请修正后保存。";}})()}</pre></details></>}
          <label>导入正文（Markdown / TXT，最多 64 KiB）<input aria-label="导入资源正文" type="file" accept=".md,.txt" onChange={e => { const file = e.target.files?.[0]; e.target.value = ""; void importFile(file); }} /></label>
          <button type="button" onClick={() => setRemove(true)}>删除此资源</button>
        </fieldset>
        {error && <p role="alert">{error}</p>}
        {pendingImport && <div role="group" aria-label="替换正文确认"><p>导入会替换当前资源正文，保存前仍是草稿。</p><button disabled={busy} onClick={() => { if (pendingImport.id === item.id) patch({ content: pendingImport.content,source:{kind:"file",name:pendingImport.name} }); setPendingImport(null); }}>替换正文</button><button disabled={busy} onClick={() => setPendingImport(null)}>取消导入</button></div>}
        {remove && <div role="group" aria-label="删除资源确认"><p>保存后从后续任务移除；已有任务保留原配置。</p><button disabled={busy} onClick={() => { onChange(resources.filter(r => r.id !== item.id)); setRemove(false); setSelected(""); }}>确认删除</button><button disabled={busy} onClick={() => setRemove(false)}>保留资源</button></div>}
      </div>}
    </div>}
  </section>;
}
