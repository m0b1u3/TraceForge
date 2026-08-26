export type {
  ToolResult, ToolDescriptor, NativeToolDef, ToolExecutionMode,
  ToolCapability, ToolImpactScope, ToolSecurityProfile,
} from "./tool.js";
export { TOOL_SECURITY } from "./tool.js";
export { ToolRegistry } from "./registry.js";
export type {
  LlmProvider, ExtractJsonArgs, ToolCall, TurnMessage, RunTurn, RunToolsArgs, StreamToolsHandlers, UsageSnapshot, EmbedArgs,
} from "./provider.js";
export {
  diagnoseToolFailure,
  failureClassFromDiagnostic,
  type ToolFailureClass,
  type ToolFailureHint,
} from "./tool-failure-diagnostic.js";
export { compareTrafficResponses, makeCompareIdentityTrafficTool, makeHttpReplayTool, makeProposeScopeExpansionTool, makeReplayTrafficTool } from "./builtin-tools.js";
export {
  assessValidationExperiment,
  makeAssessValidationExperimentTool,
  type ValidationAssessment,
  type ValidationVerdict,
} from "./validation-tools.js";
export { makeListIdentitiesTool, makeRecordIdentityTool, makeUseBrowserIdentityTool } from "./identity-tools.js";
export type { IdentityWriter, BrowserIdentityController } from "./identity-tools.js";
export { makeListAttackPathsTool, makeRecordAttackPathTool } from "./attack-path-tools.js";
export type { AttackPathWriter } from "./attack-path-tools.js";
export { makeListSecurityReportsTool, makeRecordSecurityReportTool } from "./security-report-tools.js";
export type { SecurityReportWriter } from "./security-report-tools.js";
export { BROWSER_TOOL_NAMES, makeBrowserTools, type BrowserController } from "./browser-tools.js";
export { loadMcpConfig, McpServerConfigSchema, McpConfigSchema, type McpServerConfig } from "./mcp-config.js";
export { mcpToolToDescriptor, type McpToolHandle, type McpCaller } from "./mcp-tools.js";
export { McpManager, type McpClient, type McpClientFactory } from "./mcp-manager.js";
export { makeReevaluateFactsTool, type ReevaluateFactsInput, type FactStoreLike } from "./tools/reevaluate-facts.js";
export {
  makeListTrafficTool, makeGetTrafficTool, type TrafficReader,
  makeRecordFactTool, makeRecordTaskTool, makeRecordActionTool,
  makeReopenTaskTool, makeRevertDoneTaskTool, makeExtractApiEndpointsTool,
  type TaskStatusReader, type StatusWriter,
  type TaskCompletionGate, type TaskCompletionGateResult, type TaskStatusGate, type TaskStatusGateResult,
  type FactWriter, type TaskWriter, type ActionWriter, type DecisionWriter, type TimelineWriter, type Emit,
  type EndpointExtractorDeps, type EndpointAnalyzer, type LlmEndpointCandidate, type EndpointParameter,
} from "./case-tools.js";
export { makeUpdateSessionStateTool, makeRecordHypothesisTool, makeResolveHypothesisTool } from "./cognitive-tools.js";
export type { SessionStateWriter, HypothesisWriter, FactReader } from "./cognitive-tools.js";
export { makeDownloadTool, type DownloadFetcher, type DownloadToolDeps } from "./download-tool.js";
export * from "./query-expander.js";
