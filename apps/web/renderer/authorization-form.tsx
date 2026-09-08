import React, { useState } from "react";
import { CaretRight, Shield } from "@phosphor-icons/react";
import { AuthorizationFormSchema, AuthorizationReviewSchema, buildAuthorizationScope } from "@traceforge/shared/authorization-form";

/** Operate revision: compact paper/ink authorization, one stage at a time.
 * Primary fields lead; optional fields disclose; review replaces editing.
 * Scope strings are literals. Scenario supplies copy; this renderer grants nothing.
 * Registration never starts a Run. Changes replace the review, not its consent. */
export function AuthorizationForm({ contract, policy, disabled, register }: {
  contract: unknown; policy: unknown; disabled: boolean;
  register(scope: Record<string, unknown>, expiresAt: string): Promise<boolean>;
}) {
  const parsed = AuthorizationFormSchema.safeParse(contract);
  const rules = AuthorizationReviewSchema.safeParse(policy);
  const [inputs, setInputs] = useState<string[]>([]), [error, setError] = useState("");
  const [review, setReview] = useState<{ scope: Record<string, unknown>; expiresAt: string } | null>(null);
  const [accepted, setAccepted] = useState(false);
  if (!parsed.success || !rules.success) return <p role="alert">此场景的授权表单或规则格式不受支持，请联系场景维护者。未登记任何授权。</p>;
  const form = parsed.data;
  const renderField = (field: typeof form.fields[number], index: number) => <label key={JSON.stringify(field.path)}>
    <span className="authorization-field-title">{field.label}{field.required && <span className="authorization-help">必填</span>}</span>
    <textarea rows={2} value={inputs[index] ?? ""} maxLength={32768} onChange={event => {
      setInputs(previous => { const next = [...previous]; next[index] = event.target.value; return next; });
      setReview(null); setAccepted(false); setError("");
    }} />
    <span className="authorization-help">{field.description}</span>
  </label>;
  return <div className="authorization-form">
    <h3 className="authorization-card-title"><Shield aria-hidden="true" />{review ? "确认访问范围" : "设置访问范围"}</h3>
    <fieldset disabled={disabled}>
      {!review && <>
      <p className="authorization-intro">{form.description}</p>
      {form.fields.map((field, index) => !field.advanced || field.required ? renderField(field, index) : null)}
      {form.fields.some(field => field.advanced && !field.required) && <details className="authorization-options">
        <summary><CaretRight className="disclosure-caret" aria-hidden="true" />更多范围选项</summary>
        <div>{form.fields.map((field, index) => field.advanced && !field.required ? renderField(field, index) : null)}</div>
      </details>}
      <div className="authorization-footer"><span className="authorization-help">有效一小时 · 不会自动启动</span>
      <button className="primary" onClick={() => {
        try { setReview({ scope: buildAuthorizationScope(form, inputs), expiresAt: new Date(Date.now() + 3600000).toISOString() }); setAccepted(false); setError(""); }
        catch (value) { setError(value instanceof Error ? value.message : "无法生成授权，请检查输入。"); }
      }}>核对授权</button>
      </div></>}
      {review && <section className="authorization-review" aria-label="待登记授权">
        <dl>{form.fields.map(field => {
          let value: unknown = review.scope;
          for (const part of field.path) value = (value as Record<string, unknown>)[part];
          if (!(value as string[]).length) return null;
          return <React.Fragment key={JSON.stringify(field.path)}><dt>{field.label}</dt><dd>
            {(value as string[]).map((item, index) => <div key={index}>{item}</div>)}</dd></React.Fragment>;
        })}</dl>
        <p className="authorization-help">未填写的范围不会新增资源权限。</p>
        <div className="authorization-permissions"><span className="authorization-help">允许的操作</span><p>{rules.data.allowedActions.map(action => form.actionLabels?.[action] ?? action).join("、") || "没有允许的动作"}</p></div>
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
          if (await register(review.scope, review.expiresAt)) { setReview(null); setAccepted(false); setInputs([]); }
        }}>确认登记授权</button>
        </div>
        <p className="authorization-help authorization-expiry">有效至 {new Date(review.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · 不会自动启动</p>
      </section>}
    </fieldset>
    {error && <p role="alert">{error}</p>}
  </div>;
}
