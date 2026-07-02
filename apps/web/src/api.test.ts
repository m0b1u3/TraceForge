import { describe, it, expect, vi, beforeEach } from "vitest";
import { acceptObserverWarning, convertObserverWarningToTask, createFact, createTask, dismissObserverWarning } from "./api.js";

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

describe("observer warning API helpers", () => {
  it("calls the accept warning endpoint", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ id: "warn_1", status: "accepted" }), { status: 200 }));

    const warning = await acceptObserverWarning("warn_1");

    expect(fetchMock).toHaveBeenCalledWith("/api/observer/warnings/warn_1/accept", { method: "POST" });
    expect(warning.status).toBe("accepted");
  });

  it("calls the dismiss warning endpoint", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ id: "warn_1", status: "dismissed" }), { status: 200 }));

    const warning = await dismissObserverWarning("warn_1");

    expect(fetchMock).toHaveBeenCalledWith("/api/observer/warnings/warn_1/dismiss", { method: "POST" });
    expect(warning.status).toBe("dismissed");
  });

  it("calls the convert warning endpoint", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      warning: { id: "warn_1", status: "converted_to_task" },
      task: { id: "task_1", title: "过早结束" },
    }), { status: 200 }));

    const result = await convertObserverWarningToTask("warn_1");

    expect(fetchMock).toHaveBeenCalledWith("/api/observer/warnings/warn_1/convert-task", { method: "POST" });
    expect(result.task.id).toBe("task_1");
    expect(result.warning.status).toBe("converted_to_task");
  });

  it("throws backend errors for createFact", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: "invalid fact" }), { status: 400 }));

    await expect(createFact("case_1", {
      type: "note",
      title: "bad",
      value: {},
      source: { type: "manual", ref: "test" },
    })).rejects.toThrow("创建 Fact失败：invalid fact");
  });

  it("throws backend errors for createTask", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ reason: "invalid task" }), { status: 400 }));

    await expect(createTask("case_1", {
      title: "bad",
      status: "open",
      reason: "",
      blockedBy: [],
      triggerWhen: [],
      relatedFacts: [],
      priority: "medium",
      updateCount: 0,
    })).rejects.toThrow("创建 Task失败：invalid task");
  });
});
