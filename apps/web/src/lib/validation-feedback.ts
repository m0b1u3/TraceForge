export type ValidationFeedback = {
  message: string;
  tone: "info" | "success" | "error";
};

export function unavailableKnowledgeTarget(kind: "task" | "finding"): ValidationFeedback {
  return {
    message: `Related ${kind} is no longer available.`,
    tone: "info",
  };
}

export function validationRefreshFailed(reason: unknown): ValidationFeedback {
  const detail = reason instanceof Error && reason.message.trim() ? ` ${reason.message.trim()}` : "";
  return {
    message: `Validation state could not be refreshed.${detail}`,
    tone: "error",
  };
}

export const VALIDATION_STATE_RESTORED: ValidationFeedback = {
  message: "Validation state restored.",
  tone: "success",
};
