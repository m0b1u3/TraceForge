import React from "react";
import type { ModelConfigInput } from "./model-settings-client";

type Options = NonNullable<ModelConfigInput["requestOptions"]>;
export function ModelRequestOptions({protocol,value = {},onChange}: {
  protocol:ModelConfigInput["provider"]; value?:Options; onChange:(value:Options)=>void;
}) {
  return <details className="model-advanced"><summary>推理与兼容参数</summary>
    <div className="model-fields">
      {protocol !== "responses" && <label>思考模式<select aria-label="思考模式" value={value.thinking ?? ""}
        onChange={event=>onChange({...value,thinking:(event.target.value || undefined) as Options["thinking"]})}>
        <option value="">供应商默认</option><option value="enabled">开启</option><option value="disabled">关闭</option>
      </select></label>}
      {protocol !== "anthropic" && <label>推理强度<select aria-label="推理强度" value={value.reasoningEffort ?? ""}
        onChange={event=>onChange({...value,reasoningEffort:(event.target.value || undefined) as Options["reasoningEffort"]})}>
        <option value="">供应商默认</option>{["none","minimal","low","medium","high","max"].map(level=><option key={level} value={level}>{level}</option>)}
      </select></label>}
      <label>温度<input aria-label="温度" type="number" min={0} max={2} step={0.1} value={value.temperature ?? ""} placeholder="供应商默认"
        onChange={event=>onChange({...value,temperature:event.target.value === "" ? undefined : Number(event.target.value)})} /></label>
      {protocol === "responses" && <label>加密推理续接<select aria-label="加密推理续接" value={value.includeReasoningContinuation === undefined ? "" : String(value.includeReasoningContinuation)}
        onChange={event=>onChange({...value,includeReasoningContinuation:event.target.value === "" ? undefined : event.target.value === "true"})}>
        <option value="">连接默认</option><option value="true">请求续接数据</option><option value="false">不请求</option>
      </select></label>}
    </div>
    <p className="field-help">只填写当前模型支持的参数，留空使用默认值。Messages 开启思考使用 adaptive 模式；不支持时请保持默认。加密续接数据仅供模型多轮调用，不显示为思考正文。保存后用于后续调用。</p>
  </details>;
}
