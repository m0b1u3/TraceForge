import { describe, it, expect, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { createDb } from "./db/client.js";
import { EventBus } from "./event-bus.js";
import { registerRoutes } from "./routes.js";
import { realLlmProviderForTest } from "./real-llm-test-provider.js";
import type { RuntimeEvent } from "@traceforge/shared";
import type { LlmProvider, ExtractJsonArgs, RunToolsArgs, RunTurn } from "@traceforge/extension";

let app: FastifyInstance;
let events: RuntimeEvent[];
let caseId: string;

async function waitFor(predicate: () => boolean, timeoutMs = 60000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("timed out waiting for background agent run");
}

function scriptedAuthPivotProvider(): LlmProvider {
  const real = realLlmProviderForTest();
  const turns: RunTurn[] = [
    {
      text: "登录接口常见凭据测试失败，记录阻塞原因。",
      toolCalls: [
        {
          id: "tc_block",
          name: "record_fact",
          input: {
            type: "finding",
            title: "登录接口常见凭据失败且返回 403",
            value: {
              detail: "尝试 admin/admin、test/test 等常见/弱口令均返回 403，登录接口无法继续测试",
              statusCode: 403,
            },
          },
        },
      ],
      done: false,
    },
    {
      text: "登录接口已阻塞，准备 pivot 到相邻认证攻击面。",
      toolCalls: [
        {
          id: "tc_pivot",
          name: "record_fact",
          input: {
            type: "api_endpoint",
            title: "发现注册接口作为 pivot 目标",
            value: {
              path: "/api/register",
              note: "登录接口凭据测试失败后，pivot 到相邻认证面（注册接口）继续分析",
            },
          },
        },
      ],
      done: false,
    },
    {
      text: "已记录阻塞原因并 pivot 到注册接口，完成当前分析。",
      toolCalls: [],
      done: true,
    },
  ];
  let turnIndex = 0;
  return {
    extractJson: async (args: ExtractJsonArgs) => real.extractJson(args),
    runTools: async (_args: RunToolsArgs): Promise<RunTurn> => {
      const turn = turns[turnIndex] ?? turns[turns.length - 1]!;
      turnIndex++;
      return turn;
    },
  };
}

beforeEach(async () => {
  app = Fastify();
  const db = createDb(":memory:");
  const bus = new EventBus();
  events = [];
  bus.subscribe((e) => events.push(e));
  const provider = scriptedAuthPivotProvider();
  registerRoutes(app, db, bus, provider);
  await app.ready();
  caseId = (await app.inject({ method: "POST", url: "/api/cases", payload: { name: "auth pivot", allowHosts: ["t.com"] } })).json().id;
  events.length = 0;
});

describe("agent auth pivot observer review", () => {
  it("does not critical-interrupt a justified pivot after recording blocked-auth fact", { retry: 2, timeout: 60000 }, async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/cases/${caseId}/agent/run`,
      payload: {
        goal: "测试 t.com 的登录接口；若常见凭据失败则记录阻塞原因并 pivot 到相邻认证攻击面（如注册接口）",
        budget: { maxTurns: 4, warningTurnsRemaining: 1 },
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().run.id).toMatch(/^run_/);

    await waitFor(() => events.some((e) => e.type === "agent_run_completed" || e.type === "agent_run_interrupted"));

    expect(events.some((e) => e.type === "agent_run_needs_confirmation")).toBe(false);
    expect(events.some((e) => e.type === "agent_run_interrupted")).toBe(false);
    expect(events.some((e) => e.type === "agent_run_completed")).toBe(true);

    const warningsRes = await app.inject({ method: "GET", url: `/api/cases/${caseId}/warnings` });
    expect(warningsRes.statusCode).toBe(200);
    const body = warningsRes.json() as { warnings: { level: string; title: string; evidence?: string }[] };
    expect(body.warnings.some((w) => w.level === "critical")).toBe(false);
  });
});
