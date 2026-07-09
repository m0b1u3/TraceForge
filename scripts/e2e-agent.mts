// 端到端：真实 LLM 用完整 case 工具集自主工作（看流量/重放/记 Fact）
// 用法：先配置 config/llm.json（apiKey 直接写在文件中），然后：
//   node --import tsx scripts/e2e-agent.mts
// 用内存 store 假实现演示 agent 闭环（生产由 server 路由用真实 store）。
import { randomUUID } from "node:crypto";
import { loadLlmConfig, createProvider } from "../packages/llm/src/index.js";
import {
  ToolRegistry, ApprovalGate, AgentRuntime,
  makeHttpReplayTool, makeProposeScopeExpansionTool,
  makeRecordFactTool,
} from "../packages/extension/src/index.js";
import { FactSchema, type Fact, type ScopeRule } from "../packages/shared/src/index.js";

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
  console.error(`✗ ${(e as Error).message}（请在 config/llm.json 中填写 apiKey）`);
  process.exit(1);
}

const scopeRules: ScopeRule[] = [{ caseId: "e2e", allowHosts: ["example.com"], denyHosts: [] }];

// 内存 store 假实现
const factArr: Fact[] = [];
const memFacts = {
  create: (caseId: string, input: Omit<Fact, "id" | "caseId" | "createdAt">) => {
    const f = FactSchema.parse({ ...input, id: `fact_${randomUUID()}`, caseId, createdAt: new Date().toISOString() });
    factArr.push(f); return f;
  },
  listByCase: (caseId: string) => factArr.filter((f) => f.caseId === caseId),
};
const memTimeline = { append: (caseId: string, eventType: string, detail: string, refId?: string) => ({ id: `tl_${randomUUID()}`, caseId, eventType, refId: refId ?? null, detail, createdAt: "now" }) };

const registry = new ToolRegistry();
registry.register(makeHttpReplayTool(scopeRules));
registry.register(makeRecordFactTool("e2e", memFacts, memTimeline, () => {}));
registry.register(makeProposeScopeExpansionTool((host, reason) => console.error(`  [scope proposal] ${host} — ${reason}`)));

const gate = new ApprovalGate(async () => "approved");

const system = `你是 TraceForge 的授权渗透测试 agent。授权范围只有 example.com。
你可以用 http_replay 重放请求、用 record_fact 记录发现。完成后用一句话总结。`;

const goal = "向 https://example.com/ 发一个 GET 请求查看响应，然后把这个端点用 record_fact 记录为一个 Fact（type 用 api_endpoint）。";

console.error(`\n=== 目标 ===\n${goal}\n=== LLM 开始自主工作 ===`);

await new AgentRuntime(provider, registry, gate).run(system, goal, (e) => {
  if (e.type === "tool_call") console.error(`  → LLM 调用 ${e.name}(${e.content})`);
  else if (e.type === "tool_result") console.error(`  ← 返回: ${e.content}`);
  else if (e.type === "tool_rejected") console.error(`  ✗ 被拒: ${e.name}`);
  else if (e.type === "text") console.error(`  [LLM] ${e.content}`);
  else if (e.type === "done") console.error(`\n=== 完成 ===`);
});

console.error(`\n=== 落库的 Fact (${factArr.length}) ===`);
for (const f of factArr) console.error(`  ${f.id} [${f.type}] ${f.title}`);
