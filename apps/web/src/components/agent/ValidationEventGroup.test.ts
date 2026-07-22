// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { ValidationEventGroup } from "./ValidationEventGroup.js";

// @ts-expect-error enable React act in jsdom tests
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

describe("ValidationEventGroup", () => {
  it("keeps the latest transition visible and reveals earlier transitions on demand", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => root.render(createElement(ValidationEventGroup, { item: {
      type: "validation_group",
      key: "group-1",
      target: { kind: "task", id: "task_1" },
      events: [
        { type: "event", key: "event-1", kind: "validation", label: "Validation lease", text: "Claimed task_1", summary: "Claimed task_1", target: { kind: "task", id: "task_1" }, eventType: "validation_task_claimed" },
        { type: "event", key: "event-2", kind: "validation", label: "Evidence gate", text: "Blocked task_1", summary: "Blocked task_1", target: { kind: "task", id: "task_1" }, eventType: "validation_task_completion_blocked" },
      ],
    } })));

    expect(container.textContent).toContain("Blocked task_1");
    expect(container.textContent).not.toContain("Claimed task_1");
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Show earlier validation transitions"]')?.click());
    expect(container.textContent).toContain("Claimed task_1");
    expect(container.querySelector('button[aria-label="Hide earlier validation transitions"]')).not.toBeNull();

    await act(async () => root.unmount());
    container.remove();
  });
});
