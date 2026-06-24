// 端到端：真实 LLM 自主调用 http_replay 工具
// 用法：先配置 config/llm.json + 对应 API key 环境变量，然后：
//   node --import tsx scripts/e2e-agent.mts
import { loadLlmConfig, createProvider } from "../packages/llm/src/index.js";
import {
  ToolRegistry, ApprovalGate, AgentRuntime,
  makeHttpReplayTool, makeProposeScopeExpansionTool,
} from "../packages/extension/src/index.js";
import type { ScopeRule } from "../packages/shared/src/index.js";

const config = loadLlmConfig();
if (!config) {
  console.error("✗ 未找到 config/llm.json。请先 cp config/llm.example.json config/llm.json 并按需修改。");
  process.exit(1);
}
console.error(`✓ provider=${config.provider} model=${config.model} baseUrl=${config.baseUrl ?? "(default)"}`);

let provider;
try {
  provider = createProvider(config);
} catch (e) {
  console.error(`✗ ${(e as Error).message}（请设置 ${config.apiKeyEnv} 环境变量）`);
  process.exit(1);
}

// 授权范围：只允许 example.com（演示 Scope Guard）
const scopeRules: ScopeRule[] = [{ caseId: "e2e", allowHosts: ["example.com"], denyHosts: [] }];

const registry = new ToolRegistry();
registry.register(makeHttpReplayTool(scopeRules)); // 真实 fetch
registry.register(makeProposeScopeExpansionTool((host, reason) => {
  console.error(`  [scope proposal] ${host} — ${reason}`);
}));

// 自动批准门（本演示无 command 类工具，不会触发；有也直接放行）
const gate = new ApprovalGate(async () => "approved");

const system = `你是一个授权渗透测试助手。你有一个 http_replay 工具可以重发 HTTP 请求并查看响应。
当前授权范围只有 example.com。请用工具完成用户的任务。完成后用一句话总结你的发现。`;

const goal = "请向 https://example.com/ 发一个 GET 请求，告诉我返回的状态码和响应体长度。";

console.error(`\n=== 目标 ===\n${goal}\n=== LLM 开始自主工作 ===`);

await new AgentRuntime(provider, registry, gate).run(system, goal, (e) => {
  if (e.type === "tool_call") console.error(`  → LLM 调用工具 ${e.name}(${e.content})`);
  else if (e.type === "tool_result") console.error(`  ← 工具返回: ${e.content}`);
  else if (e.type === "tool_rejected") console.error(`  ✗ 被拒: ${e.name}`);
  else if (e.type === "text") console.error(`  [LLM] ${e.content}`);
  else if (e.type === "done") console.error(`\n=== 完成 ===`);
});
