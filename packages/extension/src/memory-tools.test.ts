import { describe, it, expect } from "vitest";
import {
  makeSearchFactsTool, makeGetFactDetailTool, makeSearchTrafficTool, makeRecallConversationTool,
} from "./memory-tools.js";
import type { Fact, TrafficEntry, AgentEvent } from "@traceforge/shared";

function fact(p: Partial<Fact>): Fact {
  return { id: "f", caseId: "c", type: "note", title: "t", value: {}, source: { type: "manual", ref: "x" }, confidence: 1, tags: [], createdAt: "2026-01-01T00:00:00Z", updateCount: 0, updatedAt: "", validity: "valid", ...p } as Fact;
}

describe("search_facts", () => {
  const facts = {
    listByCase: () => [
      fact({ id: "f1", type: "login_endpoint", title: "/api/login" }),
      fact({ id: "f2", type: "api_endpoint", title: "/api/order", value: { hint: "越权线索" } }),
      fact({ id: "f3", type: "note", title: "无关页面" }),
    ],
  };
  it("matches by title/type and returns id summaries", async () => {
    const t = makeSearchFactsTool("c", facts);
    expect(t.executionMode).toBe("parallel");
    const r = await t.execute({ query: "login" });
    expect(r.ok).toBe(true);
    expect(r.content).toContain("f1");
    expect(r.content).not.toContain("f3");
  });
  it("searches inside value (not just title)", async () => {
    const t = makeSearchFactsTool("c", facts);
    const r = await t.execute({ query: "越权" });
    expect(r.content).toContain("f2");
  });
  it("empty result returns ok:true with hint", async () => {
    // 使用对测试数据真正零 bigram 命中的 facts（避免偶然碰撞）
    const emptyFacts = { listByCase: () => [] as ReturnType<typeof facts.listByCase> };
    const t = makeSearchFactsTool("c", emptyFacts);
    const r = await t.execute({ query: "任意查询" });
    expect(r.ok).toBe(true);
    expect(r.content).toContain("没有匹配");
  });
  it("multi-keyword chinese query matches when any keyword hits (no over-filtering)", async () => {
    const chineseFacts = { listByCase: () => [fact({ id: "f1", type: "login_endpoint", title: "登录接口" })] };
    const t = makeSearchFactsTool("c", chineseFacts);
    const r = await t.execute({ query: "登录越权" }); // 只命中"登录"，不该被阈值砍掉
    expect(r.ok).toBe(true);
    expect(r.content).toContain("f1");
  });
});

describe("get_fact_detail", () => {
  const facts = { getById: (id: string) => (id === "f1" ? fact({ id: "f1", title: "x", value: { k: "v" } }) : undefined) };
  it("returns full value for existing id", async () => {
    const t = makeGetFactDetailTool("c", facts);
    expect(t.executionMode).toBe("parallel");
    const r = await t.execute({ id: "f1" });
    expect(r.ok).toBe(true);
    expect(r.content).toContain("\"k\"");
  });
  it("missing id returns ok:false", async () => {
    const t = makeGetFactDetailTool("c", facts);
    const r = await t.execute({ id: "nope" });
    expect(r.ok).toBe(false);
    expect(r.content).toContain("未找到");
  });
});

describe("search_traffic", () => {
  const traffic = {
    listByCase: (): TrafficEntry[] => [
      { id: "t1", caseId: "c", url: "https://x/api/order", method: "GET", requestHeaders: {}, requestBody: null, responseStatus: 200, responseBody: null, createdAt: "t" },
      { id: "t2", caseId: "c", url: "https://x/static/logo.png", method: "GET", requestHeaders: {}, requestBody: null, responseStatus: 200, responseBody: null, createdAt: "t" },
    ],
  };
  it("matches by url", async () => {
    const t = makeSearchTrafficTool("c", traffic);
    expect(t.executionMode).toBe("parallel");
    const r = await t.execute({ query: "order" });
    expect(r.content).toContain("t1");
    expect(r.content).not.toContain("t2");
  });
  it("empty result returns ok:true with hint", async () => {
    const t = makeSearchTrafficTool("c", traffic);
    const r = await t.execute({ query: "bbbvvvjjjzzz" });
    expect(r.ok).toBe(true);
    expect(r.content).toContain("没有匹配");
  });
});

describe("recall_conversation", () => {
  const events = {
    listByCase: (): AgentEvent[] => [
      { id: "e1", caseId: "c", kind: "user", text: "测试登录越权", tool: null, createdAt: "t" },
      { id: "e2", caseId: "c", kind: "done", text: "已记录订单接口", tool: null, createdAt: "t" },
    ],
  };
  const summaries = { latest: () => ({ content: "早期发现了 3 个 API" }) };
  it("matches conversation events by query", async () => {
    const t = makeRecallConversationTool("c", events, summaries);
    expect(t.executionMode).toBe("parallel");
    const r = await t.execute({ query: "登录" });
    expect(r.ok).toBe(true);
    expect(r.content).toContain("测试登录越权");
  });
  it("includes summary when it matches", async () => {
    const t = makeRecallConversationTool("c", events, summaries);
    const r = await t.execute({ query: "API" });
    expect(r.content).toContain("早期发现");
  });
});

describe("search_facts query expansion", () => {
  it("finds IDOR facts when original query is 越权 and expander supplies IDOR", async () => {
    const facts = {
      listByCase: () => [
        fact({ id: "f1", type: "finding", title: "Possible IDOR on /api/user/:id", value: {} }),
      ],
    };
    const expander = {
      expand: async () => ["越权", "IDOR", "BOLA", "broken access control"],
    };
    const t = makeSearchFactsTool("c", facts, { expander });

    const r = await t.execute({ query: "越权" });

    expect(r.ok).toBe(true);
    expect(r.content).toContain("f1");
    expect(r.content).toContain("matched: IDOR");
  });

  it("falls back to original keyword behavior when no expander is provided", async () => {
    const facts = {
      listByCase: () => [
        fact({ id: "f1", type: "finding", title: "Possible IDOR on /api/user/:id", value: {} }),
      ],
    };
    const t = makeSearchFactsTool("c", facts);

    const r = await t.execute({ query: "越权" });

    expect(r.ok).toBe(true);
    expect(r.content).toContain("没有匹配");
  });
});

describe("recall_conversation query expansion", () => {
  it("finds earlier conversation text through expanded terms", async () => {
    const events = {
      listByCase: (): AgentEvent[] => [
        { id: "e1", caseId: "c", kind: "done", text: "Earlier note: possible BOLA in profile API", tool: null, createdAt: "t" },
      ],
    };
    const summaries = { latest: () => undefined };
    const expander = {
      expand: async () => ["越权", "BOLA"],
    };
    const t = makeRecallConversationTool("c", events, summaries, { expander });

    const r = await t.execute({ query: "越权" });

    expect(r.ok).toBe(true);
    expect(r.content).toContain("possible BOLA");
  });
});
