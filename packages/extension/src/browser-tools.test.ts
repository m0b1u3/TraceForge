import { describe, expect, it, vi } from "vitest";
import type { ScopeRule } from "@traceforge/shared";
import { makeBrowserTools, type BrowserController } from "./browser-tools.js";

function controller(owner: "llm" | "human"): BrowserController {
  return {
    controllerIs: (candidate) => candidate === owner,
    navigate: vi.fn(async () => ({ ok: true, content: "navigated" })),
    click: vi.fn(async () => ({ ok: true, content: "clicked" })),
    fill: vi.fn(async () => ({ ok: true, content: "filled" })),
    extractLinks: vi.fn(async () => ["https://target.test/next"]),
    getPageText: vi.fn(async () => "page text"),
  };
}

const scope: ScopeRule[] = [{ caseId: "case_1", allowHosts: ["target.test"], denyHosts: [] }];

describe("browser tool control ownership", () => {
  it("rejects every Agent browser tool while the operator owns the session", async () => {
    const session = controller("human");
    const tools = makeBrowserTools(session, scope);

    for (const tool of tools) {
      const input = tool.name === "navigate"
        ? { url: "https://target.test/" }
        : tool.name === "click"
          ? { selector: "button" }
          : tool.name === "fill"
            ? { selector: "input", value: "value" }
            : {};
      const result = await tool.execute(input);
      expect(result.ok).toBe(false);
      expect(result.content).toContain("人正在操作浏览器");
    }

    expect(session.navigate).not.toHaveBeenCalled();
    expect(session.click).not.toHaveBeenCalled();
    expect(session.fill).not.toHaveBeenCalled();
    expect(session.extractLinks).not.toHaveBeenCalled();
    expect(session.getPageText).not.toHaveBeenCalled();
  });

  it("allows Agent tools again after control returns to the Agent", async () => {
    const session = controller("llm");
    const click = makeBrowserTools(session, scope).find((tool) => tool.name === "click");

    await expect(click?.execute({ selector: "button" })).resolves.toMatchObject({ ok: true });
    expect(session.click).toHaveBeenCalledWith("button");
  });
});
