import { describe, it, expect } from "vitest";
import { makeExtractApiEndpointsTool } from "@traceforge/extension";
import { realLlmProviderForTest } from "./real-llm-test-provider.js";
import type { TrafficEntry, Fact, TimelineEntry } from "@traceforge/shared";
import type { EndpointAnalyzer } from "@traceforge/extension";

describe("extract_api_endpoints LLM deep analysis", () => {
  it("extracts endpoints and parameters from JS code without fabricating", async () => {
    const facts: Fact[] = [];
    const timeline: TimelineEntry[] = [];
    const traffic: TrafficEntry[] = [
      {
        id: "traf_js",
        caseId: "c",
        url: "https://t.com/static/app.js",
        method: "GET",
        requestHeaders: {},
        requestBody: null,
        responseStatus: 200,
        responseBody: `
          const API = {
            login: "/api/login",
            register: "/api/register"
          };
          function doLogin() {
            return fetch(API.login, {
              method: "POST",
              body: JSON.stringify({ username, password })
            });
          }
          function doRegister() {
            return fetch(API.register, {
              method: "POST",
              body: JSON.stringify({ username, password, inviteCode })
            });
          }
        `,
        createdAt: "now",
      },
    ];

    const factStore = {
      listByCase: (_cid: string) => facts,
      getById: (id: string) => facts.find((f) => f.id === id),
      update: (_id: string, _patch: unknown) => undefined,
      create: (_caseId: string, input: Omit<Fact, "id" | "caseId" | "createdAt" | "updateCount" | "updatedAt" | "validity"> & Partial<Pick<Fact, "validity">>) => {
        const f = { id: `fact_${facts.length + 1}`, caseId: "c", createdAt: "now", updateCount: 0, updatedAt: "", validity: "valid" as const, ...input } as Fact;
        facts.push(f);
        return f;
      },
    };

    const timelineStore = {
      append: (_caseId: string, eventType: string, detail: string, refId?: string | null) => {
        const t = { id: `tl_${timeline.length + 1}`, caseId: "c", eventType, detail, refId: refId ?? null, createdAt: "now" } as TimelineEntry;
        timeline.push(t);
        return t;
      },
    };

    const llm = realLlmProviderForTest();
    const analyze: EndpointAnalyzer = async (text, context) => {
      const res = await llm.extractJson({
        system: `你是 API 端点提取器。给定一段原始文本（HTTP 响应体或 JS 代码），只提取其中明确出现的 API 端点和参数。禁止编造、推断或补全未在文本中出现的内容。对每个候选必须给出逐字证据片段。`,
        user: `来源类型：${context.sourceType}\n基础 URL：${context.baseUrl ?? "无"}\n\n原始文本：\n${text.slice(0, 20000)}`,
        schema: {
          type: "object",
          properties: {
            endpoints: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  url: { type: "string" },
                  method: { type: "string" },
                  parameters: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        name: { type: "string" },
                        required: { type: "boolean" },
                        location: { type: "string" },
                        note: { type: "string" },
                      },
                      required: ["name"],
                    },
                  },
                  evidence: { type: "string", description: "从原始文本中逐字拷贝的片段" },
                },
                required: ["url", "evidence"],
              },
            },
          },
          required: ["endpoints"],
        },
      });
      return (((res as { endpoints?: Array<{ url: string; method?: string; parameters?: Array<{ name: string; required?: boolean; location?: string; note?: string }>; evidence: string }> }).endpoints) ?? []).map((e) => ({
        url: e.url,
        method: e.method,
        evidence: e.evidence,
        parameters: e.parameters?.map((p) => ({
          name: p.name,
          required: p.required,
          location: ["query", "body", "path"].includes(p.location ?? "") ? (p.location as "query" | "body" | "path") : undefined,
          note: p.note,
        })),
      }));
    };

    const tool = makeExtractApiEndpointsTool("c", [{ caseId: "c", allowHosts: ["t.com"], denyHosts: [] }], {
      traffic: { listByCase: (_cid: string) => traffic },
      facts: factStore,
      timeline: timelineStore,
      emit: () => {},
      analyze,
    });

    const res = await tool.execute({ deep: true });
    expect(res.ok).toBe(true);

    const titles = facts.map((f) => f.title);
    expect(titles).toContain("https://t.com/api/login");
    expect(titles).toContain("https://t.com/api/register");
    expect(titles.some((t) => t.includes("fabricated") || t.includes("/api/secret"))).toBe(false);

    const loginFact = facts.find((f) => f.title === "https://t.com/api/login");
    expect(loginFact).toBeDefined();
    expect(loginFact?.type).toBe("login_endpoint");
    expect(loginFact?.source.type).toBe("ai");
    expect(loginFact?.tags).toContain("llm-assisted");
    const loginParams = (loginFact?.value as { parameters?: { name: string }[] }).parameters ?? [];
    expect(loginParams.map((p) => p.name)).toContain("username");
    expect(loginParams.map((p) => p.name)).toContain("password");
  }, 60000);
});
