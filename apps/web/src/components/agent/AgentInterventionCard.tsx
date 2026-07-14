import { ArrowClockwise, CircleNotch, Globe, ShieldWarning } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

export type InterventionAction =
  | "approval-approved"
  | "approval-rejected"
  | "scope-approved"
  | "scope-rejected"
  | null;

type SharedProps = {
  action: InterventionAction;
  error: string | null;
};

export function ApprovalInterventionCard({
  tool,
  input,
  action,
  error,
  onApprove,
  onReject,
}: SharedProps & {
  tool: string;
  input: string;
  onApprove: () => void;
  onReject: () => void;
}) {
  const busy = action?.startsWith("approval-") ?? false;
  return (
    <Alert variant="warning" className="agent-intervention">
      <ShieldWarning size={16} weight="duotone" />
      <AlertTitle>High-risk action</AlertTitle>
      <AlertDescription className="agent-intervention-body">
        <span>Review the exact tool call before allowing the run to continue.</span>
        <code className="agent-intervention-code">{tool}({input})</code>
        {error && <span className="agent-intervention-error" role="alert">{error} The request is still pending; retry or reject it.</span>}
        <div className="agent-intervention-actions">
          <Button size="sm" disabled={busy} onClick={onApprove}>
            {action === "approval-approved" && <CircleNotch size={14} className="tf-spin" />}
            {action === "approval-approved" ? "Approving..." : "Approve"}
          </Button>
          <Button type="button" variant="outline" size="sm" disabled={busy} onClick={onReject}>
            {action === "approval-rejected" && <CircleNotch size={14} className="tf-spin" />}
            {action === "approval-rejected" ? "Rejecting..." : "Reject"}
          </Button>
        </div>
      </AlertDescription>
    </Alert>
  );
}

export function ScopeInterventionCard({
  host,
  reason,
  action,
  error,
  onApprove,
  onReject,
}: SharedProps & {
  host: string;
  reason: string;
  onApprove: () => void;
  onReject: () => void;
}) {
  const busy = action?.startsWith("scope-") ?? false;
  return (
    <Alert variant="info" className="agent-intervention">
      <Globe size={16} />
      <AlertTitle>Scope expansion</AlertTitle>
      <AlertDescription className="agent-intervention-body">
        <span>The agent is requesting authorization for <code className="agent-intervention-host">{host}</code>.</span>
        <span className="agent-intervention-reason">{reason}</span>
        {error && <span className="agent-intervention-error" role="alert">{error} The host remains blocked.</span>}
        <div className="agent-intervention-actions">
          <Button size="sm" disabled={busy} onClick={onApprove}>
            {action === "scope-approved" && <CircleNotch size={14} className="tf-spin" />}
            {action === "scope-approved" ? "Authorizing..." : "Authorize host"}
          </Button>
          <Button type="button" variant="outline" size="sm" disabled={busy} onClick={onReject}>
            {action === "scope-rejected" && <CircleNotch size={14} className="tf-spin" />}
            {action === "scope-rejected" ? "Keeping blocked..." : "Keep blocked"}
          </Button>
        </div>
      </AlertDescription>
    </Alert>
  );
}

export function RunContinuationCard({
  goal,
  busy,
  onContinue,
}: {
  goal: string;
  busy: boolean;
  onContinue: () => void;
}) {
  return (
    <Alert variant="info" className="agent-intervention">
      <ArrowClockwise size={16} />
      <AlertTitle>Run budget reached</AlertTitle>
      <AlertDescription className="agent-intervention-body">
        <span>The current run paused before finishing its objective.</span>
        <code className="agent-intervention-code">{goal}</code>
        <div className="agent-intervention-actions">
          <Button size="sm" disabled={busy} onClick={onContinue}>
            {busy && <CircleNotch size={14} className="tf-spin" />}
            {busy ? "Continuing..." : "Continue run"}
          </Button>
        </div>
      </AlertDescription>
    </Alert>
  );
}
