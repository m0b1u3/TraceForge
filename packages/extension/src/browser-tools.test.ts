import { describe, it, expect } from "vitest";
import { makeBrowserTools, type BrowserController } from "./browser-tools.js";
import type { ScopeRule } from "@traceforge/shared";

const rules: ScopeRule[] = [{ caseId: "c", allowHosts: ["t.com"], denyHosts: [] }];

function mockController(opts: { controller?: "llm" | "human" } = {}): BrowserController {
  return {
    controllerIs: (c) => (opts.controller ?? "llm") === c,
    navigate: async (url) => ({ ok: true, content: `navigated ${url}` }),
    click: async (sel) => ({ ok: true, content: `clicked ${sel}` }),
    fill: async () => ({ ok: true, content: `filled` }),
    extractLinks: async () => ["https://t.com/a", "https://t.com/b"],
    getPageText: async () => "page body text",
  };
}

function tool(tools: ReturnType<typeof makeBrowserTools>, name: string) {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`tool ${name} not found`);
  return t;
}

describe("makeBrowserTools (LLM holds control)", () => {
  it("navigate executes for an in-scope url", async () => {
    const tools = makeBrowserTools(mockController(), rules);
    const res = await tool(tools, "navigate").execute({ url: "https://t.com/x" });
    expect(res.ok).toBe(true);
    expect(res.content).toContain("navigated");
  });

  it("navigate refuses an out-of-scope url (scope guard)", async () => {
    const tools = makeBrowserTools(mockController(), rules);
    const res = await tool(tools, "navigate").execute({ url: "https://evil.com/x" });
    expect(res.ok).toBe(false);
    expect(res.content).toMatch(/scope/i);
  });

  it("click/fill/extract_links/get_page_text execute", async () => {
    const tools = makeBrowserTools(mockController(), rules);
    expect((await tool(tools, "click").execute({ selector: "#a" })).ok).toBe(true);
    expect((await tool(tools, "fill").execute({ selector: "#u", value: "admin" })).ok).toBe(true);
    expect((await tool(tools, "extract_links").execute({})).content).toContain("t.com/a");
    expect((await tool(tools, "get_page_text").execute({})).content).toContain("page body");
  });

  it("all browser tools are normal risk", () => {
    const tools = makeBrowserTools(mockController(), rules);
    expect(tools.every((t) => t.risk === "normal")).toBe(true);
    expect(tools.map((t) => t.name).sort()).toEqual(["click", "extract_links", "fill", "get_page_text", "navigate"]);
    expect(tool(tools, "extract_links").executionMode).toBe("parallel");
    expect(tool(tools, "get_page_text").executionMode).toBe("parallel");
    expect(tool(tools, "navigate").executionMode).not.toBe("parallel");
    expect(tool(tools, "click").executionMode).not.toBe("parallel");
    expect(tool(tools, "fill").executionMode).not.toBe("parallel");
  });
});

describe("makeBrowserTools (human took over)", () => {
  it("blocks every browser tool while human controls", async () => {
    const tools = makeBrowserTools(mockController({ controller: "human" }), rules);
    for (const name of ["navigate", "click", "fill", "extract_links", "get_page_text"]) {
      const input = name === "navigate" ? { url: "https://t.com/x" } : name === "fill" ? { selector: "#a", value: "v" } : name === "click" ? { selector: "#a" } : {};
      const res = await tool(tools, name).execute(input);
      expect(res.ok).toBe(false);
      expect(res.content).toMatch(/等待交回|人正在操作/);
    }
  });
});
