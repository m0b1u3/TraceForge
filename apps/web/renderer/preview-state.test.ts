import { describe, expect, it } from "vitest";
import { initialState, MAX_MESSAGES, MAX_MESSAGE_LENGTH, previewReducer, restorePreview, savePreview, shouldSendOnEnter, STORAGE_KEY } from "./preview-state";

describe("isolated desktop preview state", () => {
  it.each([
    [{ key: "Enter", shiftKey: false, isComposing: false, keyCode: 13 }, true],
    [{ key: "Enter", shiftKey: true, isComposing: false, keyCode: 13 }, false],
    [{ key: "Enter", shiftKey: false, isComposing: true, keyCode: 13 }, false],
    [{ key: "Enter", shiftKey: false, isComposing: false, keyCode: 229 }, false],
    [{ key: "a", shiftKey: false, isComposing: false, keyCode: 65 }, false],
  ] as const)("guards newline and IME composition", (event, expected) => {
    expect(shouldSendOnEnter(event)).toBe(expected);
  });
  it("starts with the approved A evidence layout and a pending demonstration", () => {
    expect(initialState()).toMatchObject({ panel: "evidence", timeline: true, decision: "pending", messages: [] });
  });
  it("preserves a draft and decision when switching panels", () => {
    const state = { ...initialState(), draft: "调查说明", decision: "declined" as const };
    expect(previewReducer(state, { type: "panel", panel: "tasks" })).toEqual({ ...state, panel: "tasks" });
    expect(previewReducer(state, { type: "panel", panel: null }).draft).toBe("调查说明");
  });
  it("records text without generating an agent answer or approving execution", () => {
    const state = previewReducer({ ...initialState(), draft: "  可以  " }, { type: "send" });
    expect(state.messages).toEqual(["可以"]);
    expect(state.decision).toBe("pending");
    expect(state.draft).toBe("");
  });
  it("rejects empty input and retains drafts when the bounded transcript is full", () => {
    const empty = { ...initialState(), draft: " \n " };
    expect(previewReducer(empty, { type: "send" })).toBe(empty);
    const full = { ...initialState(), messages: Array(MAX_MESSAGES).fill("已有说明"), draft: "保留草稿" };
    expect(previewReducer(full, { type: "send" })).toBe(full);
  });
  it("bounds drafts", () => {
    expect(previewReducer(initialState(), { type: "draft", value: "a".repeat(5000) }).draft).toHaveLength(MAX_MESSAGE_LENGTH);
  });
  it("only resolves a pending demonstration once", () => {
    const accepted = previewReducer(initialState(), { type: "decide", decision: "approved" });
    expect(previewReducer(accepted, { type: "decide", decision: "declined" })).toBe(accepted);
  });
  it("resets all demonstration state", () => {
    expect(previewReducer({ ...initialState(), draft: "draft", decision: "approved", panel: null }, { type: "reset" })).toEqual(initialState());
  });
  it.each([null, "evidence", "tasks"] as const)("restores a bounded session with panel %s", panel => {
    const state = { ...initialState(), panel, draft: "说明", messages: ["<script>plain text</script>"], timeline: false };
    let raw = "";
    expect(savePreview({ getItem: () => null, setItem: (key, value) => { expect(key).toBe(STORAGE_KEY); raw = value; } }, state)).toBeNull();
    expect(restorePreview({ getItem: () => raw, setItem: () => {} })).toEqual({ state, warning: null });
  });
  it.each(["bad json", "null", "{}", JSON.stringify({ ...initialState(), version: 2 }), JSON.stringify({ ...initialState(), messages: [null] }), JSON.stringify({ ...initialState(), decision: "verified" }), "x".repeat(200001)])("recovers safely from invalid storage", raw => {
    const restored = restorePreview({ getItem: () => raw, setItem: () => {} });
    expect(restored.state).toEqual(initialState());
    expect(restored.warning).toContain("无法恢复");
  });
  it("reports unavailable storage without stopping the preview", () => {
    const storage = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("quota"); } };
    expect(restorePreview(storage).warning).toBeTruthy();
    expect(savePreview(storage, initialState())).toContain("无法保存");
  });
});
