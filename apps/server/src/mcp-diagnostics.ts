/** Allowlisted diagnostics only; upstream messages/headers/credentials never enter UI or logs. */
export class McpDiagnosticError extends Error {
  constructor(readonly code:"authentication"|"http"|"transport"|"credential"|"contract",message:string){super(message);}
}
export function mcpDiagnostic(error:unknown) {
  const code=error instanceof McpDiagnosticError?error.code:"configuration";
  const recovery={authentication:"服务拒绝认证。检查或重新填写凭证，保存新修订后手动测试。",http:"服务返回非成功响应。检查服务地址及服务状态后手动测试。",transport:"连接未完成。检查网络、服务可达性和超时后手动测试。",credential:"安全存储中的凭证不可用。重新填写凭证并保存后手动测试。",contract:"服务返回的协议或工具契约不受支持。检查 MCP 版本及工具输入格式。",configuration:"操作未完成。重新读取修订，核对场景、沙箱及工具契约；未自动重试。"}[code];
  return {code,recovery};
}
