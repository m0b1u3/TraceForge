export type { ToolResult, ToolDescriptor, NativeToolDef } from "./tool.js";
export { ToolRegistry } from "./registry.js";
export { ApprovalGate, type ApprovalDecision, type ApprovalAsker } from "./approval-gate.js";
export type {
  LlmProvider, ExtractJsonArgs, ToolCall, TurnMessage, RunTurn, RunToolsArgs,
} from "./provider.js";
export { AgentRuntime, type AgentEvent } from "./agent-runtime.js";
export { makeHttpReplayTool, makeProposeScopeExpansionTool } from "./builtin-tools.js";
export {
  makeListTrafficTool, makeGetTrafficTool, type TrafficReader,
  makeRecordFactTool, makeRecordTaskTool, makeRecordActionTool,
  type FactWriter, type TaskWriter, type ActionWriter, type DecisionWriter, type TimelineWriter, type Emit,
} from "./case-tools.js";
