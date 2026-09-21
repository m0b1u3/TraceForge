import React, { useEffect, useRef, useState } from "react";
import { DesktopMcpOperationSchema, McpConnectionSchema, type DesktopMcpOperation, type DesktopMcpSnapshot, type McpConnection } from "@traceforge/shared/desktop-mcp";
import type { DesktopConversations } from "./desktop-conversation-transport";
import "./configuration-settings.css";

// Extend the existing white settings workspace: connection → explicit test → tool review → activation.
// Secret values are write-only; saving never contacts the configured endpoint.
export function McpSettings({bridge,onDirty}:{bridge:DesktopConversations;onDirty?:(dirty:boolean)=>void}) {
  const [snapshot,setSnapshot] = useState<DesktopMcpSnapshot|null>(null),[draft,setDraft]=useState<McpConnection|null>(null);
  const [credential,setCredential]=useState(""),[clearCredential,setClearCredential]=useState(false);
  const [addressText,setAddressText]=useState("");
  const [dirty,setDirty]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(""),[status,setStatus]=useState("");
  const [confirmation,setConfirmation]=useState<"test"|"activate"|"delete"|"reload"|null>(null);
  const [reviews,setReviews]=useState<Extract<DesktopMcpOperation,{operation:"activate"}>["tools"]>([]),[reviewDirty,setReviewDirty]=useState(false);
  const locked=useRef(false),alive=useRef(true);
  const current=snapshot?.connections.find(c=>c.connection.id===draft?.id);
  const pkg=snapshot?.packages.find(p=>JSON.stringify(p.package)===JSON.stringify(draft?.package));
  const checked = draft ? McpConnectionSchema.safeParse(draft) : null;
  const addressError = checked && !checked.success ? checked.error.issues.find(issue=>issue.path[0]==="destinationAddresses")?.message : undefined;
  function choose(value:DesktopMcpSnapshot,id?:string) {
    const entry=value.connections.find(c=>c.connection.id===id)??value.connections[0];
    setSnapshot(value);setDraft(entry?.connection??null);setCredential("");setClearCredential(false);setDirty(false);setReviewDirty(false);setConfirmation(null);
    setAddressText((entry?.connection.destinationAddresses??[]).join(", "));
    setReviews(entry?.catalog?.tools.map(t=>entry.reviewedTools.find(r=>r.name===t.name)??{name:t.name,enabled:false,resources:[]})??[]);
  }
  async function perform(operation?:DesktopMcpOperation) {
    if(locked.current)return;locked.current=true;setBusy(true);setError("");setStatus("");
    try {
      const body=operation?JSON.stringify(DesktopMcpOperationSchema.parse(operation)):undefined;
      const response=await bridge.request({path:"/api/desktop/mcp",method:operation?"POST":"GET",...(body?{body}:{})});
      if(response.status!==200)throw new Error((response.body as {error?:string})?.error??"MCP 操作失败，请重新读取核对。");
      const value=response.body as DesktopMcpSnapshot;
      if(!Array.isArray(value.connections)||!Array.isArray(value.packages))throw new Error("宿主返回无效配置。");
      if(alive.current){choose(value,draft?.id);setStatus(operation?.operation==="save"?"已保存草稿修订，尚未测试或启用。旧启用修订保持不变。":operation?.operation==="test"?"发现完成。请核对工具和资源字段，再审核启用。":operation?.operation==="activate"?"已启用。新任务使用该修订，已有任务保留原修订。":operation?.operation==="disable"?"已停用，已有任务也不能继续调用该连接。":operation?.operation==="delete"?"已移除连接。历史配置仍保留用于审计。":"已读取连接配置。");}
    }catch(cause){if(operation?.operation==="test"){try{const latest=await bridge.request({path:"/api/desktop/mcp",method:"GET"});if(alive.current&&latest.status===200&&Array.isArray((latest.body as DesktopMcpSnapshot).connections))setSnapshot(latest.body as DesktopMcpSnapshot);}catch{}}
      if(alive.current)setError(`${(cause as Error).message} 配置草稿仍保留；凭证输入已清空，需要重新填写。结果不确定时请重新读取。`);}
    finally{locked.current=false;if(alive.current){setBusy(false);setConfirmation(null);setCredential("");}}
  }
  useEffect(()=>{alive.current=true;void perform();return()=>{alive.current=false;};},[]);
  useEffect(()=>{onDirty?.(dirty||reviewDirty||busy||!!confirmation);},[dirty,reviewDirty,busy,confirmation,onDirty]);
  useEffect(()=>{if(!dirty&&!reviewDirty&&!busy&&!confirmation)return;const warn=(e:BeforeUnloadEvent)=>{e.preventDefault();e.returnValue="";};window.addEventListener("beforeunload",warn);return()=>window.removeEventListener("beforeunload",warn);},[dirty,reviewDirty,busy,confirmation]);
  function patch(value:Partial<McpConnection>){setDraft(d=>d?{...d,...value}:d);setDirty(true);setStatus("");}
  function create(){const p=snapshot?.packages[0];if(!p)return;setDraft({id:`connection-${crypto.randomUUID()}`,name:"新的 MCP 连接",transport:"streamable-http",endpoint:"",package:p.package,authorizationAction:p.actions[0]??"",capability:p.capabilities[0]??""});setReviews([]);setCredential("");setClearCredential(false);setDirty(true);setReviewDirty(false);setConfirmation(null);}
  function review(name:string,value:Partial<typeof reviews[number]>){setReviews(all=>all.map(r=>r.name===name?{...r,...value}:r));setReviewDirty(true);}
  return <section className="configuration-settings user-resources" aria-label="MCP 连接设置">
    <header><h2>MCP 连接</h2><p>连接外部工具服务，先测试，再选择允许智能体使用的工具。</p></header>
    <div className="configuration-toolbar"><button disabled={busy||dirty||reviewDirty||!!confirmation||!snapshot?.packages.length} onClick={create}>新建连接</button><button disabled={busy||!!confirmation} onClick={()=>dirty||reviewDirty?setConfirmation("reload"):void perform()}>重新读取连接</button></div>
    {error&&<p role="alert">{error}</p>}{status&&<p role="status">{status}</p>}
    {!snapshot&&!error&&<p role="status">正在读取 MCP 配置…</p>}
    {snapshot&&!snapshot.packages.length&&<p>请先安装并审核一个场景，才能为其配置工具。</p>}
    {snapshot&&!draft&&snapshot.packages.length>0&&<p>还没有 MCP 连接。新建后输入服务地址，保存不会发送网络请求。</p>}
    {draft&&<div className="configuration-editor">
      <nav aria-label="MCP 连接列表">{snapshot?.connections.map(c=><button key={c.connection.id} disabled={busy||dirty||reviewDirty||!!confirmation} aria-current={draft.id===c.connection.id?"true":undefined} onClick={()=>choose(snapshot,c.connection.id)}><span>{c.connection.name}</span><small>{c.enabled?"有启用修订":"未启用"} · 修订 {c.revision}</small></button>)}</nav>
      <div className="configuration-document">
        {current&&<section aria-label="连接状态与使用位置">
          <p>来源：用户配置 · {current.connection.transport==="stdio"?"本地沙箱程序":"HTTP 服务"} · 场景 {pkg?.title??current.connection.package.id}</p>
          <p>认证：{current.credentialConfigured?"凭证已存入安全存储；不代表当前认证成功":"未配置凭证；服务可能允许匿名访问"}。</p>
          <p>连接测试：{current.inspection?.lastTest?.revision===current.revision?(current.inspection.lastTest.success?"本修订最近一次测试通过":"本修订最近一次测试失败"):"当前修订尚无有效测试记录"}。测试结果不是持续在线保证，保存不会连接服务。</p>
          {current.inspection?.lastTest&&<p className="configuration-meta">修订 {current.inspection.lastTest.revision} · {current.inspection.lastTest.at}{!current.inspection.lastTest.success&&" · "+current.inspection.lastTest.recovery}</p>}
          <p>运行生效：{current.effective?"修订 "+current.effective.revision+" · "+current.effective.tools.filter(t=>t.enabled).length+" 个工具":"未启用"}{current.effective&&current.effective.revision!==current.revision?"；编辑中的新修订尚未替换它":""}。</p>
          {current.inspection&&<details><summary>连接历史与任务使用 · {current.inspection.runCount} 个绑定</summary><p>最近 20 条；绑定表示任务固定过该修订，不表示工具已实际执行。停用连接后既有任务也不能继续调用。</p>{current.inspection.runs.map(r=><p key={r.runId}>{r.runId} · 修订 {r.revision}</p>)}{current.inspection.history.map((r,i)=><p key={i}>{r.at} · 修订 {r.revision} · {{save:"保存",test:"测试",activate:"启用",disable:"停用",delete:"移除"}[r.operation]??r.operation} · {r.success?"已完成":"失败"}</p>)}</details>}
        </section>}
        <fieldset disabled={busy||!!confirmation}>
        <label>连接名称<input value={draft.name} maxLength={256} onChange={e=>patch({name:e.target.value})}/></label>
        <label>连接方式<select value={draft.transport} onChange={e=>{patch({transport:e.target.value as McpConnection["transport"],endpoint:""});setCredential("");setClearCredential(true);}}><option value="streamable-http">HTTP 服务</option><option value="stdio">本地 stdio 程序（沙箱）</option></select></label>
        {draft.transport==="streamable-http"?<>
        <label>服务地址<input type="url" placeholder="https://your-service.example/mcp" value={draft.endpoint} onChange={e=>patch({endpoint:e.target.value})}/></label>
        <label>绑定的目标 IP（可选，用逗号分隔）<input maxLength={1500} aria-invalid={!!addressError} aria-describedby="mcp-address-help mcp-address-error" value={draft.destinationAddresses===undefined?"":addressText} onChange={e=>{setAddressText(e.target.value);patch({destinationAddresses:e.target.value.split(",").map(v=>v.trim()).filter(Boolean)});}}/></label>
        <p id="mcp-address-error" role={addressError?"alert":undefined}>{addressError}</p>
        <p id="mcp-address-help" className="configuration-meta">内网域名需明确填写其 IP；填写后只允许这些解析地址，仍使用服务域名验证 TLS。留空不允许域名转向内网。保存不会连接服务，新配置需测试并启用，已有任务保持原修订。</p>
        <p className="configuration-meta">Streamable HTTP，支持 JSON 与有界 SSE 响应。不跟随重定向。</p></>:<>
        <label>可执行文件绝对路径<input value={draft.executable??""} onChange={e=>patch({executable:e.target.value})}/></label>
        <label>工作目录绝对路径<input value={draft.workingDirectory??""} onChange={e=>patch({workingDirectory:e.target.value})}/></label>
        <label>启动参数（每行一项，不经 shell 解释）<textarea rows={3} value={(draft.arguments??[]).join("\n")} onChange={e=>patch({arguments:e.target.value.split("\n")})}/></label>
        <label>允许读取的目录（每行一项）<textarea rows={3} value={(draft.readPaths??[]).join("\n")} onChange={e=>patch({readPaths:e.target.value.split("\n").filter(Boolean)})}/></label>
        <label>允许写入的目录（每行一项，可留空）<textarea rows={3} value={(draft.writePaths??[]).join("\n")} onChange={e=>patch({writePaths:e.target.value.split("\n").filter(Boolean)})}/></label>
        <p>本地程序断网运行，不接收明文凭证或继承宿主环境。需要网络和凭证的服务请使用 HTTP 接入。测试会执行程序，并授予这里列出的文件访问范围；不能证明沙箱有效时拒绝启动。</p>
        </>}
        <label>适用场景<select value={JSON.stringify(draft.package)} onChange={e=>{const p=snapshot!.packages.find(p=>JSON.stringify(p.package)===e.target.value)!;patch({package:p.package,authorizationAction:p.actions[0]??"",capability:p.capabilities[0]??""});}}>{snapshot?.packages.map(p=><option key={JSON.stringify(p.package)} value={JSON.stringify(p.package)}>{p.title} · {p.package.version}</option>)}</select></label>
        <label>需要的授权动作<select value={draft.authorizationAction} onChange={e=>patch({authorizationAction:e.target.value})}>{pkg?.actions.map(a=><option key={a}>{a}</option>)}</select></label>
        <label>提供给工作任务的能力<select value={draft.capability} onChange={e=>patch({capability:e.target.value})}>{pkg?.capabilities.map(c=><option key={c}>{c}</option>)}</select></label>
        {draft.transport==="streamable-http"&&<label>Bearer 凭证（可选，仅写入安全存储）<input type="password" autoComplete="new-password" disabled={!snapshot?.secureStorage} value={credential} placeholder={current?.credentialConfigured?"已保存；留空保留":"未设置"} onChange={e=>{setCredential(e.target.value);setDirty(true);}}/></label>}
        {!snapshot?.secureStorage&&<p>当前宿主未提供操作系统安全存储，不能保存凭证。</p>}
        {current?.credentialConfigured&&<label className="configuration-check"><input type="checkbox" checked={clearCredential} onChange={e=>{setClearCredential(e.target.checked);setDirty(true);}}/>清除新修订的凭证（旧任务保留原绑定）</label>}
        <div className="configuration-actions"><button disabled={!dirty&&!reviewDirty} onClick={()=>void perform({operation:"save",expectedRevision:current?.revision??0,connection:draft,...(credential?{credential}:{}),clearCredential})}>保存连接</button>
          <button disabled={dirty||reviewDirty||!current} onClick={()=>setConfirmation("test")}>测试并发现工具</button></div>
        {current?.effective&&<details><summary>当前生效：修订 {current.effective.revision}</summary><pre tabIndex={0}>{JSON.stringify(current.effective,null,2)}</pre></details>}
        {reviewDirty&&<p>{current?.reviewedTools.length?"已审核修订不能直接修改工具选择。请先保存新修订，再测试并重新选择工具。":"选择所需工具和资源授权后，点击“审核并启用”完成接入。"}</p>}
        {current?.catalog&&<><h3>审核工具</h3><p>{current.catalog.serverName} · {current.catalog.serverVersion}。远端描述不是授权依据。所有调用均保留宿主审批；只有勾选的工具能进入新任务。</p>
          <p className="configuration-meta">当前输入适配支持封闭的扁平文本、数字、布尔值及文本列表。资源参数必须绑定场景资源种类；不支持的输入契约会拒绝启用。</p>
          {current.catalog.tools.map(tool=>{const r=reviews.find(r=>r.name===tool.name);if(!r)return null;const fields=Object.keys((tool.inputSchema.properties as object)??{});return <details key={tool.name}><summary>{tool.name} · {r.enabled?"已选择":"未选择"}</summary>
            <label className="configuration-check"><input type="checkbox" checked={r.enabled} onChange={e=>review(r.name,{enabled:e.target.checked})}/>允许此工具</label>
            <pre tabIndex={0} aria-label={`${tool.name} 输入契约`}>{JSON.stringify(tool.inputSchema,null,2)}</pre>
            {fields.map(field=><label key={field}>{field} 的资源授权<select value={r.resources.find(v=>v.field===field)?.kind??""} onChange={e=>review(r.name,{resources:[...r.resources.filter(v=>v.field!==field),...(e.target.value?[{field,kind:e.target.value}]:[])]})}><option value="">普通参数（不代表资源授权）</option>{pkg?.resourceKinds.map(kind=><option key={kind}>{kind}</option>)}</select></label>)}
          </details>;})}<button disabled={dirty||!!(reviewDirty&&current.reviewedTools.length)||!reviews.some(r=>r.enabled)} onClick={()=>setConfirmation("activate")}>审核并启用</button></>}
        {current&&<div className="configuration-actions"><button disabled={!current.enabled||dirty||reviewDirty} onClick={()=>void perform({operation:"disable",id:draft.id,expectedRevision:current.revision})}>停用连接</button><button onClick={()=>setConfirmation("delete")}>删除连接</button></div>}
      </fieldset>
      {confirmation&&<div role="group" aria-label="MCP 操作确认"><p>{confirmation==="test"?(draft.transport==="stdio"?`将在沙箱中执行 ${draft.executable}，授予所列文件访问范围，读取工具目录；不会调用工具。`:`将连接 ${draft.endpoint}，发送凭证（如有），读取服务身份和工具目录；不会调用工具。`):confirmation==="activate"?"确认信任此服务及选定工具的执行能力？工具调用会把参数发送给该服务，场景授权与宿主审批仍然有效。":confirmation==="delete"?"确认删除并立即停止此连接的新调用？历史修订与审计保留。":"重新读取会丢弃未保存的连接和工具选择。"}</p>
        <button disabled={busy} onClick={()=>{if(confirmation==="reload")void perform();else if(current)void perform(confirmation==="activate"?{operation:"activate",id:draft.id,expectedRevision:current.revision,catalogDigest:current.catalog!.digest,tools:reviews,confirmed:true}:{operation:confirmation,id:draft.id,expectedRevision:current.revision,confirmed:true});}}>确认{confirmation==="test"?"测试":confirmation==="activate"?"启用":confirmation==="delete"?"删除":"重新读取"}</button><button disabled={busy} onClick={()=>setConfirmation(null)}>取消操作</button>
      </div>}</div>
    </div>}
  </section>;
}
