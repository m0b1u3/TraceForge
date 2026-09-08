/** Presentation-only state. No Host, Core, Scenario, network or credential dependency. */
export const STORAGE_KEY = "traceforge.action-score.preview.v1";
export const MAX_MESSAGE_LENGTH = 4000;
export const MAX_MESSAGES = 40;
export type Panel = "evidence" | "tasks" | null;
export type Decision = "pending" | "approved" | "declined";
export interface PreviewState {
  version: 1;
  panel: Panel;
  timeline: boolean;
  draft: string;
  messages: string[];
  decision: Decision;
}
export const initialState = (): PreviewState => ({
  version: 1, panel: "evidence", timeline: true, draft: "", messages: [], decision: "pending",
});
export type PreviewAction =
  | { type: "panel"; panel: Panel }
  | { type: "timeline" }
  | { type: "draft"; value: string }
  | { type: "send" }
  | { type: "decide"; decision: Exclude<Decision, "pending"> }
  | { type: "reset" };

export function previewReducer(state: PreviewState, action: PreviewAction): PreviewState {
  switch (action.type) {
    case "panel": return { ...state, panel: action.panel };
    case "timeline": return { ...state, timeline: !state.timeline };
    case "draft": return { ...state, draft: action.value.slice(0, MAX_MESSAGE_LENGTH) };
    case "send": {
      const text = state.draft.trim();
      if (!text || state.messages.length >= MAX_MESSAGES) return state;
      return { ...state, messages: [...state.messages, text], draft: "" };
    }
    case "decide": return state.decision === "pending" ? { ...state, decision: action.decision } : state;
    case "reset": return initialState();
  }
}

export interface PreviewStorage { getItem(key: string): string | null; setItem(key: string, value: string): void }
export function shouldSendOnEnter(event: { key: string; shiftKey: boolean; isComposing: boolean; keyCode: number }): boolean {
  return event.key === "Enter" && !event.shiftKey && !event.isComposing && event.keyCode !== 229;
}

export function restorePreview(storage: PreviewStorage): { state: PreviewState; warning: string | null } {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return { state: initialState(), warning: null };
    if (raw.length > 200000) throw new Error("oversized");
    const value = JSON.parse(raw) as Partial<PreviewState>;
    if (!value || value.version !== 1 || !(value.panel === null || value.panel === "evidence" || value.panel === "tasks") ||
        typeof value.timeline !== "boolean" || typeof value.draft !== "string" || value.draft.length > MAX_MESSAGE_LENGTH ||
        !["pending", "approved", "declined"].includes(value.decision ?? "") || !Array.isArray(value.messages) ||
        value.messages.length > MAX_MESSAGES || value.messages.some(m => typeof m !== "string" || !m.trim() || m.length > MAX_MESSAGE_LENGTH)) {
      throw new Error("invalid");
    }
    return { state: { version: 1, panel: value.panel!, timeline: value.timeline!, draft: value.draft!, messages: [...value.messages!], decision: value.decision! }, warning: null };
  } catch {
    return { state: initialState(), warning: "无法恢复预览记录，已载入初始示例。真实调查数据未受影响。" };
  }
}

export function savePreview(storage: PreviewStorage, state: PreviewState): string | null {
  try { storage.setItem(STORAGE_KEY, JSON.stringify(state)); return null; }
  catch { return "当前浏览器无法保存预览记录。你仍可操作，但刷新后可能丢失本页输入。"; }
}
