import type { ReactNode } from "react";
import { CircleNotch, Tray, WarningCircle } from "@phosphor-icons/react";

export interface FeedbackStateProps {
  kind?: "empty" | "loading" | "error";
  title: string;
  description?: string;
  action?: ReactNode;
}

export function FeedbackState({ kind = "empty", title, description, action }: FeedbackStateProps) {
  const Icon = kind === "loading" ? CircleNotch : kind === "error" ? WarningCircle : Tray;
  return (
    <div className="tf-feedback-state" data-kind={kind} role={kind === "error" ? "alert" : "status"} aria-live={kind === "error" ? "assertive" : "polite"}>
      <Icon size={18} className={kind === "loading" ? "tf-spin" : undefined} weight={kind === "error" ? "fill" : "duotone"} aria-hidden="true" />
      <strong>{title}</strong>
      {description && <p>{description}</p>}
      {action && <div className="tf-feedback-action">{action}</div>}
    </div>
  );
}
