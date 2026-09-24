import React, { useEffect, useState } from "react";
import { CaretRight, Shield } from "@phosphor-icons/react";
import { AuthorizationFormSchema, AuthorizationReviewSchema, buildAuthorizationScope } from "@traceforge/shared/authorization-form";

/** Operate revision: compact paper/ink authorization, one stage at a time.
 * Primary fields lead; optional fields disclose; review replaces editing.
 * Scope strings are literals. Scenario supplies copy; this renderer grants nothing.
 * Registration never starts a Run. Changes replace the review, not its consent. */
export function AuthorizationForm({ contract, policy, disabled, register, initialScope, expiresAt, submitLabel = "确认登记授权", continuesWork = false, startsWork = false }: {
  contract: unknown; policy: unknown; disabled: boolean;
  register(scope: Record<string, unknown>, expiresAt: string): Promise<boolean>;
  initialScope?: Record<string,unknown>;
  expiresAt?: string;
  submitLabel?: string;
  continuesWork?: boolean;
  startsWork?: boolean;
}) {
  const parsed = AuthorizationFormSchema.safeParse(contract);
  const rules = AuthorizationReviewSchema.safeParse(policy);
  const [inputs, setInputs] = useState<string[]>(() => parsed.success ? parsed.data.fields.map(field => {
    let value:unknown=initialScope; for(const part of field.path)value=value&&typeof value==="object"?(value as Record<string,unknown>)[part]:undefined;
    return field.type==="integer"?String(value??field.defaultValue??""):field.type==="boolean" ? String(value===true || !initialScope && field.defaultEnabled===true) : Array.isArray(value)&&value.every(item=>typeof item==="string")?value.join("\n"):"";
  }) : []), [error, setError] = useState("");
  const [review, setReview] = useState<{ scope: Record<string, unknown>; expiresAt: string } | null>(null);
  const [accepted, setAccepted] = useState(false);
  const [actions, setActions] = useState<string[]>(() => Array.isArray(initialScope?.authorizedActions)
    ? initialScope.authorizedActions.filter((value): value is string => typeof value === "string") : []);
  const reviewIdentity = JSON.stringify([contract, policy, initialScope, expiresAt]);
  useEffect(() => { setReview(null); setAccepted(false); }, [reviewIdentity]);
  if (!parsed.success || !rules.success) return <p role="alert">此场景的授权表单或规则格式不受支持，请联系场景维护者。未登记任何授权。</p>;
  const form = parsed.data;
  const renderField = (field: typeof form.fields[number], index: number) => <label key={JSON.stringify(field.path)}>
    <span className="authorization-field-title">{field.label}{field.required && <span className="authorization-help">必填</span>}</span>
    {field.type === "integer" ? <input type="number" min={field.minimum} max={field.maximum} step={1} value={inputs[index]??String(field.defaultValue??"")} onChange={event=>{
      setInputs(previous=>{const next=[...previous];next[index]=event.target.value;return next;});setReview(null);setAccepted(false);setError("");
    }}/> : field.type === "boolean" ? <input type="checkbox" checked={inputs[index] === "true"} onChange={event => {
      setInputs(previous => { const next = [...previous]; next[index] = String(event.target.checked); return next; });
      setReview(null); setAccepted(false); setError("");
    }} /> : <textarea rows={2} value={inputs[index] ?? ""} maxLength={32768} onChange={event => {
      setInputs(previous => { const next = [...previous]; next[index] = event.target.value; return next; });
      setReview(null); setAccepted(false); setError("");
    }} />}
    <span className="authorization-help">{field.description}</span>
    {field.type==="integer"&&<span className="authorization-help">{field.defaultValue === undefined ? "可选，未填写时不设置此项。" : `允许 ${field.minimum}–${field.maximum}，默认 ${field.defaultValue}`}</span>}
  </label>;
  return <div className="authorization-form">
    <h3 className="authorization-card-title"><Shield aria-hidden="true" />{review ? "确认访问范围" : "设置访问范围"}</h3>
    <fieldset disabled={disabled}>
      {!review && <>
      <p className="authorization-intro">{form.description}</p>
      {rules.data.actionSelection && <fieldset className="authorization-actions">
        <legend>本次允许的操作</legend>
        <p className="authorization-help">只勾选这次需要的操作。未勾选的操作会被拒绝；选择操作不会扩大下面的资源范围。</p>
        {rules.data.allowedActions.filter(action => !rules.data.deniedActions.includes(action)).map(action => <label className="execution-confirm" key={action}>
          <input type="checkbox" checked={actions.includes(action)} onChange={event => {
            setActions(previous => event.target.checked ? [...previous, action] : previous.filter(value => value !== action));
            setReview(null); setAccepted(false); setError("");
          }} />{form.actionLabels?.[action] ?? action}
        </label>)}
      </fieldset>}
      {form.fields.map((field, index) => !field.advanced || field.required ? renderField(field, index) : null)}
      {form.fields.some(field => field.advanced && !field.required) && <details className="authorization-options">
        <summary><CaretRight className="disclosure-caret" aria-hidden="true" />更多范围选项</summary>
        <div>{form.fields.map((field, index) => field.advanced && !field.required ? renderField(field, index) : null)}</div>
      </details>}
      <div className="authorization-footer"><span className="authorization-help">{expiresAt ? "保持原授权有效期" : "有效一小时"} · {startsWork ? "确认后执行本条任务" : continuesWork ? "确认后继续原工作" : "不会自动启动"}</span>
      <button className="primary" onClick={() => {
        try {
          if (rules.data.actionSelection && actions.some(action => !rules.data.allowedActions.includes(action) || rules.data.deniedActions.includes(action))) throw new Error("可选操作已变化，请重新打开授权表单。");
          setReview({ scope: { ...buildAuthorizationScope(form, inputs), ...(rules.data.actionSelection ? { authorizedActions: rules.data.allowedActions.filter(action => actions.includes(action)) } : {}) }, expiresAt: expiresAt ?? new Date(Date.now() + 3600000).toISOString() }); setAccepted(false); setError(""); }
        catch (value) { setError(value instanceof Error ? value.message : "无法生成授权，请检查输入。"); }
      }}>核对授权</button>
      </div></>}
      {review && <section className="authorization-review" aria-label="待登记授权">
        <dl>{form.fields.map(field => {
          let value: unknown = review.scope;
          for (const part of field.path) value = (value as Record<string, unknown>)[part];
          if (field.type === "integer") return <React.Fragment key={JSON.stringify(field.path)}><dt>{field.label}</dt><dd>{value === undefined ? "未设置" : String(value)}</dd></React.Fragment>;
          if (field.type === "boolean") return <React.Fragment key={JSON.stringify(field.path)}><dt>{field.label}</dt><dd>{value === true ? "已允许" : "未允许，仍需逐次审批"}</dd></React.Fragment>;
          if (!(value as string[]).length) return null;
          return <React.Fragment key={JSON.stringify(field.path)}><dt>{field.label}</dt><dd>
            {(value as string[]).map((item, index) => <div key={index}>{item}</div>)}</dd></React.Fragment>;
        })}</dl>
        <p className="authorization-help">未填写的范围不会新增资源权限。</p>
        <div className="authorization-permissions"><span className="authorization-help">允许的操作</span><p>{(rules.data.actionSelection ? review.scope.authorizedActions as string[] : rules.data.allowedActions).map(action => form.actionLabels?.[action] ?? action).join("、") || "没有允许的动作"}</p></div>
        {rules.data.actionSelection && <p className="authorization-help">未勾选的操作均不授权。模型请求或自动执行设置不能改变此限制。</p>}
        {rules.data.deniedActions.length > 0 && <p>禁止：{rules.data.deniedActions.map(action => form.actionLabels?.[action] ?? action).join("、")}</p>}
        {rules.data.resources.some(rule => rule.values?.length || rule.prefixValues?.length) && <>
          <h3>场景预设的资源范围</h3><p>这些范围由已安装场景固定声明，也包含在本次授权中。</p>
          <ul>{rules.data.resources.flatMap((rule, index) => [
            ...(rule.values ?? []).map(value => <li key={`${index}:exact:${value}`}>{rule.kind} · 精确匹配：{value}</li>),
            ...(rule.prefixValues ?? []).map(value => <li key={`${index}:prefix:${value}`}>{rule.kind} · 前缀匹配：{value}</li>),
          ])}</ul>
        </>}
        <details className="authorization-policy"><summary><CaretRight className="disclosure-caret" aria-hidden="true" />查看完整策略（高级）</summary><pre>{JSON.stringify(policy, null, 2)}</pre></details>
        <label className="execution-confirm"><input type="checkbox" checked={accepted} onChange={event => setAccepted(event.target.checked)} />我有权授权，并确认以上范围和操作</label>
        <div className="authorization-footer"><button className="authorization-back" onClick={() => { setReview(null); setAccepted(false); }}>返回修改</button>
        <button className="primary" disabled={!accepted} onClick={async () => {
          if (Date.parse(review.expiresAt) <= Date.now()) { setReview(null); setAccepted(false); setError("本次核对已过期，请重新核对授权。"); return; }
          if (await register(review.scope, review.expiresAt)) { setReview(null); setAccepted(false); setInputs([]); setActions([]); }
        }}>{submitLabel}</button>
        </div>
        <p className="authorization-help authorization-expiry">有效至 {new Date(review.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · {startsWork ? "确认后执行本条任务" : continuesWork ? "确认后继续原工作" : "不会自动启动"}</p>
      </section>}
    </fieldset>
    {error && <p role="alert">{error}</p>}
  </div>;
}
