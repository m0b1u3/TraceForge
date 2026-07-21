import type { TimelineEntry } from "./schemas.js";

export interface ValidationConsoleEvent {
  label: "Validation lease" | "Priority shift" | "Evidence gate" | "Exploration window";
  text: string;
}

function fields(detail: string): Record<string, string> {
  return Object.fromEntries(detail.split(";").map((part) => {
    const index = part.indexOf("=");
    return index < 0 ? [part.trim(), ""] : [part.slice(0, index).trim(), part.slice(index + 1).trim()];
  }));
}

export function validationTimelineConsoleEvent(entry: Pick<TimelineEntry, "eventType" | "detail">): ValidationConsoleEvent | null {
  const value = fields(entry.detail);
  if (entry.eventType === "validation_task_claimed") {
    return { label: "Validation lease", text: `Claimed ${value.Task || "validation task"}${value.consensus ? ` · consensus ${value.consensus}` : ""}` };
  }
  if (entry.eventType === "validation_task_released" || entry.eventType === "validation_task_lease_released") {
    return { label: "Validation lease", text: `Released ${value.Task || "validation task"}${value.reason ? ` · ${value.reason}` : ""}` };
  }
  if (entry.eventType === "validation_task_completed") {
    return { label: "Evidence gate", text: `Completed ${value.Task || "validation task"} · required evidence satisfied` };
  }
  if (entry.eventType === "validation_task_completion_blocked") {
    return { label: "Evidence gate", text: `Blocked ${value.Task || "validation task"}${value.missing && value.missing !== "none" ? ` · missing ${value.missing}` : ""}` };
  }
  if (entry.eventType === "validation_priority_shifted") {
    return { label: "Priority shift", text: `Leader ${value.previous || "none"} → ${value.next || "none"}${value.reason ? ` · ${value.reason.replaceAll("_", " ")}` : ""}` };
  }
  if (entry.eventType === "validation_priority_deferred") {
    return { label: "Exploration window", text: `Validation ${value.validation || "pending"} deferred for exploration ${value.exploration || "work"}${value.boundaries ? ` · ${value.boundaries} tool boundaries` : ""}` };
  }
  return null;
}
