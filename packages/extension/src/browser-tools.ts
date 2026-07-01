import { checkScope } from "@traceforge/tool-resolver";
import type { ScopeRule } from "@traceforge/shared";
import type { ToolDescriptor } from "./tool.js";

/**
 * 结构接口：extension 不依赖 server，BrowserSession 以结构类型注入。
 * controllerIs 决定控制权锁是否放行；其余为受锁的浏览器操作。
 */
export interface BrowserController {
  controllerIs(c: "llm" | "human"): boolean;
  navigate(url: string): Promise<{ ok: boolean; content: string }>;
  click(selector: string): Promise<{ ok: boolean; content: string }>;
  fill(selector: string, value: string): Promise<{ ok: boolean; content: string }>;
  extractLinks(): Promise<string[]>;
  getPageText(): Promise<string>;
}

const HANDOFF = "人正在操作浏览器，请等待交回后再操作（你可以先分析已有流量或做别的）。";

/**
 * 浏览器工具集：全 normal 风险，受控制权锁约束（人接管时一律返回等待交回）。
 * navigate 额外过 Scope Guard（越界拒绝）。领域无关——只导航/点击/填表/读取。
 */
export function makeBrowserTools(session: BrowserController, scopeRules: ScopeRule[]): ToolDescriptor[] {
  const guarded = <T>(fn: () => Promise<{ ok: boolean; content: string } & T>) =>
    session.controllerIs("llm") ? fn() : Promise.resolve({ ok: false, content: HANDOFF });

  return [
    {
      name: "navigate",
      description: "在共享浏览器中导航到一个 URL（必须在授权范围内）。返回是否成功。",
      inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
      risk: "normal",
      source: "builtin",
      execute: (input) =>
        guarded(async () => {
          const { url } = input as { url: string };
          const verdict = checkScope(url, scopeRules);
          if (!verdict.allowed) return { ok: false, content: `out of scope: ${verdict.reason}` };
          return session.navigate(url);
        }),
    },
    {
      name: "click",
      description: "点击当前页面上匹配 CSS 选择器的元素。",
      inputSchema: { type: "object", properties: { selector: { type: "string" } }, required: ["selector"] },
      risk: "normal",
      source: "builtin",
      execute: (input) => guarded(() => session.click((input as { selector: string }).selector)),
    },
    {
      name: "fill",
      description: "向当前页面上匹配 CSS 选择器的输入框填入值。",
      inputSchema: {
        type: "object",
        properties: { selector: { type: "string" }, value: { type: "string" } },
        required: ["selector", "value"],
      },
      risk: "normal",
      source: "builtin",
      execute: (input) => {
        const { selector, value } = input as { selector: string; value: string };
        return guarded(() => session.fill(selector, value));
      },
    },
    {
      name: "extract_links",
      description: "提取当前页面的所有链接，用于发现可探索的路径。",
      inputSchema: { type: "object", properties: {}, required: [] },
      risk: "normal",
      source: "builtin",
      executionMode: "parallel",
      execute: () =>
        guarded(async () => {
          const links = await session.extractLinks();
          return { ok: true, content: links.join("\n") };
        }),
    },
    {
      name: "get_page_text",
      description: "读取当前页面的可见文本内容。",
      inputSchema: { type: "object", properties: {}, required: [] },
      risk: "normal",
      source: "builtin",
      executionMode: "parallel",
      execute: () =>
        guarded(async () => {
          const text = await session.getPageText();
          return { ok: true, content: text };
        }),
    },
  ];
}
