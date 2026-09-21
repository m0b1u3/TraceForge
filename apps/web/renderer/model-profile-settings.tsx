import React from "react";
import type { ModelProfile } from "@traceforge/shared/model-profile";
import type { ModelConfigInput } from "./model-settings-client";

export function ModelProfileSettings({form,discovered,onChange}:{form:ModelConfigInput;discovered?:ModelProfile;onChange:(value:ModelProfile|null)=>void}) {
  const profile=form.modelProfile;
  const edit=(patch:Partial<ModelProfile>)=>onChange({...profile,model:form.model,baseUrl:form.baseUrl,protocol:form.provider,source:"operator",...patch});
  const state=(value:boolean|undefined)=>value === undefined ? "" : String(value);
  const window=form.contextWindowTokens ?? profile?.contextWindowTokens ?? 32768;
  const output=form.maxOutputTokens ?? profile?.maxOutputTokens;
  return <details className="model-advanced"><summary>模型能力与自动预算</summary>
    <p className="field-help" role="status">{profile ? profile.source === "catalog" ? "来源：本次保存的供应商目录声明，并非实测结论。" : profile.source === "documentation" ? "来源：厂商文档默认值（保守取整），可手动覆盖；不代表当前账号额度。" : "来源：用户手动声明。" : "供应商未提供或尚未选择能力信息，未知不代表不支持。"}</p>
    <p className="field-help">上下文整理按 {window.toLocaleString()} tokens 计算{!form.contextWindowTokens&&!profile?.contextWindowTokens ? "（窗口未知时的估算，不作为输出限制）" : ""}。{output === undefined ? "未指定输出额度，不额外添加请求上限；Anthropic 协议需要先提供模型的输出能力声明。" : `输出参数遵循接入配置：${output.toLocaleString()} tokens，不额外压低。`}</p>
    {profile?.maxOutputTokens !== undefined && output!==undefined && output>profile.maxOutputTokens && <p className="model-error" role="alert">接入配置超出模型的输出能力声明，请核对供应商信息。</p>}
    <fieldset disabled={!form.model || !form.baseUrl}><legend className="sr-only">模型能力声明</legend><div className="model-fields">
      <label>模型窗口声明<input aria-label="模型窗口声明" type="number" min={1024} max={100000000} value={profile?.contextWindowTokens ?? ""} placeholder="未知"
        onChange={event=>edit({contextWindowTokens:event.target.value ? Number(event.target.value) : undefined})} /></label>
      <label>模型最大输出声明<input aria-label="模型最大输出声明" type="number" min={1} max={10000000} value={profile?.maxOutputTokens ?? ""} placeholder="未知"
        onChange={event=>edit({maxOutputTokens:event.target.value ? Number(event.target.value) : undefined})} /></label>
      {([["imageInput","图片输入能力"],["documentInput","PDF 输入能力"],["audioInput","音频输入能力"],["toolCalling","工具调用能力"],["reasoning","推理能力"],...(form.provider === "anthropic" ? [["adaptiveThinking","自适应思考能力"]] : [])] as Array<["imageInput"|"documentInput"|"audioInput"|"toolCalling"|"reasoning"|"adaptiveThinking",string]>).map(([key,label])=><label key={key}>{label}<select aria-label={label} value={state(profile?.[key])} onChange={event=>edit({[key]:event.target.value === "" ? undefined : event.target.value === "true"})}><option value="">未知</option><option value="true">支持</option><option value="false">不支持</option></select></label>)}
    </div></fieldset>
    <p className="field-help">当前接通图片、PDF 与文本输入；WAV/MP3 仅接通 Chat Completions 音频输入。视频、实时语音及音视频生成未接通，能力声明不会新增协议支持。</p>
    <p className="field-help">声明不支持的能力会在请求前拒绝，而不是换模型或绕过工具权限。修改后需要保存；刷新目录不会改动已保存配置或当前正在执行的调用。</p>
    <button type="button" disabled={!discovered} onClick={()=>onChange(discovered ?? null)}>使用本次目录声明</button>{" "}
    <button type="button" disabled={!profile} onClick={()=>onChange(null)}>清除能力声明</button>
  </details>;
}
