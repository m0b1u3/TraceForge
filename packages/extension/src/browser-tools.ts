import { TOOL_SECURITY, type ToolDescriptor } from "./tool.js";

export interface BrowserController {
  controllerIs(c: "llm" | "human"): boolean;
  navigate(url: string): Promise<{ ok: boolean; content: string }>;
  click(target: string): Promise<{ ok: boolean; content: string }>;
  fill(target: string, value: string): Promise<{ ok: boolean; content: string }>;
  selectOption(target: string, value: string): Promise<{ ok: boolean; content: string }>;
  press(key: string): Promise<{ ok: boolean; content: string }>;
  scroll(deltaY: number): Promise<{ ok: boolean; content: string }>;
  observePage(): Promise<string>;
  extractLinks(): Promise<string[]>;
  getPageText(): Promise<string>;
}

export const BROWSER_TOOL_NAMES = ["navigate", "observe_page", "click", "fill", "select_option", "press", "scroll", "extract_links", "get_page_text"] as const;
const HANDOFF = "A human currently controls the shared browser. Wait for control to return, or analyze existing traffic and evidence.";

export function makeBrowserTools(session: BrowserController): ToolDescriptor[] {
  const guarded = <T>(fn: () => Promise<{ ok: boolean; content: string } & T>) =>
    session.controllerIs("llm") ? fn() : Promise.resolve({ ok: false, content: HANDOFF });
  const target = { type: "string", description: "An element ref returned by observe_page (such as tf-3), or a CSS selector." };
  return [
    { name: "navigate", description: "Navigate the shared browser to an authorized URL. Scope also applies to redirects, clicks, and popups.", inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] }, security: TOOL_SECURITY.authorizedTargetRead, source: "builtin", execute: (input) => guarded(() => session.navigate((input as { url: string }).url)) },
    { name: "observe_page", description: "Inspect URL, title, visible text, and interactive elements with stable refs. Call before interacting.", inputSchema: { type: "object", properties: {}, required: [] }, security: TOOL_SECURITY.authorizedTargetRead, source: "builtin", executionMode: "parallel", execute: () => guarded(async () => ({ ok: true, content: await session.observePage() })) },
    { name: "click", description: "Click a visible element using an observe_page ref or CSS selector.", inputSchema: { type: "object", properties: { target }, required: ["target"] }, security: TOOL_SECURITY.authorizedTargetWrite, source: "builtin", execute: (input) => guarded(() => session.click((input as { target: string }).target)) },
    { name: "fill", description: "Replace an input value using an observe_page ref or CSS selector.", inputSchema: { type: "object", properties: { target, value: { type: "string" } }, required: ["target", "value"] }, security: TOOL_SECURITY.authorizedTargetWrite, source: "builtin", execute: (input) => { const { target, value } = input as { target: string; value: string }; return guarded(() => session.fill(target, value)); } },
    { name: "select_option", description: "Select a native option using an observe_page ref or CSS selector.", inputSchema: { type: "object", properties: { target, value: { type: "string" } }, required: ["target", "value"] }, security: TOOL_SECURITY.authorizedTargetWrite, source: "builtin", execute: (input) => { const { target, value } = input as { target: string; value: string }; return guarded(() => session.selectOption(target, value)); } },
    { name: "press", description: "Press a key or shortcut in the current page, such as Enter, Escape, Tab, or Control+Enter.", inputSchema: { type: "object", properties: { key: { type: "string" } }, required: ["key"] }, security: TOOL_SECURITY.authorizedTargetWrite, source: "builtin", execute: (input) => guarded(() => session.press((input as { key: string }).key)) },
    { name: "scroll", description: "Scroll vertically; positive values go down and negative values go up.", inputSchema: { type: "object", properties: { deltaY: { type: "number" } }, required: ["deltaY"] }, security: TOOL_SECURITY.authorizedTargetRead, source: "builtin", execute: (input) => guarded(() => session.scroll((input as { deltaY: number }).deltaY)) },
    { name: "extract_links", description: "Extract current-page links for investigation path discovery.", inputSchema: { type: "object", properties: {}, required: [] }, security: TOOL_SECURITY.authorizedTargetRead, source: "builtin", executionMode: "parallel", execute: () => guarded(async () => ({ ok: true, content: (await session.extractLinks()).join("\n") })) },
    { name: "get_page_text", description: "Read the visible text of the current page.", inputSchema: { type: "object", properties: {}, required: [] }, security: TOOL_SECURITY.authorizedTargetRead, source: "builtin", executionMode: "parallel", execute: () => guarded(async () => ({ ok: true, content: await session.getPageText() })) },
  ];
}
